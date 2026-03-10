import { describe, it, expect, vi } from 'vitest';
import { UserKeyService } from '../user-key.service';
import { DekCacheService } from '../dek-cache.service';
import { randomBytes } from 'crypto';

function mockDekCache(): DekCacheService {
  const store = new Map<string, Buffer>();
  return {
    cacheDek: vi.fn(async (userId: string, dek: Buffer) => {
      store.set(userId, dek);
    }),
    getCachedDek: vi.fn(async (userId: string) => store.get(userId) || null),
  } as unknown as DekCacheService;
}

describe('UserKeyService', () => {
  it('generateDek produces a 32-byte buffer', () => {
    const service = new UserKeyService(mockDekCache());
    const dek = service.generateDek();
    expect(dek).toBeInstanceOf(Buffer);
    expect(dek.length).toBe(32);
  });

  it('storeDek stores key in memory and redis', async () => {
    const cache = mockDekCache();
    const service = new UserKeyService(cache);
    const dek = randomBytes(32);
    await service.storeDek('user-1', dek);
    expect(service.getKey('user-1')).toEqual(dek);
    expect(cache.cacheDek).toHaveBeenCalledWith('user-1', dek);
  });

  it('getDek returns from memory first', async () => {
    const cache = mockDekCache();
    const service = new UserKeyService(cache);
    const dek = randomBytes(32);
    await service.storeDek('user-1', dek);
    const result = await service.getDek('user-1');
    expect(result).toEqual(dek);
    // Should not hit Redis since it's in memory
    expect(cache.getCachedDek).not.toHaveBeenCalled();
  });

  it('getDek falls back to Redis when not in memory', async () => {
    const cache = mockDekCache();
    const dek = randomBytes(32);
    // Manually put in redis mock
    await cache.cacheDek('user-1', dek);

    const service = new UserKeyService(cache);
    const result = await service.getDek('user-1');
    expect(result).toEqual(dek);
    expect(cache.getCachedDek).toHaveBeenCalledWith('user-1');
    // Should now be cached in memory too
    expect(service.getKey('user-1')).toEqual(dek);
  });

  it('getDek returns null when key is nowhere', async () => {
    const service = new UserKeyService(mockDekCache());
    const result = await service.getDek('unknown');
    expect(result).toBeNull();
  });

  it('hasKey returns true for stored user, false otherwise', async () => {
    const service = new UserKeyService(mockDekCache());
    expect(service.hasKey('user-1')).toBe(false);
    await service.storeDek('user-1', randomBytes(32));
    expect(service.hasKey('user-1')).toBe(true);
  });

  it('removeKey deletes the cached key', async () => {
    const service = new UserKeyService(mockDekCache());
    await service.storeDek('user-1', randomBytes(32));
    expect(service.hasKey('user-1')).toBe(true);
    service.removeKey('user-1');
    expect(service.hasKey('user-1')).toBe(false);
    expect(service.getKey('user-1')).toBeUndefined();
  });
});
