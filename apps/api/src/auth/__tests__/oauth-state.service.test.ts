import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock ioredis before importing the service
const mockRedis = {
  set: vi.fn(),
  get: vi.fn(),
  del: vi.fn(),
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn(),
};
vi.mock('ioredis', () => ({
  default: vi.fn(() => mockRedis),
}));

import { OAuthStateService } from '../oauth-state.service';
import type { ConfigService } from '../../config/config.service';

function createService() {
  const configService = { redisUrl: 'redis://localhost:6379' } as unknown as ConfigService;
  return new OAuthStateService(configService);
}

describe('OAuthStateService', () => {
  let service: OAuthStateService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = createService();
  });

  describe('savePendingConfig', () => {
    it('stores config in Redis with 600s TTL', async () => {
      const data = { config: { clientId: 'cid' }, returnTo: '/home', userId: 'u1' };
      await service.savePendingConfig('token-1', data);
      expect(mockRedis.set).toHaveBeenCalledWith(
        'oauth:pending:token-1',
        JSON.stringify(data),
        'EX',
        600,
      );
    });
  });

  describe('getPendingConfig', () => {
    it('returns parsed config when found', async () => {
      const data = { config: { clientId: 'cid' }, userId: 'u1' };
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(data));
      const result = await service.getPendingConfig('token-1');
      expect(result).toEqual(data);
    });

    it('returns null when not found', async () => {
      mockRedis.get.mockResolvedValueOnce(null);
      const result = await service.getPendingConfig('missing');
      expect(result).toBeNull();
    });

    it('returns null on Redis error', async () => {
      mockRedis.get.mockRejectedValueOnce(new Error('connection lost'));
      const result = await service.getPendingConfig('token-1');
      expect(result).toBeNull();
    });
  });

  describe('deletePendingConfig', () => {
    it('deletes the key from Redis', async () => {
      await service.deletePendingConfig('token-1');
      expect(mockRedis.del).toHaveBeenCalledWith('oauth:pending:token-1');
    });
  });

  describe('acquireCreateLock', () => {
    it('returns true when lock acquired (SET NX returns OK)', async () => {
      mockRedis.set.mockResolvedValueOnce('OK');
      const result = await service.acquireCreateLock('gmail:user@test.com');
      expect(result).toBe(true);
      expect(mockRedis.set).toHaveBeenCalledWith(
        'oauth:lock:gmail:user@test.com',
        '1',
        'EX',
        30,
        'NX',
      );
    });

    it('returns false when lock already held', async () => {
      mockRedis.set.mockResolvedValueOnce(null);
      const result = await service.acquireCreateLock('gmail:user@test.com');
      expect(result).toBe(false);
    });

    it('returns false on Redis error', async () => {
      mockRedis.set.mockRejectedValueOnce(new Error('connection lost'));
      const result = await service.acquireCreateLock('key');
      expect(result).toBe(false);
    });
  });

  describe('releaseCreateLock', () => {
    it('deletes the lock key', async () => {
      await service.releaseCreateLock('gmail:user@test.com');
      expect(mockRedis.del).toHaveBeenCalledWith('oauth:lock:gmail:user@test.com');
    });
  });

  describe('onModuleDestroy', () => {
    it('disconnects Redis', () => {
      service.onModuleDestroy();
      expect(mockRedis.disconnect).toHaveBeenCalled();
    });
  });
});
