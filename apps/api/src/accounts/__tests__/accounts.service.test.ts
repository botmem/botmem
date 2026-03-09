import { describe, it, expect, vi } from 'vitest';
import { AccountsService } from '../accounts.service';
import { DbService } from '../../db/db.service';

// NOTE: Integration tests for AccountsService require a real PostgreSQL database
// via TEST_DATABASE_URL. These tests are deferred until integration test infrastructure is set up.

describe('AccountsService', () => {
  it('creates an AccountsService instance', () => {
    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      delete: vi.fn().mockReturnThis(),
    } as any;
    const dbService = { db: mockDb } as unknown as DbService;
    const service = new AccountsService(dbService);
    expect(service).toBeDefined();
  });
});
