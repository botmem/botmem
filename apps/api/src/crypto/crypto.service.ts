import { Injectable, Logger } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { ConfigService } from '../config/config.service';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const SALT = 'botmem-enc-v1'; // static salt — key uniqueness comes from APP_SECRET
const DEFAULT_APP_SECRET = 'dev-app-secret-change-in-production';

@Injectable()
export class CryptoService {
  private readonly logger = new Logger(CryptoService.name);
  private key: Buffer;

  constructor(private config: ConfigService) {
    if (this.config.appSecret === DEFAULT_APP_SECRET) {
      this.logger.warn(
        'APP_SECRET is set to the default value. This is insecure — set a unique APP_SECRET for this deployment.',
      );
    }
    this.key = scryptSync(this.config.appSecret, SALT, 32);
  }

  /**
   * Encrypt plaintext → base64 string in format: iv:ciphertext:tag
   * Returns null if input is null/undefined.
   */
  encrypt(plaintext: string | null | undefined): string | null {
    if (plaintext == null) return null;
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('base64')}:${encrypted.toString('base64')}:${tag.toString('base64')}`;
  }

  /**
   * Decrypt a string produced by encrypt().
   * Returns the original plaintext, or null if input is null/undefined.
   * If input doesn't look encrypted (no colons), returns it as-is (plaintext passthrough).
   */
  decrypt(ciphertext: string | null | undefined): string | null {
    if (ciphertext == null) return null;

    // Plaintext passthrough — unencrypted data won't have the iv:data:tag format
    const parts = ciphertext.split(':');
    if (parts.length !== 3) return ciphertext;

    // Extra safety: check that parts look like base64
    try {
      const iv = Buffer.from(parts[0], 'base64');
      const encrypted = Buffer.from(parts[1], 'base64');
      const tag = Buffer.from(parts[2], 'base64');

      if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) {
        // Not our format — return as plaintext
        return ciphertext;
      }

      const decipher = createDecipheriv(ALGORITHM, this.key, iv);
      decipher.setAuthTag(tag);
      return decipher.update(encrypted) + decipher.final('utf8');
    } catch {
      // Decryption failed — likely plaintext that happened to have colons
      return ciphertext;
    }
  }

  /**
   * Check if a string appears to be encrypted by this service.
   */
  isEncrypted(value: string | null | undefined): boolean {
    if (value == null) return false;
    const parts = value.split(':');
    if (parts.length !== 3) return false;
    try {
      const iv = Buffer.from(parts[0], 'base64');
      const tag = Buffer.from(parts[2], 'base64');
      return iv.length === IV_LENGTH && tag.length === TAG_LENGTH;
    } catch {
      return false;
    }
  }

  /**
   * Encrypt memory fields (text, entities, claims, metadata) for at-rest protection.
   * Called after enrichment is complete, before marking memory as 'done'.
   */
  encryptMemoryFields(fields: {
    text: string;
    entities: string;
    claims: string;
    metadata: string;
  }) {
    return {
      text: this.encrypt(fields.text)!,
      entities: this.encrypt(fields.entities)!,
      claims: this.encrypt(fields.claims)!,
      metadata: this.encrypt(fields.metadata)!,
    };
  }

  /**
   * Decrypt memory fields for reading. Handles plaintext passthrough gracefully.
   */
  decryptMemoryFields<
    T extends { text: string; entities: string; claims: string; metadata: string },
  >(mem: T): T {
    return {
      ...mem,
      text: this.decrypt(mem.text) ?? mem.text,
      entities: this.decrypt(mem.entities) ?? mem.entities,
      claims: this.decrypt(mem.claims) ?? mem.claims,
      metadata: this.decrypt(mem.metadata) ?? mem.metadata,
    };
  }

  // --- Per-user key methods (E2EE) ---

  /**
   * Encrypt plaintext with an arbitrary key (e.g., user-derived key).
   * Same AES-256-GCM logic as encrypt() but using provided key instead of APP_SECRET key.
   */
  encryptWithKey(plaintext: string | null | undefined, key: Buffer): string | null {
    if (plaintext == null) return null;
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('base64')}:${encrypted.toString('base64')}:${tag.toString('base64')}`;
  }

  /**
   * Decrypt a string produced by encryptWithKey() using the provided key.
   */
  decryptWithKey(ciphertext: string | null | undefined, key: Buffer): string | null {
    if (ciphertext == null) return null;

    const parts = ciphertext.split(':');
    if (parts.length !== 3) return ciphertext;

    try {
      const iv = Buffer.from(parts[0], 'base64');
      const encrypted = Buffer.from(parts[1], 'base64');
      const tag = Buffer.from(parts[2], 'base64');

      if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) {
        return ciphertext;
      }

      const decipher = createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(tag);
      return decipher.update(encrypted) + decipher.final('utf8');
    } catch {
      return ciphertext;
    }
  }

  /**
   * Encrypt memory fields with a per-user key.
   */
  encryptMemoryFieldsWithKey(
    fields: { text: string; entities: string; claims: string; metadata: string },
    key: Buffer,
  ) {
    return {
      text: this.encryptWithKey(fields.text, key)!,
      entities: this.encryptWithKey(fields.entities, key)!,
      claims: this.encryptWithKey(fields.claims, key)!,
      metadata: this.encryptWithKey(fields.metadata, key)!,
    };
  }

  /**
   * Decrypt memory fields with a per-user key.
   */
  decryptMemoryFieldsWithKey<
    T extends { text: string; entities: string; claims: string; metadata: string },
  >(mem: T, key: Buffer): T {
    return {
      ...mem,
      text: this.decryptWithKey(mem.text, key) ?? mem.text,
      entities: this.decryptWithKey(mem.entities, key) ?? mem.entities,
      claims: this.decryptWithKey(mem.claims, key) ?? mem.claims,
      metadata: this.decryptWithKey(mem.metadata, key) ?? mem.metadata,
    };
  }
}
