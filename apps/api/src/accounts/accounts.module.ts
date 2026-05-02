import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AccountsController } from './accounts.controller';
import { AccountsService } from './accounts.service';
import { ConfigModule } from '../config/config.module';
import { PgSearchService } from '../memory/pg-search.service';
import { DbModule } from '../db/db.module';

@Module({
  imports: [ConfigModule, DbModule, BullModule.registerQueue({ name: 'sync' })],
  controllers: [AccountsController],
  providers: [AccountsService, PgSearchService],
  exports: [AccountsService],
})
export class AccountsModule {}
