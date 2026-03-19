import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AccountsService } from '../accounts.service';
import { NotFoundException } from '@nestjs/common';

describe('AccountsService', () => {
  let service: AccountsService;
  let mockDb: ReturnType<typeof createChainDb>;
  let dbService: Record<string, unknown>;
  let crypto: Record<string, ReturnType<typeof vi.fn>>;
  let connectors: Record<string, ReturnType<typeof vi.fn>>;
  let typesense: Record<string, ReturnType<typeof vi.fn>>;

  // Chain-style mock that supports select/from/where/limit/delete/insert/update/set/values
  function createChainDb(results: unknown[] = []) {
    let callIdx = 0;
    const chain = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn(() => {
        const val = callIdx < results.length ? results[callIdx] : [];
        callIdx++;
        const p = Promise.resolve(val) as Promise<unknown> & { limit: ReturnType<typeof vi.fn> };
        p.limit = vi.fn(() => Promise.resolve(val));
        return p;
      }),
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      delete: vi.fn().mockReturnThis(),
    };
    return chain;
  }

  beforeEach(() => {
    mockDb = createChainDb();
    dbService = {
      db: mockDb,
      withCurrentUser: vi.fn((fn: (db: unknown) => unknown) => fn(mockDb)),
    };
    crypto = {
      encrypt: vi.fn((v: string | null) => (v ? `enc:${v}` : null)),
      decrypt: vi.fn((v: string | null) => (v ? v.replace('enc:', '') : null)),
      hmac: vi.fn((v: string) => `hmac:${v}`),
    };
    connectors = {
      get: vi.fn().mockReturnValue({
        revokeAuth: vi.fn().mockResolvedValue(undefined),
      }),
    };
    typesense = {
      remove: vi.fn().mockResolvedValue(undefined),
    };
    service = new AccountsService(dbService, crypto, connectors, typesense);
  });

  describe('create', () => {
    it('inserts account and returns it by id', async () => {
      const account = {
        id: 'test-id',
        connectorType: 'gmail',
        identifier: 'test@example.com',
        authContext: 'enc:{"token":"abc"}',
        status: 'connected',
      };
      // First call from create's insert (where not called in insert path)
      // Then getById is called which uses select().from().where()
      mockDb = createChainDb([
        [account], // getById after create
      ]);
      dbService.withCurrentUser = vi.fn((fn: (db: unknown) => unknown) => fn(mockDb));
      service = new AccountsService(dbService, crypto, connectors);

      const result = await service.create({
        connectorType: 'gmail',
        identifier: 'test@example.com',
        authContext: '{"token":"abc"}',
      });

      expect(result).toBeDefined();
      expect(crypto.encrypt).toHaveBeenCalled();
      expect(crypto.decrypt).toHaveBeenCalled();
    });
  });

  describe('getAll', () => {
    it('returns all accounts with decrypted authContext', async () => {
      const rows = [
        { id: '1', authContext: 'enc:ctx1' },
        { id: '2', authContext: null },
      ];
      // getAll doesn't use where() when no userId, it returns from select().from()
      mockDb.from = vi.fn(() => Promise.resolve(rows));
      dbService.withCurrentUser = vi.fn((fn: (db: unknown) => unknown) => fn(mockDb));
      service = new AccountsService(dbService, crypto, connectors);

      const result = await service.getAll();
      expect(result).toHaveLength(2);
      // decryptAccount decrypts both authContext and identifier per row
      expect(crypto.decrypt).toHaveBeenCalledTimes(4);
    });

    it('filters by userId when provided', async () => {
      const rows = [{ id: '1', authContext: 'enc:ctx1' }];
      mockDb.where = vi.fn(() => Promise.resolve(rows));
      dbService.withCurrentUser = vi.fn((fn: (db: unknown) => unknown) => fn(mockDb));
      service = new AccountsService(dbService, crypto, connectors);

      const result = await service.getAll('user-1');
      expect(result).toHaveLength(1);
    });
  });

  describe('getById', () => {
    it('returns decrypted account when found', async () => {
      const account = { id: 'a1', authContext: 'enc:ctx' };
      mockDb = createChainDb([[account]]);
      dbService.withCurrentUser = vi.fn((fn: (db: unknown) => unknown) => fn(mockDb));
      service = new AccountsService(dbService, crypto, connectors);

      const result = await service.getById('a1');
      expect(result.id).toBe('a1');
      expect(crypto.decrypt).toHaveBeenCalledWith('enc:ctx');
    });

    it('throws NotFoundException when not found', async () => {
      mockDb = createChainDb([[]]);
      dbService.withCurrentUser = vi.fn((fn: (db: unknown) => unknown) => fn(mockDb));
      service = new AccountsService(dbService, crypto, connectors);

      await expect(service.getById('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('update', () => {
    it('updates account and encrypts authContext', async () => {
      const existing = { id: 'a1', authContext: 'enc:old' };
      const updated = { id: 'a1', authContext: 'enc:new-ctx' };
      mockDb = createChainDb([
        [existing], // getById check
        undefined, // update().set().where()
        [updated], // getById return
      ]);
      dbService.withCurrentUser = vi.fn((fn: (db: unknown) => unknown) => fn(mockDb));
      service = new AccountsService(dbService, crypto, connectors);

      await service.update('a1', { authContext: 'new-ctx' });
      expect(crypto.encrypt).toHaveBeenCalledWith('new-ctx');
    });

    it('converts lastSyncAt string to Date', async () => {
      const existing = { id: 'a1', authContext: null };
      mockDb = createChainDb([[existing], undefined, [existing]]);
      dbService.withCurrentUser = vi.fn((fn: (db: unknown) => unknown) => fn(mockDb));
      service = new AccountsService(dbService, crypto, connectors);

      await service.update('a1', { lastSyncAt: '2025-01-01T00:00:00Z' });
      // Should have set lastSyncAt as Date
      const setCall = mockDb.set.mock.calls[0][0];
      expect(setCall.lastSyncAt).toBeInstanceOf(Date);
    });

    it('throws if account not found', async () => {
      mockDb = createChainDb([[]]);
      dbService.withCurrentUser = vi.fn((fn: (db: unknown) => unknown) => fn(mockDb));
      service = new AccountsService(dbService, crypto, connectors);

      await expect(service.update('nonexistent', { status: 'disconnected' })).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('findByTypeAndIdentifier', () => {
    it('returns decrypted account when found', async () => {
      const account = {
        id: 'a1',
        authContext: 'enc:ctx',
        connectorType: 'gmail',
        identifier: 'test@x.com',
      };
      mockDb = createChainDb([[account]]);
      dbService.withCurrentUser = vi.fn((fn: (db: unknown) => unknown) => fn(mockDb));
      service = new AccountsService(dbService, crypto, connectors);

      const result = await service.findByTypeAndIdentifier('gmail', 'test@x.com');
      expect(result!.id).toBe('a1');
    });

    it('returns null when not found', async () => {
      mockDb = createChainDb([[]]);
      dbService.withCurrentUser = vi.fn((fn: (db: unknown) => unknown) => fn(mockDb));
      service = new AccountsService(dbService, crypto, connectors);

      const result = await service.findByTypeAndIdentifier('gmail', 'none@x.com');
      expect(result).toBeNull();
    });

    it('adds userId condition when provided', async () => {
      mockDb = createChainDb([[]]);
      dbService.withCurrentUser = vi.fn((fn: (db: unknown) => unknown) => fn(mockDb));
      service = new AccountsService(dbService, crypto, connectors);

      await service.findByTypeAndIdentifier('gmail', 'test@x.com', 'user-1');
      expect(mockDb.where).toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('deletes account and related data', async () => {
      const account = { id: 'a1', connectorType: 'gmail', authContext: '{"token":"abc"}' };
      mockDb = createChainDb([
        [account], // getById
        [{ id: 'mem-1' }, { id: 'mem-2' }], // select memory ids
        undefined,
        undefined,
        undefined, // delete memoryContacts, memoryLinks x2
        undefined, // delete memories
        undefined, // delete rawEvents
        undefined, // delete jobs
        undefined, // delete accounts
      ]);
      dbService.withCurrentUser = vi.fn((fn: (db: unknown) => unknown) => fn(mockDb));
      service = new AccountsService(dbService, crypto, connectors);

      await service.remove('a1');
      expect(connectors.get).toHaveBeenCalledWith('gmail');
    });

    it('handles revokeAuth failure gracefully', async () => {
      const account = { id: 'a1', connectorType: 'gmail', authContext: '{"token":"abc"}' };
      connectors.get.mockReturnValue({
        revokeAuth: vi.fn().mockRejectedValue(new Error('revoke failed')),
      });
      mockDb = createChainDb([
        [account],
        [], // no memories
        undefined,
        undefined,
        undefined,
        undefined,
      ]);
      dbService.withCurrentUser = vi.fn((fn: (db: unknown) => unknown) => fn(mockDb));
      service = new AccountsService(dbService, crypto, connectors);

      // Should not throw
      await service.remove('a1');
    });

    it('throws if account not found', async () => {
      mockDb = createChainDb([[]]);
      dbService.withCurrentUser = vi.fn((fn: (db: unknown) => unknown) => fn(mockDb));
      service = new AccountsService(dbService, crypto, connectors);

      await expect(service.remove('nonexistent')).rejects.toThrow(NotFoundException);
    });

    it('handles empty memory list (no cascade deletes needed)', async () => {
      const account = { id: 'a1', connectorType: 'gmail', authContext: null };
      mockDb = createChainDb([
        [account],
        [], // no memories
        undefined,
        undefined,
        undefined,
        undefined,
      ]);
      dbService.withCurrentUser = vi.fn((fn: (db: unknown) => unknown) => fn(mockDb));
      service = new AccountsService(dbService, crypto, connectors);

      await service.remove('a1');
    });

    it('handles null connector gracefully', async () => {
      const account = { id: 'a1', connectorType: 'unknown', authContext: null };
      connectors.get.mockReturnValue(null);
      mockDb = createChainDb([[account], [], undefined, undefined, undefined, undefined]);
      dbService.withCurrentUser = vi.fn((fn: (db: unknown) => unknown) => fn(mockDb));
      service = new AccountsService(dbService, crypto, connectors);

      await service.remove('a1');
    });
  });
});
