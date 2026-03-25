import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QuotaService } from '../quota.service';
import { FREE_MEMORY_LIMIT } from '@botmem/shared';
import type { DbService } from '../../db/db.service';
import type { BillingService } from '../billing.service';
import type { ConfigService } from '../../config/config.service';

describe('QuotaService', () => {
  let service: QuotaService;
  let mockDbService: { db: { execute: ReturnType<typeof vi.fn> } };
  let mockBilling: { isProUser: ReturnType<typeof vi.fn> };
  let mockConfig: { isSelfHosted: boolean };

  function buildService() {
    return new QuotaService(
      mockDbService as unknown as DbService,
      mockBilling as unknown as BillingService,
      mockConfig as unknown as ConfigService,
    );
  }

  beforeEach(() => {
    mockDbService = {
      db: {
        execute: vi.fn().mockResolvedValue({ rows: [{ count: 0 }] }),
      },
    };
    mockBilling = { isProUser: vi.fn().mockResolvedValue(false) };
    mockConfig = { isSelfHosted: false };
    service = buildService();
  });

  describe('canCreateMemory', () => {
    it('always allows in self-hosted mode', async () => {
      mockConfig.isSelfHosted = true;
      service = buildService();

      const result = await service.canCreateMemory('user-1');
      expect(result).toEqual({ allowed: true, used: 0, limit: null });
      expect(mockBilling.isProUser).not.toHaveBeenCalled();
    });

    it('always allows for pro users', async () => {
      mockBilling.isProUser.mockResolvedValue(true);

      const result = await service.canCreateMemory('user-1');
      expect(result).toEqual({ allowed: true, used: 0, limit: null });
    });

    it('allows free user under limit', async () => {
      mockDbService.db.execute.mockResolvedValue({ rows: [{ count: 200 }] });

      const result = await service.canCreateMemory('user-1');
      expect(result).toEqual({ allowed: true, used: 200, limit: FREE_MEMORY_LIMIT });
    });

    it('blocks free user at limit', async () => {
      mockDbService.db.execute.mockResolvedValue({ rows: [{ count: 500 }] });

      const result = await service.canCreateMemory('user-1');
      expect(result).toEqual({ allowed: false, used: 500, limit: FREE_MEMORY_LIMIT });
    });

    it('blocks free user over limit', async () => {
      mockDbService.db.execute.mockResolvedValue({ rows: [{ count: 600 }] });

      const result = await service.canCreateMemory('user-1');
      expect(result).toEqual({ allowed: false, used: 600, limit: FREE_MEMORY_LIMIT });
    });
  });

  describe('getUserQuota', () => {
    it('returns unlimited for self-hosted', async () => {
      mockConfig.isSelfHosted = true;
      service = buildService();

      const result = await service.getUserQuota('user-1');
      expect(result).toEqual({ used: 0, limit: null, remaining: null });
    });

    it('returns unlimited for pro user', async () => {
      mockBilling.isProUser.mockResolvedValue(true);
      mockDbService.db.execute.mockResolvedValue({ rows: [{ count: 300 }] });

      const result = await service.getUserQuota('user-1');
      expect(result).toEqual({ used: 300, limit: null, remaining: null });
    });

    it('returns correct quota for free user', async () => {
      mockDbService.db.execute.mockResolvedValue({ rows: [{ count: 342 }] });

      const result = await service.getUserQuota('user-1');
      expect(result).toEqual({ used: 342, limit: FREE_MEMORY_LIMIT, remaining: 158 });
    });

    it('returns zero remaining when at limit', async () => {
      mockDbService.db.execute.mockResolvedValue({ rows: [{ count: 500 }] });

      const result = await service.getUserQuota('user-1');
      expect(result).toEqual({ used: 500, limit: FREE_MEMORY_LIMIT, remaining: 0 });
    });
  });

  describe('cache behavior', () => {
    it('caches count and avoids second DB call', async () => {
      mockDbService.db.execute.mockResolvedValue({ rows: [{ count: 100 }] });

      await service.getTotalMemoryCount('user-1');
      await service.getTotalMemoryCount('user-1');

      expect(mockDbService.db.execute).toHaveBeenCalledTimes(1);
    });

    it('re-queries after cache expires', async () => {
      mockDbService.db.execute.mockResolvedValue({ rows: [{ count: 100 }] });

      await service.getTotalMemoryCount('user-1');

      // Manually expire the cache by manipulating the internal map
      const cache = (service as unknown as { cache: Map<string, { count: number; ts: number }> })
        .cache;
      const entry = cache.get('user-1')!;
      entry.ts = Date.now() - 31_000; // 31s ago, past 30s TTL

      await service.getTotalMemoryCount('user-1');
      expect(mockDbService.db.execute).toHaveBeenCalledTimes(2);
    });

    it('incrementCachedCount bumps the cached value', async () => {
      mockDbService.db.execute.mockResolvedValue({ rows: [{ count: 499 }] });

      const count1 = await service.getTotalMemoryCount('user-1');
      expect(count1).toBe(499);

      service.incrementCachedCount('user-1');

      const count2 = await service.getTotalMemoryCount('user-1');
      expect(count2).toBe(500);
      // Still only 1 DB call — served from cache
      expect(mockDbService.db.execute).toHaveBeenCalledTimes(1);
    });

    it('incrementCachedCount is a no-op when no cache entry exists', () => {
      // Should not throw
      service.incrementCachedCount('nonexistent-user');
    });
  });
});
