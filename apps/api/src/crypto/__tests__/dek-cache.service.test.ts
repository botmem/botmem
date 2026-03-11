import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock ioredis before importing the service
const mockRedis = {
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn(),
  set: vi.fn().mockResolvedValue('OK'),
  get: vi.fn().mockResolvedValue(null),
  del: vi.fn().mockResolvedValue(1),
};

vi.mock('ioredis', () => ({
  default: vi.fn(() => mockRedis),
}));

import { DekCacheService } from '../dek-cache.service';

describe('DekCacheService', () => {
  let service: DekCacheService;
  let config: { redisUrl: string };
  let crypto: { encrypt: ReturnType<typeof vi.fn>; decrypt: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    config = { redisUrl: 'redis://localhost:6379' };
    crypto = {
      encrypt: vi.fn((v: string) => `enc:${v}`),
      decrypt: vi.fn((v: string) => v.replace('enc:', '')),
    };
    service = new DekCacheService(config, crypto);
  });

  describe('constructor', () => {
    it('creates Redis connection', () => {
      expect(mockRedis.connect).toHaveBeenCalled();
    });

    it('handles Redis connection failure gracefully', () => {
      mockRedis.connect.mockRejectedValueOnce(new Error('refused'));
      // Should not throw
      const s = new DekCacheService(config, crypto);
      expect(s).toBeDefined();
    });
  });

  describe('onModuleDestroy', () => {
    it('disconnects Redis', () => {
      service.onModuleDestroy();
      expect(mockRedis.disconnect).toHaveBeenCalled();
    });
  });

  describe('cacheDek', () => {
    it('encrypts and stores DEK in Redis with TTL', async () => {
      const dek = Buffer.from('my-secret-key');

      await service.cacheDek('user-1', dek);

      expect(crypto.encrypt).toHaveBeenCalledWith(dek.toString('base64'));
      expect(mockRedis.set).toHaveBeenCalledWith(
        'dek:user-1',
        expect.stringContaining('enc:'),
        'EX',
        30 * 24 * 60 * 60,
      );
    });

    it('uses custom TTL when provided', async () => {
      const dek = Buffer.from('key');

      await service.cacheDek('user-1', dek, 3600);

      expect(mockRedis.set).toHaveBeenCalledWith('dek:user-1', expect.any(String), 'EX', 3600);
    });

    it('skips Redis set when encrypt returns null', async () => {
      crypto.encrypt.mockReturnValue(null);

      await service.cacheDek('user-1', Buffer.from('key'));

      expect(mockRedis.set).not.toHaveBeenCalled();
    });

    it('handles Redis error gracefully', async () => {
      mockRedis.set.mockRejectedValueOnce(new Error('Redis down'));

      await expect(service.cacheDek('user-1', Buffer.from('key'))).resolves.toBeUndefined();
    });
  });

  describe('getCachedDek', () => {
    it('retrieves and decrypts DEK from Redis', async () => {
      mockRedis.get.mockResolvedValueOnce('enc:bXktc2VjcmV0LWtleQ==');

      const result = await service.getCachedDek('user-1');

      expect(mockRedis.get).toHaveBeenCalledWith('dek:user-1');
      expect(crypto.decrypt).toHaveBeenCalledWith('enc:bXktc2VjcmV0LWtleQ==');
      expect(result).toBeInstanceOf(Buffer);
      expect(result!.toString('base64')).toBe('bXktc2VjcmV0LWtleQ==');
    });

    it('returns null when no cached value', async () => {
      mockRedis.get.mockResolvedValueOnce(null);

      const result = await service.getCachedDek('user-1');
      expect(result).toBeNull();
    });

    it('returns null when decrypt returns null', async () => {
      mockRedis.get.mockResolvedValueOnce('enc:corrupt');
      crypto.decrypt.mockReturnValueOnce(null);

      const result = await service.getCachedDek('user-1');
      expect(result).toBeNull();
    });

    it('handles Redis error gracefully', async () => {
      mockRedis.get.mockRejectedValueOnce(new Error('timeout'));

      const result = await service.getCachedDek('user-1');
      expect(result).toBeNull();
    });
  });

  describe('removeDek', () => {
    it('deletes DEK from Redis', async () => {
      await service.removeDek('user-1');

      expect(mockRedis.del).toHaveBeenCalledWith('dek:user-1');
    });

    it('handles Redis error gracefully', async () => {
      mockRedis.del.mockRejectedValueOnce(new Error('Redis down'));

      await expect(service.removeDek('user-1')).resolves.toBeUndefined();
    });
  });
});
