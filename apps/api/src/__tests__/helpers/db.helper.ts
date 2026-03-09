import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema';
import { vi } from 'vitest';

/**
 * Creates a mock DbService for unit tests.
 * Tests that need real DB queries should use TEST_DATABASE_URL with a real Postgres instance.
 */
export function createMockDbService() {
  return {
    db: {} as NodePgDatabase<typeof schema>,
    healthCheck: vi.fn().mockResolvedValue(true),
  };
}
