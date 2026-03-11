import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MemoryBanksService } from '../memory-banks.service';
import type { DbService } from '../../db/db.service';

describe('MemoryBanksService', () => {
  let service: MemoryBanksService;
  let mockDb: Record<string, ReturnType<typeof vi.fn>>;
  let qdrantService: { remove: ReturnType<typeof vi.fn> };

  const fakeBank = {
    id: 'bank-1',
    userId: 'user-1',
    name: 'Work',
    isDefault: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      delete: vi.fn().mockReturnThis(),
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    };

    qdrantService = {
      remove: vi.fn().mockResolvedValue(undefined),
    };

    service = new MemoryBanksService(
      { db: mockDb } as unknown as DbService,
      qdrantService as unknown as import('../../memory/qdrant.service').QdrantService,
    );
  });

  describe('create', () => {
    it('creates a new memory bank', async () => {
      // Check existing: none found
      mockDb.where.mockResolvedValueOnce([]);
      // getById after creation
      mockDb.where.mockResolvedValueOnce([fakeBank]);

      const result = await service.create('user-1', 'Work');
      expect(result).toEqual(fakeBank);
      expect(mockDb.insert).toHaveBeenCalled();
    });

    it('throws if name already exists', async () => {
      mockDb.where.mockResolvedValueOnce([fakeBank]); // existing found
      await expect(service.create('user-1', 'Work')).rejects.toThrow('already exists');
    });
  });

  describe('list', () => {
    it('returns all banks for user', async () => {
      mockDb.where.mockResolvedValueOnce([fakeBank]);
      const result = await service.list('user-1');
      expect(result).toEqual([fakeBank]);
    });
  });

  describe('getById', () => {
    it('returns bank when found', async () => {
      mockDb.where.mockResolvedValueOnce([fakeBank]);
      const result = await service.getById('user-1', 'bank-1');
      expect(result).toEqual(fakeBank);
    });

    it('throws NotFoundException when not found', async () => {
      mockDb.where.mockResolvedValueOnce([]);
      await expect(service.getById('user-1', 'bad-id')).rejects.toThrow('not found');
    });
  });

  describe('rename', () => {
    it('renames a bank', async () => {
      // getById
      mockDb.where.mockResolvedValueOnce([fakeBank]);
      // Check uniqueness
      mockDb.where.mockResolvedValueOnce([]);

      const result = await service.rename('user-1', 'bank-1', 'Personal');
      expect(result.name).toBe('Personal');
    });

    it('throws if new name conflicts', async () => {
      mockDb.where.mockResolvedValueOnce([fakeBank]); // getById
      mockDb.where.mockResolvedValueOnce([{ ...fakeBank, id: 'bank-2', name: 'Personal' }]); // conflict
      await expect(service.rename('user-1', 'bank-1', 'Personal')).rejects.toThrow(
        'already exists',
      );
    });
  });

  describe('remove', () => {
    it('deletes bank and its memories', async () => {
      mockDb.where
        .mockResolvedValueOnce([fakeBank]) // getById
        .mockResolvedValueOnce([{ id: 'mem-1' }, { id: 'mem-2' }]); // memory IDs

      const result = await service.remove('user-1', 'bank-1');
      expect(result.deleted).toBe(true);
      expect(result.memoriesDeleted).toBe(2);
      expect(qdrantService.remove).toHaveBeenCalledTimes(2);
    });

    it('throws if trying to delete default bank', async () => {
      mockDb.where.mockResolvedValueOnce([{ ...fakeBank, isDefault: true }]);
      await expect(service.remove('user-1', 'bank-1')).rejects.toThrow('Cannot delete the default');
    });

    it('handles empty bank deletion', async () => {
      mockDb.where
        .mockResolvedValueOnce([fakeBank]) // getById
        .mockResolvedValueOnce([]); // no memories

      const result = await service.remove('user-1', 'bank-1');
      expect(result.memoriesDeleted).toBe(0);
    });
  });

  describe('getOrCreateDefault', () => {
    it('returns existing default bank', async () => {
      const defaultBank = { ...fakeBank, isDefault: true, name: 'Default' };
      mockDb.where.mockResolvedValueOnce([defaultBank]);
      const result = await service.getOrCreateDefault('user-1');
      expect(result).toEqual(defaultBank);
    });

    it('creates default bank if none exists', async () => {
      mockDb.where.mockResolvedValueOnce([]); // no existing default
      mockDb.where.mockResolvedValueOnce([{ ...fakeBank, isDefault: true, name: 'Default' }]); // getById after create

      const result = await service.getOrCreateDefault('user-1');
      expect(mockDb.insert).toHaveBeenCalled();
      expect(result.isDefault).toBe(true);
    });
  });

  describe('getMemoryCounts', () => {
    it('returns memory counts per bank', async () => {
      mockDb.execute.mockResolvedValueOnce({
        rows: [
          { id: 'bank-1', count: '42' },
          { id: 'bank-2', count: '0' },
        ],
      });

      const result = await service.getMemoryCounts('user-1');
      expect(result).toEqual({ 'bank-1': 42, 'bank-2': 0 });
    });
  });
});
