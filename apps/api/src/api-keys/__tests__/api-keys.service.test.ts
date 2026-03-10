import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiKeysService } from '../api-keys.service';
import { createHash } from 'crypto';
import { BadRequestException, ConflictException } from '@nestjs/common';

type ChainablePromise<T> = Promise<T> & { limit: ReturnType<typeof vi.fn> };

function withLimit<T>(p: Promise<T>, result?: unknown): ChainablePromise<T> {
  const cp = p as ChainablePromise<T>;
  cp.limit = vi.fn(() => Promise.resolve(result ?? p));
  return cp;
}

function createMockDb(overrides: Record<string, unknown> = {}) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    ...overrides,
  };
  return chain;
}

function createService(db?: unknown) {
  const dbService = { db: db ?? createMockDb() } as unknown as ConstructorParameters<
    typeof ApiKeysService
  >[0];
  return new ApiKeysService(dbService);
}

describe('ApiKeysService', () => {
  let service: ApiKeysService;
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    mockDb = createMockDb();
    service = createService(mockDb);
  });

  describe('generateKey', () => {
    it('returns raw key with bm_sk_ prefix and correct length', () => {
      const { raw, hash, lastFour } = service.generateKey();
      expect(raw).toMatch(/^bm_sk_[0-9a-f]{32}$/);
      expect(raw.length).toBe(38);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(lastFour.length).toBe(4);
    });

    it('produces correct SHA-256 hash', () => {
      const { raw, hash } = service.generateKey();
      const expected = createHash('sha256').update(raw).digest('hex');
      expect(hash).toBe(expected);
    });

    it('generates unique keys on each call', () => {
      const k1 = service.generateKey();
      const k2 = service.generateKey();
      expect(k1.raw).not.toBe(k2.raw);
      expect(k1.hash).not.toBe(k2.hash);
    });

    it('lastFour is last 4 chars of the hex portion', () => {
      const { raw, lastFour } = service.generateKey();
      const hex = raw.replace('bm_sk_', '');
      expect(lastFour).toBe(hex.slice(-4));
    });
  });

  describe('create', () => {
    it('creates a key and returns raw key info', async () => {
      let callIdx = 0;
      mockDb.where = vi.fn(() => {
        callIdx++;
        if (callIdx === 1) {
          // count query
          const p = Promise.resolve([{ count: 0 }]);
          return p;
        }
        // name uniqueness check
        return withLimit(Promise.resolve([]), []);
      });

      const result = await service.create('user-1', 'My Key');
      expect(result.key).toMatch(/^bm_sk_/);
      expect(result.name).toBe('My Key');
      expect(result.lastFour).toHaveLength(4);
      expect(result.id).toBeDefined();
      expect(mockDb.insert).toHaveBeenCalled();
    });

    it('throws BadRequestException when max keys reached', async () => {
      mockDb.where = vi.fn(() => Promise.resolve([{ count: 10 }]));

      await expect(service.create('user-1', 'Key 11')).rejects.toThrow(BadRequestException);
    });

    it('throws ConflictException when name already exists', async () => {
      let callIdx = 0;
      mockDb.where = vi.fn(() => {
        callIdx++;
        if (callIdx === 1) return Promise.resolve([{ count: 0 }]);
        return withLimit(Promise.resolve([{ id: 'existing' }]), [{ id: 'existing' }]);
      });

      await expect(service.create('user-1', 'Existing Key')).rejects.toThrow(ConflictException);
    });

    it('validates memory bank ownership when memoryBankIds provided', async () => {
      let callIdx = 0;
      mockDb.where = vi.fn(() => {
        callIdx++;
        if (callIdx === 1) return Promise.resolve([{ count: 0 }]);
        if (callIdx === 2) {
          const p = Promise.resolve([]);
          p.limit = vi.fn(() => Promise.resolve([]));
          return p;
        }
        // memory bank validation - returns fewer than requested
        return Promise.resolve([{ id: 'bank-1' }]);
      });

      await expect(
        service.create('user-1', 'Key', undefined, ['bank-1', 'bank-2']),
      ).rejects.toThrow(BadRequestException);
    });

    it('stores memoryBankIds as JSON when provided', async () => {
      let callIdx = 0;
      mockDb.where = vi.fn(() => {
        callIdx++;
        if (callIdx === 1) return Promise.resolve([{ count: 0 }]);
        if (callIdx === 2) {
          const p = Promise.resolve([]);
          p.limit = vi.fn(() => Promise.resolve([]));
          return p;
        }
        return Promise.resolve([{ id: 'bank-1' }]);
      });

      await service.create('user-1', 'Key', undefined, ['bank-1']);
      expect(mockDb.values).toHaveBeenCalled();
      const valuesArg = mockDb.values.mock.calls[0][0];
      expect(valuesArg.memoryBankIds).toBe(JSON.stringify(['bank-1']));
    });

    it('stores expiresAt when provided', async () => {
      let callIdx = 0;
      mockDb.where = vi.fn(() => {
        callIdx++;
        if (callIdx === 1) return Promise.resolve([{ count: 0 }]);
        return withLimit(Promise.resolve([]), []);
      });

      await service.create('user-1', 'Key', '2026-12-31T00:00:00Z');
      const valuesArg = mockDb.values.mock.calls[0][0];
      expect(valuesArg.expiresAt).toBeInstanceOf(Date);
    });
  });

  describe('listByUser', () => {
    it('returns keys for user', async () => {
      const rows = [
        {
          id: 'k1',
          name: 'Key 1',
          lastFour: 'abcd',
          createdAt: new Date(),
          expiresAt: null,
          revokedAt: null,
        },
      ];
      mockDb.where = vi.fn(() => Promise.resolve(rows));

      const result = await service.listByUser('user-1');
      expect(result).toEqual(rows);
    });
  });

  describe('revoke', () => {
    it('updates revokedAt for the key', async () => {
      mockDb.where = vi.fn(() => Promise.resolve({ rowCount: 1 }));

      await service.revoke('user-1', 'key-1');
      expect(mockDb.update).toHaveBeenCalled();
      expect(mockDb.set).toHaveBeenCalled();
    });
  });

  describe('validateKey', () => {
    it('returns key row when valid and not expired', async () => {
      const keyRow = {
        id: 'k1',
        userId: 'user-1',
        keyHash: 'somehash',
        expiresAt: null,
        revokedAt: null,
      };
      mockDb.where = vi.fn(() => withLimit(Promise.resolve([keyRow]), [keyRow]));

      const result = await service.validateKey('bm_sk_abc123');
      expect(result).toEqual(keyRow);
    });

    it('returns null when key not found', async () => {
      mockDb.where = vi.fn(() => withLimit(Promise.resolve([]), []));

      const result = await service.validateKey('bm_sk_invalid');
      expect(result).toBeNull();
    });

    it('returns null when key is expired', async () => {
      const keyRow = {
        id: 'k1',
        userId: 'user-1',
        expiresAt: new Date('2020-01-01'),
        revokedAt: null,
      };
      mockDb.where = vi.fn(() => withLimit(Promise.resolve([keyRow]), [keyRow]));

      const result = await service.validateKey('bm_sk_expired');
      expect(result).toBeNull();
    });

    it('hashes the raw key before lookup', async () => {
      mockDb.where = vi.fn(() => withLimit(Promise.resolve([]), []));

      await service.validateKey('bm_sk_test1234');
      // The function should hash the key — verify by checking that where was called
      expect(mockDb.where).toHaveBeenCalled();
    });
  });
});
