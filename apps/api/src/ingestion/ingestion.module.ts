import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { CryptoModule } from '../crypto/crypto.module';
import { DbModule } from '../db/db.module';
import { RawEventIngestService } from './raw-event-ingest.service';

@Global()
@Module({
  imports: [DbModule, CryptoModule, BullModule.registerQueue({ name: 'memory' })],
  providers: [RawEventIngestService],
  exports: [RawEventIngestService],
})
export class IngestionModule {}
