import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module';
import { DbModule } from '../db/db.module';
import { BillingService } from './billing.service';
import { BillingController } from './billing.controller';
import { QuotaService } from './quota.service';

@Module({
  imports: [ConfigModule, DbModule],
  providers: [BillingService, QuotaService],
  controllers: [BillingController],
  exports: [BillingService, QuotaService],
})
export class BillingModule {}
