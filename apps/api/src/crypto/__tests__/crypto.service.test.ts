import { describe, it, expect } from 'vitest';
import { randomBytes } from 'crypto';
import { CryptoService } from '../crypto.service';
import type { ConfigService } from '../../config/config.service';

const mockConfig = { appSecret: 'test-secret-for-unit-tests' } as unknown as ConfigService;

describe('CryptoService', () => {
  const service = new CryptoService(mockConfig);

  it('encrypts and decrypts a string', () => {
    const plaintext = JSON.stringify({ clientId: 'abc', clientSecret: 'xyz' });
    const encrypted = service.encrypt(plaintext);
    expect(encrypted).not.toBe(plaintext);
    expect(encrypted).toContain(':');
    const decrypted = service.decrypt(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it('returns null for null input', () => {
    expect(service.encrypt(null)).toBeNull();
    expect(service.decrypt(null)).toBeNull();
    expect(service.encrypt(undefined)).toBeNull();
    expect(service.decrypt(undefined)).toBeNull();
  });

  it('passes through plaintext that is not encrypted', () => {
    const json = '{"clientId":"abc","clientSecret":"xyz"}';
    expect(service.decrypt(json)).toBe(json);
  });

  it('isEncrypted correctly identifies encrypted vs plaintext', () => {
    const plaintext = '{"foo":"bar"}';
    const encrypted = service.encrypt(plaintext)!;
    expect(service.isEncrypted(encrypted)).toBe(true);
    expect(service.isEncrypted(plaintext)).toBe(false);
    expect(service.isEncrypted(null)).toBe(false);
  });

  it('produces different ciphertexts for the same plaintext (random IV)', () => {
    const plaintext = 'same input';
    const a = service.encrypt(plaintext);
    const b = service.encrypt(plaintext);
    expect(a).not.toBe(b);
    expect(service.decrypt(a)).toBe(plaintext);
    expect(service.decrypt(b)).toBe(plaintext);
  });

  it('encryptMemoryFields encrypts all four fields', () => {
    const fields = {
      text: 'Meeting with John',
      entities: JSON.stringify([{ type: 'person', value: 'John' }]),
      claims: JSON.stringify([]),
      metadata: JSON.stringify({ subject: 'project' }),
    };
    const enc = service.encryptMemoryFields(fields);
    expect(enc.text).not.toBe(fields.text);
    expect(enc.entities).not.toBe(fields.entities);
    expect(enc.claims).not.toBe(fields.claims);
    expect(enc.metadata).not.toBe(fields.metadata);
    expect(service.isEncrypted(enc.text)).toBe(true);
  });

  it('decryptMemoryFields restores all four fields', () => {
    const fields = {
      id: 'mem-1',
      text: 'Meeting with John',
      entities: JSON.stringify([{ type: 'person', value: 'John' }]),
      claims: JSON.stringify([]),
      metadata: JSON.stringify({ subject: 'project' }),
    };
    const enc = service.encryptMemoryFields(fields);
    const dec = service.decryptMemoryFields({ ...fields, ...enc });
    expect(dec.text).toBe(fields.text);
    expect(dec.entities).toBe(fields.entities);
    expect(dec.claims).toBe(fields.claims);
    expect(dec.metadata).toBe(fields.metadata);
    expect(dec.id).toBe('mem-1');
  });

  it('decryptMemoryFields passes through plaintext gracefully', () => {
    const fields = {
      text: 'plain text',
      entities: '[]',
      claims: '[]',
      metadata: '{}',
    };
    const dec = service.decryptMemoryFields(fields);
    expect(dec.text).toBe('plain text');
    expect(dec.entities).toBe('[]');
  });

  // --- Per-user key (E2EE) tests ---

  describe('encryptWithKey / decryptWithKey', () => {
    const userKey = randomBytes(32);

    it('round-trips plaintext correctly', () => {
      const plaintext = 'Hello, per-user encryption!';
      const encrypted = service.encryptWithKey(plaintext, userKey);
      expect(encrypted).not.toBe(plaintext);
      expect(encrypted).toContain(':');
      const decrypted = service.decryptWithKey(encrypted, userKey);
      expect(decrypted).toBe(plaintext);
    });

    it('returns null for null/undefined input', () => {
      expect(service.encryptWithKey(null, userKey)).toBeNull();
      expect(service.encryptWithKey(undefined, userKey)).toBeNull();
      expect(service.decryptWithKey(null, userKey)).toBeNull();
      expect(service.decryptWithKey(undefined, userKey)).toBeNull();
    });

    it('produces different ciphertexts for same plaintext (random IV)', () => {
      const plaintext = 'same input';
      const a = service.encryptWithKey(plaintext, userKey);
      const b = service.encryptWithKey(plaintext, userKey);
      expect(a).not.toBe(b);
    });

    it('cannot decrypt with wrong key', () => {
      const wrongKey = randomBytes(32);
      const encrypted = service.encryptWithKey('secret', userKey)!;
      // Wrong key returns ciphertext as-is (catch block)
      const result = service.decryptWithKey(encrypted, wrongKey);
      expect(result).not.toBe('secret');
    });
  });

  describe('encryptMemoryFieldsWithKey / decryptMemoryFieldsWithKey', () => {
    const userKey = randomBytes(32);

    it('encrypts and decrypts all four memory fields', () => {
      const fields = {
        text: 'Meeting with John',
        entities: JSON.stringify([{ type: 'person', value: 'John' }]),
        claims: JSON.stringify([]),
        metadata: JSON.stringify({ subject: 'project' }),
      };
      const enc = service.encryptMemoryFieldsWithKey(fields, userKey);
      expect(enc.text).not.toBe(fields.text);
      expect(enc.entities).not.toBe(fields.entities);

      const dec = service.decryptMemoryFieldsWithKey({ id: 'mem-1', ...enc }, userKey);
      expect(dec.text).toBe(fields.text);
      expect(dec.entities).toBe(fields.entities);
      expect(dec.claims).toBe(fields.claims);
      expect(dec.metadata).toBe(fields.metadata);
      expect((dec as unknown as { id: string }).id).toBe('mem-1');
    });
  });
});
