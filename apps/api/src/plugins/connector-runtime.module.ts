import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { IngestionModule } from '../ingestion/ingestion.module';
import { ConnectorRuntimeService } from './connector-runtime.service';

@Module({
  imports: [BullModule.registerQueue({ name: 'memory' }), IngestionModule],
  providers: [ConnectorRuntimeService],
})
export class ConnectorRuntimeModule {}
