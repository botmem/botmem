import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { DbModule } from '../db/db.module';
import { ConfigModule } from '../config/config.module';
import { EventsModule } from '../events/events.module';
import { PeopleModule } from '../people/people.module';
import { AccountsModule } from '../accounts/accounts.module';
import { SettingsModule } from '../settings/settings.module';
import { CryptoModule } from '../crypto/crypto.module';
import { JobsModule, JobsWorkerModule } from '../jobs/jobs.module';
import { BillingModule } from '../billing/billing.module';
import { GeoModule } from '../geo/geo.module';
import { OllamaService } from './ollama.service';
import { OpenRouterService } from './openrouter.service';
import { AiCacheService } from './ai-cache.service';
import { AiService } from './ai.service';
import { GeminiEmbedService } from './gemini-embed.service';
import { PgSearchService } from './pg-search.service';
import { EnrichService } from './enrich.service';
import { ContentCleaner } from './content-cleaner';
import { DecayProcessor } from './decay.processor';
import { MemoryProcessor } from './memory.processor';
import { MemoryService } from './memory.service';
import { MemoryController } from './memory.controller';
import { RawEventPipelineClassifier } from './raw-event-pipeline-classifier.service';

const memoryBaseImports = [
  DbModule,
  ConfigModule,
  EventsModule,
  PeopleModule,
  AccountsModule,
  SettingsModule,
  CryptoModule,
  GeoModule,
  BillingModule,
  BullModule.registerQueue({ name: 'memory' }),
  BullModule.registerQueue({ name: 'maintenance' }),
];

const memoryCommonProviders = [
  OllamaService,
  OpenRouterService,
  GeminiEmbedService,
  AiCacheService,
  AiService,
  PgSearchService,
  EnrichService,
  ContentCleaner,
  MemoryService,
  RawEventPipelineClassifier,
];

@Module({
  imports: [...memoryBaseImports, forwardRef(() => JobsModule)],
  controllers: [MemoryController],
  providers: memoryCommonProviders,
  exports: [OllamaService, AiService, PgSearchService, EnrichService, MemoryService],
})
export class MemoryModule {}

@Module({
  imports: [...memoryBaseImports, forwardRef(() => JobsWorkerModule)],
  providers: [...memoryCommonProviders, DecayProcessor, MemoryProcessor],
  exports: [OllamaService, AiService, PgSearchService, EnrichService, MemoryService],
})
export class MemoryWorkerModule {}
