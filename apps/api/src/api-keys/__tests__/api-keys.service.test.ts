import { describe, it, expect, beforeEach } from 'vitest';
import { ApiKeysService } from '../api-keys.service';
import { createHash } from 'crypto';

function createService(db?: unknown) {
  const dbService = { db: db ?? {} } as unknown as { db: unknown };
  return new ApiKeysService(dbService as never);
}

describe('ApiKeysService', () => {
  let service: ApiKeysService;

  beforeEach(() => {
    service = createService();
  });

  describe('generateKey', () => {
    it('returns raw key with bm_sk_ prefix and correct length', () => {
      const { raw, hash, lastFour } = service.generateKey();
      expect(raw).toMatch(/^bm_sk_[0-9a-f]{32}$/);
      expect(raw.length).toBe(38); // bm_sk_ (6) + 32 hex = 38
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(lastFour.length).toBe(4);
    });

    it('produces correct SHA-256 hash', () => {
      const { raw, hash } = service.generateKey();
      const expected = createHash('sha256').update(raw).digest('hex');
      expect(hash).toBe(expected);
    });
  });
});
