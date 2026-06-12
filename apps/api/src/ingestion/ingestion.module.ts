import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { CryptoModule } from '../crypto/crypto.module';
import { BlobStoreService } from '../blob/blob-store.service';
import { DbModule } from '../db/db.module';
import { RawEventIngestService } from './raw-event-ingest.service';

@Global()
@Module({
  imports: [DbModule, CryptoModule, BullModule.registerQueue({ name: 'memory' })],
  providers: [BlobStoreService, RawEventIngestService],
  exports: [BlobStoreService, RawEventIngestService],
})
export class IngestionModule {}
