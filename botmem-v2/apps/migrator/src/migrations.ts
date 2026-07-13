import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const FILE_PATTERN = /^V([1-9][0-9]*)__([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/u;
const MAX_MIGRATION_BYTES = 4 * 1024 * 1024;

export interface Migration {
  readonly version: number;
  readonly script: string;
  readonly description: string;
  readonly checksumSha256: string;
  readonly flywayChecksum: number;
  readonly sql: string;
}

export async function discoverMigrations(directory: string): Promise<readonly Migration[]> {
  const directoryStat = await lstat(directory).catch(() => null);
  if (!directoryStat?.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new MigrationInputError('migration_directory_invalid');
  }
  const entries = await readdir(directory, { withFileTypes: true });
  const candidates = entries.filter((entry) => entry.name.startsWith('V'));
  if (candidates.length === 0) throw new MigrationInputError('migration_set_empty');

  const migrations: Migration[] = [];
  for (const entry of candidates) {
    const match = FILE_PATTERN.exec(entry.name);
    if (!match || !entry.isFile() || entry.isSymbolicLink()) {
      throw new MigrationInputError('migration_name_invalid', entry.name);
    }
    const raw = await readFile(join(directory, entry.name));
    if (raw.byteLength === 0 || raw.byteLength > MAX_MIGRATION_BYTES) {
      throw new MigrationInputError('migration_size_invalid', entry.name);
    }
    let sql: string;
    try {
      sql = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } catch {
      throw new MigrationInputError('migration_encoding_invalid', entry.name);
    }
    const version = Number(match[1]);
    if (!Number.isSafeInteger(version)) {
      throw new MigrationInputError('migration_version_invalid', entry.name);
    }
    migrations.push(
      Object.freeze({
        version,
        script: entry.name,
        description: match[2]!.replaceAll('_', ' '),
        checksumSha256: createHash('sha256').update(raw).digest('hex'),
        flywayChecksum: calculateFlywayChecksum(sql),
        sql,
      }),
    );
  }

  migrations.sort((left, right) => left.version - right.version);
  migrations.forEach((migration, index) => {
    const expected = index + 1;
    if (migration.version !== expected) {
      throw new MigrationInputError('migration_order_invalid', migration.script);
    }
  });
  return Object.freeze(migrations);
}

/** Flyway 11 reads UTF-8 lines, removes the first BOM, and CRC32s without newlines. */
export function calculateFlywayChecksum(sql: string): number {
  const normalized = sql
    .replace(/^\uFEFF/u, '')
    .split(/\r\n|\n|\r/u)
    .join('');
  let crc = 0xffff_ffff;
  for (const byte of Buffer.from(normalized, 'utf8')) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffff_ffff) | 0;
}

const CRC32_TABLE = Object.freeze(
  Array.from({ length: 256 }, (_unused, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb8_8320 ^ (value >>> 1) : value >>> 1;
    }
    return value >>> 0;
  }),
);

export class MigrationInputError extends Error {
  override readonly name = 'MigrationInputError';
  constructor(
    readonly code: string,
    readonly script?: string,
  ) {
    super(code);
  }
}
