import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SettingsService } from '../settings.service';
import type { DbService } from '../../db/db.service';

describe('SettingsService', () => {
  let service: SettingsService;
  let mockDb: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    mockDb = {
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockReturnThis(),
      onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockResolvedValue([
        { key: 'sync_concurrency', value: '4' },
        { key: 'custom_key', value: 'custom_val' },
      ]),
    };
    service = new SettingsService({ db: mockDb } as unknown as DbService);
  });

  describe('onModuleInit', () => {
    it('seeds defaults and loads cache from DB', async () => {
      await service.onModuleInit();
      expect(mockDb.insert).toHaveBeenCalled();
      expect(mockDb.select).toHaveBeenCalled();
      // Cache should have DB values overriding defaults
      expect(await service.get('sync_concurrency')).toBe('4');
      expect(await service.get('custom_key')).toBe('custom_val');
    });
  });

  describe('get', () => {
    it('returns cached value after init', async () => {
      await service.onModuleInit();
      expect(await service.get('sync_concurrency')).toBe('4');
    });

    it('returns default for known key before init', async () => {
      expect(await service.get('sync_concurrency')).toBe('8');
    });

    it('returns empty string for unknown key', async () => {
      expect(await service.get('nonexistent')).toBe('');
    });
  });

  describe('getAll', () => {
    it('returns copy of cache', async () => {
      await service.onModuleInit();
      const all = await service.getAll();
      expect(all.sync_concurrency).toBe('4');
      expect(all.custom_key).toBe('custom_val');
      // Should be a copy, not the same reference
      all.sync_concurrency = '999';
      expect(await service.get('sync_concurrency')).toBe('4');
    });
  });

  describe('set', () => {
    it('persists to DB and updates cache', async () => {
      await service.onModuleInit();
      await service.set('sync_concurrency', '16');
      expect(mockDb.insert).toHaveBeenCalled();
      expect(await service.get('sync_concurrency')).toBe('16');
    });

    it('notifies listeners on change', async () => {
      const listener = vi.fn();
      service.onChange(listener);
      await service.set('foo', 'bar');
      expect(listener).toHaveBeenCalledWith('foo', 'bar');
    });

    it('notifies multiple listeners', async () => {
      const l1 = vi.fn();
      const l2 = vi.fn();
      service.onChange(l1);
      service.onChange(l2);
      await service.set('x', 'y');
      expect(l1).toHaveBeenCalledWith('x', 'y');
      expect(l2).toHaveBeenCalledWith('x', 'y');
    });
  });

  describe('onChange', () => {
    it('registers a listener', () => {
      const listener = vi.fn();
      service.onChange(listener);
      // No error means success — tested via set() above
      expect(true).toBe(true);
    });
  });
});
