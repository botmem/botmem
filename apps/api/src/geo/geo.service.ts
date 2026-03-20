import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { join } from 'path';
import { createReadStream, existsSync, mkdirSync, createWriteStream } from 'fs';
import { readFile } from 'fs/promises';
import { createInterface } from 'readline';
import { pipeline } from 'stream/promises';
import countries from 'i18n-iso-countries';

countries.registerLocale(require('i18n-iso-countries/langs/en.json'));

export interface GeoResult {
  city: string | null;
  state: string | null;
  country: string | null;
  countryCode: string | null;
}

const EMPTY_RESULT: GeoResult = { city: null, state: null, country: null, countryCode: null };

const DATA_DIR = join(process.cwd(), 'data', 'geodata');
const CITIES_URL = 'https://download.geonames.org/export/dump/cities500.zip';
const ADMIN1_URL = 'https://download.geonames.org/export/dump/admin1CodesASCII.txt';
const ADMIN2_URL = 'https://download.geonames.org/export/dump/admin2Codes.txt';
const SEARCH_RADIUS_M = 25_000;
const BATCH_SIZE = 5_000;
const VERSION_KEY = 'geodata_version';
const CURRENT_VERSION = '2';

@Injectable()
export class GeoService implements OnModuleInit {
  private readonly logger = new Logger(GeoService.name);
  private readonly cache = new Map<string, GeoResult>();
  private readonly maxCacheSize = 10_000;
  private ready = false;

  constructor(private db: DbService) {}

  async onModuleInit() {
    try {
      await this.init();
    } catch (err) {
      this.logger.warn(
        `GeoService init failed — geocoding will return empty results: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async init() {
    const pool = this.db.connectionPool;
    const client = await pool.connect();
    try {
      // Check if already imported
      const { rows } = await client.query(`SELECT value FROM system_metadata WHERE key = $1`, [
        VERSION_KEY,
      ]);
      if (rows[0]?.value === CURRENT_VERSION) {
        const { rows: countRows } = await client.query(
          `SELECT count(*)::int AS c FROM geodata_places`,
        );
        if (countRows[0]?.c > 0) {
          this.logger.log(`GeoNames data already imported (${countRows[0].c} cities)`);
          this.ready = true;
          return;
        }
      }
    } catch {
      // system_metadata table may not exist yet — create it
      await client.query(`
        CREATE TABLE IF NOT EXISTS system_metadata (
          key VARCHAR(100) PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);
    } finally {
      client.release();
    }

    // Ensure extensions + table exist
    const migrationPath = join(__dirname, '..', 'db', 'migrations', '0016_add_geodata.sql');
    if (existsSync(migrationPath)) {
      const migClient = await pool.connect();
      try {
        const sql = await readFile(migrationPath, 'utf-8');
        await migClient.query(sql);
      } finally {
        migClient.release();
      }
    }

    await this.downloadAndImport();
    this.ready = true;
  }

  async reverseGeocode(lat: number, lon: number): Promise<GeoResult> {
    if (!this.ready) return EMPTY_RESULT;

    // LRU cache keyed by truncated coords
    const cacheKey = `${lat.toFixed(2)},${lon.toFixed(2)}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const pool = this.db.connectionPool;
    const client = await pool.connect();
    try {
      const { rows } = await client.query(
        `SELECT name, admin1_name, country_code
         FROM geodata_places
         WHERE earth_box(ll_to_earth($1, $2), $3) @> ll_to_earth(latitude, longitude)
         ORDER BY earth_distance(ll_to_earth($1, $2), ll_to_earth(latitude, longitude))
         LIMIT 1`,
        [lat, lon, SEARCH_RADIUS_M],
      );

      if (!rows.length) {
        this.setCached(cacheKey, EMPTY_RESULT);
        return EMPTY_RESULT;
      }

      const row = rows[0];
      const result: GeoResult = {
        city: row.name,
        state: row.admin1_name || null,
        country: countries.getName(row.country_code, 'en') || row.country_code,
        countryCode: row.country_code,
      };

      this.setCached(cacheKey, result);
      return result;
    } finally {
      client.release();
    }
  }

  private setCached(key: string, value: GeoResult) {
    // Simple eviction: clear half when full
    if (this.cache.size >= this.maxCacheSize) {
      const keys = [...this.cache.keys()];
      for (let i = 0; i < keys.length / 2; i++) {
        this.cache.delete(keys[i]);
      }
    }
    this.cache.set(key, value);
  }

  private async downloadAndImport() {
    mkdirSync(DATA_DIR, { recursive: true });

    // Download files
    const citiesZip = join(DATA_DIR, 'cities500.zip');
    const citiesTxt = join(DATA_DIR, 'cities500.txt');
    const admin1File = join(DATA_DIR, 'admin1CodesASCII.txt');
    const admin2File = join(DATA_DIR, 'admin2Codes.txt');

    if (!existsSync(citiesTxt)) {
      this.logger.log('Downloading GeoNames cities500.zip...');
      await this.downloadFile(CITIES_URL, citiesZip);
      this.logger.log('Extracting cities500.zip...');
      await this.extractZip(citiesZip, citiesTxt, 'cities500.txt');
    }

    if (!existsSync(admin1File)) {
      this.logger.log('Downloading admin1 codes...');
      await this.downloadFile(ADMIN1_URL, admin1File);
    }

    if (!existsSync(admin2File)) {
      this.logger.log('Downloading admin2 codes...');
      await this.downloadFile(ADMIN2_URL, admin2File);
    }

    // Parse admin codes into lookup maps
    const admin1Map = await this.parseAdminCodes(admin1File);
    const admin2Map = await this.parseAdminCodes(admin2File);

    // Import cities into PostgreSQL
    await this.importCities(citiesTxt, admin1Map, admin2Map);
  }

  private async downloadFile(url: string, dest: string): Promise<void> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed: ${res.status} ${url}`);
    const ws = createWriteStream(dest);
    // @ts-expect-error Node fetch body is a ReadableStream
    await pipeline(res.body, ws);
  }

  private async extractZip(zipPath: string, destPath: string, entryName: string): Promise<void> {
    // cities500.zip contains a single file — use streaming unzip
    const { Open } = await import('unzipper');
    const dir = await Open.file(zipPath);
    const entry = dir.files.find((f) => f.path === entryName);
    if (!entry) throw new Error(`${entryName} not found in zip`);
    const ws = createWriteStream(destPath);
    await pipeline(entry.stream(), ws);
  }

  private async parseAdminCodes(filePath: string): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const rl = createInterface({
      input: createReadStream(filePath, 'utf-8'),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      const parts = line.split('\t');
      if (parts.length >= 2) {
        // Format: code<tab>name<tab>nameAscii<tab>geonameId
        map.set(parts[0], parts[1]);
      }
    }
    return map;
  }

  private async importCities(
    citiesFile: string,
    admin1Map: Map<string, string>,
    admin2Map: Map<string, string>,
  ) {
    this.logger.log('Importing GeoNames cities into PostgreSQL...');

    const pool = this.db.connectionPool;

    // Clear existing data
    const clearClient = await pool.connect();
    try {
      await clearClient.query('TRUNCATE geodata_places');
    } finally {
      clearClient.release();
    }

    const rl = createInterface({
      input: createReadStream(citiesFile, 'utf-8'),
      crlfDelay: Infinity,
    });

    let batch: Array<
      [number, string, number, number, string, string, string, string, string, string, string]
    > = [];
    let total = 0;

    for await (const line of rl) {
      const cols = line.split('\t');
      if (cols.length < 19) continue;

      const id = parseInt(cols[0], 10);
      const name = cols[1];
      const lat = parseFloat(cols[4]);
      const lon = parseFloat(cols[5]);
      const countryCode = cols[8];
      const admin1Code = cols[10] || '';
      const admin2Code = cols[11] || '';
      const alternateNames = cols[3] || '';
      const modDate = cols[18] || '2024-01-01';

      const admin1Key = `${countryCode}.${admin1Code}`;
      const admin2Key = `${countryCode}.${admin1Code}.${admin2Code}`;
      const admin1Name = admin1Map.get(admin1Key) || '';
      const admin2Name = admin2Map.get(admin2Key) || '';

      batch.push([
        id,
        name,
        lat,
        lon,
        countryCode,
        admin1Code,
        admin1Name,
        admin2Code,
        admin2Name,
        alternateNames,
        modDate,
      ]);

      if (batch.length >= BATCH_SIZE) {
        await this.insertBatch(pool, batch);
        total += batch.length;
        batch = [];
        if (total % 50_000 === 0) {
          this.logger.log(`  Imported ${total} cities...`);
        }
      }
    }

    if (batch.length > 0) {
      await this.insertBatch(pool, batch);
      total += batch.length;
    }

    // Mark version
    const vClient = await pool.connect();
    try {
      await vClient.query(
        `INSERT INTO system_metadata (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = $2`,
        [VERSION_KEY, CURRENT_VERSION],
      );
    } finally {
      vClient.release();
    }

    this.logger.log(`GeoNames import complete: ${total} cities`);
  }

  private async insertBatch(
    pool: import('pg').Pool,
    batch: Array<
      [number, string, number, number, string, string, string, string, string, string, string]
    >,
  ) {
    const client = await pool.connect();
    try {
      const values: unknown[] = [];
      const placeholders: string[] = [];
      let paramIdx = 1;

      for (const row of batch) {
        const ph: string[] = [];
        for (const val of row) {
          ph.push(`$${paramIdx++}`);
          values.push(val);
        }
        placeholders.push(`(${ph.join(',')})`);
      }

      await client.query(
        `INSERT INTO geodata_places
           (id, name, latitude, longitude, country_code, admin1_code, admin1_name, admin2_code, admin2_name, alternate_names, modification_date)
         VALUES ${placeholders.join(',')}
         ON CONFLICT (id) DO NOTHING`,
        values,
      );
    } finally {
      client.release();
    }
  }
}
