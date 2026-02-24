import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AccountsModule } from '../accounts/accounts.module';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';
import { SyncProcessor } from './sync.processor';
import { SchedulerService } from './scheduler.service';
import { ConfigService } from '../config/config.service';

@Module({
  imports: [
    BullModule.forRootAsync({
      useFactory: (config: ConfigService) => ({
        connection: { url: config.redisUrl },
      }),
      inject: [ConfigService],
    }),
    BullModule.registerQueue({ name: 'sync' }),
    BullModule.registerQueue({ name: 'embed' }),
    BullModule.registerQueue({ name: 'enrich' }),
    BullModule.registerQueue({ name: 'backfill' }),
    AccountsModule,
  ],
  controllers: [JobsController],
  providers: [JobsService, SyncProcessor, SchedulerService],
  exports: [JobsService, SchedulerService],
})
export class JobsModule {}
