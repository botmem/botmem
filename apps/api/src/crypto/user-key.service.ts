import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { DekCacheService } from './dek-cache.service';

const DEK_TTL_MS = 60 * 60 * 1000; // 1 hour of inactivity

interface DekEntry {
  key: Buffer;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * 2-tier DEK management: Memory → Redis.
 * Keys are random 32-byte DEKs shown to user as recovery key at signup.
 * No DB tier — if both caches are cold, user must re-enter recovery key.
 *
 * Memory-tier entries are evicted after 1 hour of inactivity.
 * On eviction the Buffer is zeroed before deletion.
 */
@Injectable()
export class UserKeyService implements OnModuleDestroy {
  private readonly logger = new Logger(UserKeyService.name);
  private keys = new Map<string, DekEntry>();

  constructor(private dekCache: DekCacheService) {}

  onModuleDestroy() {
    // Zero and clear all keys on shutdown
    for (const [userId] of this.keys) {
      this.evict(userId);
    }
  }

  /** Synchronous memory-only lookup — used by hot paths that can't await. */
  getKey(userId: string): Buffer | undefined {
    const entry = this.keys.get(userId);
    if (entry) {
      this.resetTimer(userId, entry);
      return entry.key;
    }
    return undefined;
  }

  /** 2-tier async lookup: Memory → Redis. */
  async getDek(userId: string): Promise<Buffer | null> {
    const entry = this.keys.get(userId);
    if (entry) {
      this.resetTimer(userId, entry);
      return entry.key;
    }

    const redisDek = await this.dekCache.getCachedDek(userId);
    if (redisDek) {
      this.setWithTimer(userId, redisDek);
      return redisDek;
    }

    return null;
  }

  /** Store DEK in memory + Redis cache. */
  async storeDek(userId: string, dek: Buffer): Promise<void> {
    // Evict old entry if present (zeros the old buffer)
    this.evict(userId);
    this.setWithTimer(userId, dek);
    await this.dekCache.cacheDek(userId, dek);
  }

  /** Generate a random 32-byte DEK. */
  generateDek(): Buffer {
    return randomBytes(32);
  }

  hasKey(userId: string): boolean {
    return this.keys.has(userId);
  }

  /** Remove key from memory, zeroing the buffer. */
  removeKey(userId: string): void {
    this.evict(userId);
  }

  // --- internal helpers ---

  private setWithTimer(userId: string, key: Buffer): void {
    const timer = setTimeout(() => this.evict(userId), DEK_TTL_MS);
    timer.unref(); // don't keep process alive for TTL timers
    this.keys.set(userId, { key, timer });
  }

  private resetTimer(userId: string, entry: DekEntry): void {
    clearTimeout(entry.timer);
    const timer = setTimeout(() => this.evict(userId), DEK_TTL_MS);
    timer.unref();
    entry.timer = timer;
  }

  private evict(userId: string): void {
    const entry = this.keys.get(userId);
    if (entry) {
      clearTimeout(entry.timer);
      entry.key.fill(0); // zero the key material before releasing
      this.keys.delete(userId);
    }
  }
}
