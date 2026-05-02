import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import Redis from 'ioredis';
import { Public } from './user-auth/decorators/public.decorator';
import { DbService } from './db/db.service';
import { PgSearchService } from './memory/pg-search.service';
import { ConfigService } from './config/config.service';

@ApiTags('System')
@Public()
@Controller('health')
export class HealthController {
  private redis: Redis;

  constructor(
    private db: DbService,
    private searchIndex: PgSearchService,
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
    const [postgresResult, redisResult, searchIndexResult] = await Promise.allSettled([
      this.probePostgres(),
      this.probeRedis(),
      this.probeSearchIndex(),
    ]);

    return {
      status: 'ok',
      services: {
        postgres: { connected: postgresResult.status === 'fulfilled' && postgresResult.value },
        redis: { connected: redisResult.status === 'fulfilled' && redisResult.value },
        searchIndex: {
          connected: searchIndexResult.status === 'fulfilled' && searchIndexResult.value,
        },
      },
    };
  }

  private async probePostgres(): Promise<boolean> {
    try {
      return await this.db.healthCheck();
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

  private async probeSearchIndex(): Promise<boolean> {
    return this.searchIndex.healthCheck();
  }
}
