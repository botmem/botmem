import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { DekCacheService } from './dek-cache.service';

/**
 * 2-tier DEK management: Memory → Redis.
 * Keys are random 32-byte DEKs shown to user as recovery key at signup.
 * No DB tier — if both caches are cold, user must re-enter recovery key.
 */
@Injectable()
export class UserKeyService {
  private readonly logger = new Logger(UserKeyService.name);
  private keys = new Map<string, Buffer>();

  constructor(private dekCache: DekCacheService) {}

  /** Synchronous memory-only lookup — used by hot paths that can't await. */
  getKey(userId: string): Buffer | undefined {
    return this.keys.get(userId);
  }

  /** 2-tier async lookup: Memory → Redis. */
  async getDek(userId: string): Promise<Buffer | null> {
    const memKey = this.keys.get(userId);
    if (memKey) return memKey;

    const redisDek = await this.dekCache.getCachedDek(userId);
    if (redisDek) {
      this.keys.set(userId, redisDek);
      return redisDek;
    }

    return null;
  }

  /** Store DEK in memory + Redis cache. */
  async storeDek(userId: string, dek: Buffer): Promise<void> {
    this.keys.set(userId, dek);
    await this.dekCache.cacheDek(userId, dek);
  }

  /** Generate a random 32-byte DEK. */
  generateDek(): Buffer {
    return randomBytes(32);
  }

  hasKey(userId: string): boolean {
    return this.keys.has(userId);
  }

  removeKey(userId: string): void {
    this.keys.delete(userId);
  }
}
