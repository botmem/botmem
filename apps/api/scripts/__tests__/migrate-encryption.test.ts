import { describe, it, expect } from 'vitest';
import { encrypt, isEncrypted, deriveKey } from '../migrate-encryption';

const TEST_SECRET = 'test-secret-for-migration';

describe('migrate-encryption helpers', () => {
  describe('deriveKey', () => {
    it('returns a 32-byte Buffer', () => {
      const key = deriveKey(TEST_SECRET);
      expect(key).toBeInstanceOf(Buffer);
      expect(key.length).toBe(32);
    });
  });

  describe('encrypt', () => {
    it('produces iv:ciphertext:tag format string', () => {
      const key = deriveKey(TEST_SECRET);
      const result = encrypt('hello world', key);
      expect(result).not.toBeNull();
      const parts = result!.split(':');
      expect(parts).toHaveLength(3);
      // Each part should be valid base64
      for (const part of parts) {
        expect(() => Buffer.from(part, 'base64')).not.toThrow();
      }
    });

    it('returns null for null input', () => {
      const key = deriveKey(TEST_SECRET);
      expect(encrypt(null, key)).toBeNull();
    });

    it('returns null for undefined input', () => {
      const key = deriveKey(TEST_SECRET);
      expect(encrypt(undefined, key)).toBeNull();
    });
  });

  describe('isEncrypted', () => {
    it('returns true for encrypted values', () => {
      const key = deriveKey(TEST_SECRET);
      const encrypted = encrypt('{"client_id":"abc"}', key);
      expect(isEncrypted(encrypted)).toBe(true);
    });

    it('returns false for plaintext JSON', () => {
      expect(isEncrypted('{"client_id":"abc"}')).toBe(false);
    });

    it('returns false for null', () => {
      expect(isEncrypted(null)).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(isEncrypted(undefined)).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(isEncrypted('')).toBe(false);
    });
  });

  describe('idempotency', () => {
    it('isEncrypted on already-encrypted value returns true (would be skipped)', () => {
      const key = deriveKey(TEST_SECRET);
      const encrypted = encrypt('{"token":"xyz"}', key);
      // Simulates migration check: skip if already encrypted
      expect(isEncrypted(encrypted)).toBe(true);
    });

    it('encrypting then checking isEncrypted returns true', () => {
      const key = deriveKey(TEST_SECRET);
      const val = '{"refresh_token":"abc123"}';
      const enc = encrypt(val, key);
      expect(isEncrypted(enc)).toBe(true);
    });
  });
});
