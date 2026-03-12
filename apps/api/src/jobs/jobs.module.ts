import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AccountsModule } from '../accounts/accounts.module';
import { AuthModule } from '../auth/auth.module';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';
import { SyncProcessor } from './sync.processor';
import { SchedulerService } from './scheduler.service';
import { ConfigService } from '../config/config.service';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [
    BullModule.forRootAsync({
      useFactory: (config: ConfigService) => ({
        connection: {
          url: config.redisUrl,
          maxRetriesPerRequest: null,
          enableReadyCheck: false,
          retryStrategy: (times: number) => Math.min(times * 500, 5000),
        },
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: { count: 1_000_000 },
          removeOnFail: { count: 5000, age: 7 * 24 * 3600 },
        },
      }),
      inject: [ConfigService],
    }),
    BullModule.registerQueue({ name: 'sync' }),
    BullModule.registerQueue({ name: 'clean' }),
    BullModule.registerQueue({ name: 'embed' }),
    BullModule.registerQueue({ name: 'enrich' }),
    BullModule.registerQueue({ name: 'backfill' }),
    BullModule.registerQueue({ name: 'maintenance' }),
    AccountsModule,
    forwardRef(() => AuthModule),
    SettingsModule,
  ],
  controllers: [JobsController],
  providers: [JobsService, SyncProcessor, SchedulerService],
  exports: [JobsService, SchedulerService],
})
export class JobsModule {}
