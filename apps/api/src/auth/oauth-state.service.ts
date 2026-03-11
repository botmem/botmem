import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { ConfigService } from '../config/config.service';

const PENDING_TTL = 600; // 10 minutes
const LOCK_TTL = 30; // 30 seconds

export interface OAuthPendingConfig {
  config: Record<string, unknown>;
  returnTo?: string;
  userId?: string;
}

@Injectable()
export class OAuthStateService implements OnModuleDestroy {
  private readonly logger = new Logger(OAuthStateService.name);
  private redis: Redis;

  constructor(private configService: ConfigService) {
    this.redis = new Redis(this.configService.redisUrl, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
    });
    this.redis.connect().catch((err) => {
      this.logger.warn(`Redis OAuth state connection failed: ${err.message}`);
    });
  }

  onModuleDestroy() {
    this.redis.disconnect();
  }

  async savePendingConfig(stateToken: string, data: OAuthPendingConfig): Promise<void> {
    try {
      await this.redis.set(`oauth:pending:${stateToken}`, JSON.stringify(data), 'EX', PENDING_TTL);
    } catch (err) {
      this.logger.warn(
        `Failed to save OAuth state: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async getPendingConfig(stateToken: string): Promise<OAuthPendingConfig | null> {
    try {
      const raw = await this.redis.get(`oauth:pending:${stateToken}`);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (err) {
      this.logger.warn(
        `Failed to get OAuth state: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  async deletePendingConfig(stateToken: string): Promise<void> {
    try {
      await this.redis.del(`oauth:pending:${stateToken}`);
    } catch (err) {
      this.logger.warn(
        `Failed to delete OAuth state: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async acquireCreateLock(key: string): Promise<boolean> {
    try {
      const result = await this.redis.set(`oauth:lock:${key}`, '1', 'EX', LOCK_TTL, 'NX');
      return result === 'OK';
    } catch (err) {
      this.logger.warn(
        `Failed to acquire lock: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  async releaseCreateLock(key: string): Promise<void> {
    try {
      await this.redis.del(`oauth:lock:${key}`);
    } catch (err) {
      this.logger.warn(
        `Failed to release lock: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
