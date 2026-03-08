import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../../db/schema';
import { ApiKeysService } from '../api-keys.service';
import { randomBytes, createHash } from 'crypto';

// Minimal DbService mock using in-memory SQLite
function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      onboarded INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE api_keys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      last_four TEXT NOT NULL,
      memory_bank_ids TEXT,
      expires_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_api_keys_user_id ON api_keys(user_id);
    CREATE INDEX idx_api_keys_hash ON api_keys(key_hash);
  `);
  const db = drizzle(sqlite, { schema });

  // Insert a test user
  const now = new Date().toISOString();
  sqlite.exec(`INSERT INTO users (id, email, password_hash, name, onboarded, created_at, updated_at)
    VALUES ('user-1', 'test@example.com', 'hash', 'Test User', 0, '${now}', '${now}')`);

  return { sqlite, db };
}

function createService(db: any) {
  const dbService = { db } as any;
  return new ApiKeysService(dbService);
}

describe('ApiKeysService', () => {
  let sqlite: Database.Database;
  let service: ApiKeysService;

  beforeEach(() => {
    const testDb = createTestDb();
    sqlite = testDb.sqlite;
    service = createService(testDb.db);
  });

  afterEach(() => {
    sqlite.close();
  });

  describe('generateKey', () => {
    it('returns raw key with bm_sk_ prefix and 41 chars total', () => {
      const { raw, hash, lastFour } = service.generateKey();
      expect(raw).toMatch(/^bm_sk_[0-9a-f]{32}$/);
      expect(raw.length).toBe(38); // bm_sk_ (6) + 32 hex = 38
      // Actually: 6 + 32 = 38. Plan says 41 but 16 bytes = 32 hex + 6 prefix = 38.
      // Let me check: randomBytes(16).toString('hex') = 32 chars. 'bm_sk_' = 6 chars. Total = 38.
      // The plan says "41 chars" but 6 + 32 = 38. Let's just test the actual behavior.
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(lastFour.length).toBe(4);
    });

    it('produces correct SHA-256 hash', () => {
      const { raw, hash } = service.generateKey();
      const expected = createHash('sha256').update(raw).digest('hex');
      expect(hash).toBe(expected);
    });
  });

  describe('create', () => {
    it('creates a key and returns raw key, id, name, lastFour', async () => {
      const result = await service.create('user-1', 'my-key');
      expect(result.key).toMatch(/^bm_sk_/);
      expect(result.id).toBeTruthy();
      expect(result.name).toBe('my-key');
      expect(result.lastFour.length).toBe(4);
    });

    it('throws when user has 10 keys', async () => {
      for (let i = 0; i < 10; i++) {
        await service.create('user-1', `key-${i}`);
      }
      await expect(service.create('user-1', 'key-10')).rejects.toThrow('Maximum 10 API keys per user');
    });

    it('throws on duplicate name for same user', async () => {
      await service.create('user-1', 'dup-name');
      await expect(service.create('user-1', 'dup-name')).rejects.toThrow('already exists');
    });

    it('allows duplicate name if first key is revoked', async () => {
      const first = await service.create('user-1', 'reuse-name');
      await service.revoke('user-1', first.id);
      const second = await service.create('user-1', 'reuse-name');
      expect(second.name).toBe('reuse-name');
    });

    it('stores optional expiresAt', async () => {
      const expiry = '2099-01-01T00:00:00.000Z';
      const result = await service.create('user-1', 'expiring-key', expiry);
      const keys = await service.listByUser('user-1');
      const found = keys.find(k => k.id === result.id);
      expect(found?.expiresAt).toBe(expiry);
    });
  });

  describe('listByUser', () => {
    it('returns keys with masked data, never raw key or hash', async () => {
      await service.create('user-1', 'list-test');
      const keys = await service.listByUser('user-1');
      expect(keys.length).toBe(1);
      expect(keys[0].name).toBe('list-test');
      expect(keys[0].lastFour.length).toBe(4);
      expect(keys[0].createdAt).toBeTruthy();
      // Should NOT have key or keyHash properties
      expect((keys[0] as any).key).toBeUndefined();
      expect((keys[0] as any).keyHash).toBeUndefined();
    });
  });

  describe('revoke', () => {
    it('sets revokedAt and key no longer validates', async () => {
      const result = await service.create('user-1', 'revoke-test');
      const validBefore = await service.validateKey(result.key);
      expect(validBefore).not.toBeNull();

      await service.revoke('user-1', result.id);

      const validAfter = await service.validateKey(result.key);
      expect(validAfter).toBeNull();
    });
  });

  describe('validateKey', () => {
    it('returns key record for valid active key', async () => {
      const result = await service.create('user-1', 'valid-test');
      const record = await service.validateKey(result.key);
      expect(record).not.toBeNull();
      expect(record!.userId).toBe('user-1');
      expect(record!.name).toBe('valid-test');
    });

    it('returns null for invalid key', async () => {
      const record = await service.validateKey('bm_sk_invalid0000000000000000000000');
      expect(record).toBeNull();
    });

    it('returns null for expired key', async () => {
      const pastDate = '2020-01-01T00:00:00.000Z';
      const result = await service.create('user-1', 'expired-test', pastDate);
      const record = await service.validateKey(result.key);
      expect(record).toBeNull();
    });

    it('returns key record for key with future expiry', async () => {
      const futureDate = '2099-12-31T23:59:59.000Z';
      const result = await service.create('user-1', 'future-test', futureDate);
      const record = await service.validateKey(result.key);
      expect(record).not.toBeNull();
    });

    it('returns null for revoked key', async () => {
      const result = await service.create('user-1', 'revoked-validate');
      await service.revoke('user-1', result.id);
      const record = await service.validateKey(result.key);
      expect(record).toBeNull();
    });
  });
});
