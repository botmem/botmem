import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { ConfigService } from '../config/config.service';
import { CryptoService } from './crypto.service';

const DEK_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

@Injectable()
export class DekCacheService implements OnModuleDestroy {
  private readonly logger = new Logger(DekCacheService.name);
  private redis: Redis;

  constructor(
    private config: ConfigService,
    private crypto: CryptoService,
  ) {
    this.redis = new Redis(this.config.redisUrl, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
    });
    this.redis.connect().catch((err) => {
      this.logger.warn(`Redis DEK cache connection failed: ${err.message}`);
    });
  }

  onModuleDestroy() {
    this.redis.disconnect();
  }

  /**
   * Cache a DEK in Redis, encrypted with APP_SECRET.
   */
  async cacheDek(userId: string, dek: Buffer, ttl = DEK_TTL_SECONDS): Promise<void> {
    try {
      const encrypted = this.crypto.encrypt(dek.toString('base64'));
      if (encrypted) {
        await this.redis.set(`dek:${userId}`, encrypted, 'EX', ttl);
      }
    } catch (err) {
      this.logger.warn(
        `Failed to cache DEK for ${userId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Retrieve and decrypt a cached DEK from Redis.
   */
  async getCachedDek(userId: string): Promise<Buffer | null> {
    try {
      const encrypted = await this.redis.get(`dek:${userId}`);
      if (!encrypted) return null;
      const decrypted = this.crypto.decrypt(encrypted);
      if (!decrypted) return null;
      return Buffer.from(decrypted, 'base64');
    } catch (err) {
      this.logger.warn(
        `Failed to get cached DEK for ${userId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Remove a cached DEK from Redis.
   */
  async removeDek(userId: string): Promise<void> {
    try {
      await this.redis.del(`dek:${userId}`);
    } catch (err) {
      this.logger.warn(
        `Failed to remove DEK for ${userId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
