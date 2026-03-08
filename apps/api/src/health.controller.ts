import { Controller, Get } from '@nestjs/common';
import Redis from 'ioredis';
import { Public } from './user-auth/decorators/public.decorator';
import { DbService } from './db/db.service';
import { QdrantService } from './memory/qdrant.service';
import { ConfigService } from './config/config.service';

@Public()
@Controller('health')
export class HealthController {
  private redis: Redis;

  constructor(
    private db: DbService,
    private qdrant: QdrantService,
    private config: ConfigService,
  ) {
    this.redis = new Redis(this.config.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
    });
  }

  @Get()
  async getHealth() {
    const [sqliteResult, redisResult, qdrantResult] = await Promise.allSettled([
      this.probeSqlite(),
      this.probeRedis(),
      this.probeQdrant(),
    ]);

    return {
      status: 'ok',
      services: {
        sqlite: { connected: sqliteResult.status === 'fulfilled' && sqliteResult.value },
        redis: { connected: redisResult.status === 'fulfilled' && redisResult.value },
        qdrant: { connected: qdrantResult.status === 'fulfilled' && qdrantResult.value },
      },
    };
  }

  private async probeSqlite(): Promise<boolean> {
    try {
      this.db.sqlite.prepare('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }

  private async probeRedis(): Promise<boolean> {
    try {
      await this.redis.ping();
      return true;
    } catch {
      return false;
    }
  }

  private async probeQdrant(): Promise<boolean> {
    return this.qdrant.healthCheck();
  }
}
