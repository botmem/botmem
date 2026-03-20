import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';

/**
 * E2E test for GeoService using real PostgreSQL with cube + earthdistance extensions.
 * Requires a running PostgreSQL instance (from docker-compose).
 */
describe('GeoService E2E', () => {
  let pool: Pool;

  beforeAll(async () => {
    const databaseUrl =
      process.env.DATABASE_URL || 'postgresql://botmem:botmem@localhost:5432/botmem';
    pool = new Pool({ connectionString: databaseUrl });

    // Ensure extensions exist
    await pool.query('CREATE EXTENSION IF NOT EXISTS cube');
    await pool.query('CREATE EXTENSION IF NOT EXISTS earthdistance');

    // Create test table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS geodata_places (
        id INTEGER PRIMARY KEY,
        name VARCHAR(200) NOT NULL,
        latitude DOUBLE PRECISION NOT NULL,
        longitude DOUBLE PRECISION NOT NULL,
        country_code CHAR(2) NOT NULL,
        admin1_code VARCHAR(20),
        admin1_name VARCHAR(200),
        admin2_code VARCHAR(80),
        admin2_name VARCHAR(200),
        alternate_names TEXT,
        modification_date DATE NOT NULL
      )
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_geodata_earthcoord
        ON geodata_places USING gist (ll_to_earth(latitude, longitude))
    `);

    // Insert test cities
    await pool.query(`
      INSERT INTO geodata_places (id, name, latitude, longitude, country_code, admin1_code, admin1_name, modification_date)
      VALUES
        (292223, 'Dubai', 25.2048, 55.2708, 'AE', '03', 'Dubai', '2024-01-01'),
        (5128581, 'New York City', 40.7128, -74.0060, 'US', 'NY', 'New York', '2024-01-01'),
        (1850147, 'Tokyo', 35.6762, 139.6503, 'JP', '40', 'Tokyo', '2024-01-01'),
        (2988507, 'Paris', 48.8566, 2.3522, 'FR', '11', 'Ile-de-France', '2024-01-01'),
        (3435910, 'Buenos Aires', -34.6037, -58.3816, 'AR', '07', 'Buenos Aires', '2024-01-01')
      ON CONFLICT (id) DO NOTHING
    `);
  });

  afterAll(async () => {
    // Clean up test data but leave table for other tests
    await pool.query(
      'DELETE FROM geodata_places WHERE id IN (292223, 5128581, 1850147, 2988507, 3435910)',
    );
    await pool.end();
  });

  it('finds nearest city for coordinates near Dubai', async () => {
    const { rows } = await pool.query(
      `SELECT name, admin1_name, country_code
       FROM geodata_places
       WHERE earth_box(ll_to_earth($1, $2), 25000) @> ll_to_earth(latitude, longitude)
       ORDER BY earth_distance(ll_to_earth($1, $2), ll_to_earth(latitude, longitude))
       LIMIT 1`,
      [25.197, 55.274],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Dubai');
    expect(rows[0].country_code).toBe('AE');
  });

  it('finds nearest city for coordinates near New York', async () => {
    const { rows } = await pool.query(
      `SELECT name, admin1_name, country_code
       FROM geodata_places
       WHERE earth_box(ll_to_earth($1, $2), 25000) @> ll_to_earth(latitude, longitude)
       ORDER BY earth_distance(ll_to_earth($1, $2), ll_to_earth(latitude, longitude))
       LIMIT 1`,
      [40.72, -74.01],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('New York City');
  });

  it('returns no results for coordinates in the middle of the ocean', async () => {
    // Mid-Atlantic, far from any city
    const { rows } = await pool.query(
      `SELECT name
       FROM geodata_places
       WHERE earth_box(ll_to_earth($1, $2), 25000) @> ll_to_earth(latitude, longitude)
       ORDER BY earth_distance(ll_to_earth($1, $2), ll_to_earth(latitude, longitude))
       LIMIT 1`,
      [0, -30],
    );
    expect(rows).toHaveLength(0);
  });

  it('picks nearest city when between two cities', async () => {
    // Coordinates slightly closer to Paris than any other test city
    const { rows } = await pool.query(
      `SELECT name
       FROM geodata_places
       WHERE earth_box(ll_to_earth($1, $2), 25000) @> ll_to_earth(latitude, longitude)
       ORDER BY earth_distance(ll_to_earth($1, $2), ll_to_earth(latitude, longitude))
       LIMIT 1`,
      [48.85, 2.35],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Paris');
  });

  it('handles coordinates exactly on a city', async () => {
    const { rows } = await pool.query(
      `SELECT name
       FROM geodata_places
       WHERE earth_box(ll_to_earth($1, $2), 25000) @> ll_to_earth(latitude, longitude)
       ORDER BY earth_distance(ll_to_earth($1, $2), ll_to_earth(latitude, longitude))
       LIMIT 1`,
      [35.6762, 139.6503],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Tokyo');
  });

  it('handles southern hemisphere coordinates', async () => {
    const { rows } = await pool.query(
      `SELECT name, country_code
       FROM geodata_places
       WHERE earth_box(ll_to_earth($1, $2), 25000) @> ll_to_earth(latitude, longitude)
       ORDER BY earth_distance(ll_to_earth($1, $2), ll_to_earth(latitude, longitude))
       LIMIT 1`,
      [-34.6, -58.38],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Buenos Aires');
    expect(rows[0].country_code).toBe('AR');
  });
});
