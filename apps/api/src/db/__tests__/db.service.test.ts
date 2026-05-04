import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockDbService } from '../../__tests__/helpers/db.helper';
import { DbService } from '../db.service';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

vi.mock('drizzle-orm/node-postgres/migrator', () => ({
  migrate: vi.fn(),
}));

describe('DbService (mock)', () => {
  beforeEach(() => {
    vi.mocked(migrate).mockReset();
  });

  it('creates a mock DbService with db property', () => {
    const dbService = createMockDbService();
    expect(dbService.db).toBeDefined();
  });

  it('healthCheck resolves to true', async () => {
    const dbService = createMockDbService();
    const result = await dbService.healthCheck();
    expect(result).toBe(true);
  });

  it('serializes migrations with a PostgreSQL advisory lock', async () => {
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    };
    const service = new DbService({ databaseUrl: 'postgres://test' } as never);
    (service as unknown as { pool: { connect: typeof vi.fn }; db: unknown }).pool = {
      connect: vi.fn().mockResolvedValue(client),
    };
    (service as unknown as { db: unknown }).db = {};

    await (service as unknown as { runMigrations: () => Promise<void> }).runMigrations();

    expect(client.query).toHaveBeenNthCalledWith(
      1,
      'SELECT pg_advisory_lock($1, $2)',
      [7342, 4200],
    );
    expect(migrate).toHaveBeenCalledOnce();
    expect(client.query).toHaveBeenLastCalledWith(
      'SELECT pg_advisory_unlock($1, $2)',
      [7342, 4200],
    );
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('releases the advisory lock when migrations fail', async () => {
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    };
    vi.mocked(migrate).mockRejectedValueOnce(new Error('migration failed'));
    const service = new DbService({ databaseUrl: 'postgres://test' } as never);
    (service as unknown as { pool: { connect: typeof vi.fn }; db: unknown }).pool = {
      connect: vi.fn().mockResolvedValue(client),
    };
    (service as unknown as { db: unknown }).db = {};

    await expect(
      (service as unknown as { runMigrations: () => Promise<void> }).runMigrations(),
    ).rejects.toThrow('migration failed');

    expect(client.query).toHaveBeenLastCalledWith(
      'SELECT pg_advisory_unlock($1, $2)',
      [7342, 4200],
    );
    expect(client.release).toHaveBeenCalledOnce();
  });
});
