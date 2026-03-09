import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

/**
 * In-memory per-user encryption key management.
 * Keys are derived from user password + per-user salt via Argon2id.
 * Keys are NEVER written to database or disk -- memory-only Map.
 */
@Injectable()
export class UserKeyService {
  private keys = new Map<string, Buffer>();

  /**
   * Derive a 32-byte AES-256 key from password + salt using Argon2id,
   * then store it in the in-memory map keyed by userId.
   */
  async deriveAndStore(userId: string, password: string, salt: Buffer): Promise<void> {
    const key = await argon2.hash(password, {
      type: argon2.argon2id,
      raw: true,
      hashLength: 32,
      salt,
      timeCost: 3,
      memoryCost: 19456,
      parallelism: 1,
    });
    this.keys.set(userId, key as Buffer);
  }

  /**
   * Retrieve the cached encryption key for a user, or undefined if not cached.
   */
  getKey(userId: string): Buffer | undefined {
    return this.keys.get(userId);
  }

  /**
   * Check if a user has a cached encryption key.
   */
  hasKey(userId: string): boolean {
    return this.keys.has(userId);
  }

  /**
   * Remove a user's cached encryption key (e.g., on logout or key rotation).
   */
  removeKey(userId: string): void {
    this.keys.delete(userId);
  }
}
