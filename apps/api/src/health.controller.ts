import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import Redis from 'ioredis';
import { Public } from './user-auth/decorators/public.decorator';
import { DbService } from './db/db.service';
import { TypesenseService } from './memory/typesense.service';
import { ConfigService } from './config/config.service';

@ApiTags('System')
@Public()
@Controller('health')
export class HealthController {
  private redis: Redis;

  constructor(
    private db: DbService,
    private typesense: TypesenseService,
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
    const [postgresResult, redisResult, typesenseResult] = await Promise.allSettled([
      this.probePostgres(),
      this.probeRedis(),
      this.probeTypesense(),
    ]);

    return {
      status: 'ok',
      services: {
        postgres: { connected: postgresResult.status === 'fulfilled' && postgresResult.value },
        redis: { connected: redisResult.status === 'fulfilled' && redisResult.value },
        typesense: { connected: typesenseResult.status === 'fulfilled' && typesenseResult.value },
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

  private async probeTypesense(): Promise<boolean> {
    return this.typesense.healthCheck();
  }
}
