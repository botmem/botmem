import { describe, it, expect } from 'vitest';
import { randomBytes } from 'crypto';
import { UserKeyService } from '../user-key.service';

describe('UserKeyService', () => {
  it('deriveAndStore produces a 32-byte key and stores it', async () => {
    const service = new UserKeyService();
    const salt = randomBytes(16);
    await service.deriveAndStore('user-1', 'password123', salt);
    const key = service.getKey('user-1');
    expect(key).toBeDefined();
    expect(key).toBeInstanceOf(Buffer);
    expect(key!.length).toBe(32);
  });

  it('getKey returns undefined for unknown user', () => {
    const service = new UserKeyService();
    expect(service.getKey('unknown')).toBeUndefined();
  });

  it('hasKey returns true for stored user, false otherwise', async () => {
    const service = new UserKeyService();
    expect(service.hasKey('user-1')).toBe(false);
    const salt = randomBytes(16);
    await service.deriveAndStore('user-1', 'password123', salt);
    expect(service.hasKey('user-1')).toBe(true);
  });

  it('removeKey deletes the cached key', async () => {
    const service = new UserKeyService();
    const salt = randomBytes(16);
    await service.deriveAndStore('user-1', 'password123', salt);
    expect(service.hasKey('user-1')).toBe(true);
    service.removeKey('user-1');
    expect(service.hasKey('user-1')).toBe(false);
    expect(service.getKey('user-1')).toBeUndefined();
  });

  it('derives deterministic keys for same password + salt', async () => {
    const service = new UserKeyService();
    const salt = randomBytes(16);
    await service.deriveAndStore('user-a', 'password123', salt);
    const keyA = Buffer.from(service.getKey('user-a')!);
    await service.deriveAndStore('user-b', 'password123', salt);
    const keyB = service.getKey('user-b')!;
    expect(keyA.equals(keyB)).toBe(true);
  });

  it('derives different keys for different salts', async () => {
    const service = new UserKeyService();
    await service.deriveAndStore('user-a', 'password123', randomBytes(16));
    await service.deriveAndStore('user-b', 'password123', randomBytes(16));
    const keyA = service.getKey('user-a')!;
    const keyB = service.getKey('user-b')!;
    expect(keyA.equals(keyB)).toBe(false);
  });
});
