import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '../config/config.module';
import { DbModule } from '../db/db.module';
import { BillingService } from './billing.service';
import { BillingController } from './billing.controller';
import { QuotaService } from './quota.service';

@Module({
  imports: [ConfigModule, DbModule, BullModule.registerQueue({ name: 'memory' })],
  providers: [BillingService, QuotaService],
  controllers: [BillingController],
  exports: [BillingService, QuotaService],
})
export class BillingModule {}
