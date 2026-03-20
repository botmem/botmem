import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { DbModule } from '../db/db.module';
import { ConfigModule } from '../config/config.module';
import { EventsModule } from '../events/events.module';
import { PeopleModule } from '../people/people.module';
import { AccountsModule } from '../accounts/accounts.module';
import { SettingsModule } from '../settings/settings.module';
import { CryptoModule } from '../crypto/crypto.module';
import { JobsModule } from '../jobs/jobs.module';
import { GeoModule } from '../geo/geo.module';
import { OllamaService } from './ollama.service';
import { OpenRouterService } from './openrouter.service';
import { AiCacheService } from './ai-cache.service';
import { AiService } from './ai.service';
import { GeminiEmbedService } from './gemini-embed.service';
import { RerankService } from './rerank.service';
import { TypesenseService } from './typesense.service';
import { EnrichService } from './enrich.service';
import { CleanProcessor } from './clean.processor';
import { EmbedProcessor } from './embed.processor';
import { EnrichProcessor } from './enrich.processor';
import { DecayProcessor } from './decay.processor';
import { MemoryService } from './memory.service';
import { MemoryController } from './memory.controller';

@Module({
  imports: [
    DbModule,
    ConfigModule,
    EventsModule,
    PeopleModule,
    AccountsModule,
    SettingsModule,
    CryptoModule,
    GeoModule,
    forwardRef(() => JobsModule),
    BullModule.registerQueue({ name: 'clean' }),
    BullModule.registerQueue({ name: 'embed' }),
    BullModule.registerQueue({
      name: 'enrich',
      defaultJobOptions: {
        attempts: 48,
        backoff: { type: 'exponential', delay: 30000 },
      },
    }),
    BullModule.registerQueue({ name: 'maintenance' }),
  ],
  controllers: [MemoryController],
  providers: [
    OllamaService,
    OpenRouterService,
    GeminiEmbedService,
    AiCacheService,
    RerankService,
    AiService,
    TypesenseService,
    EnrichService,
    CleanProcessor,
    EmbedProcessor,
    EnrichProcessor,
    DecayProcessor,
    MemoryService,
  ],
  exports: [
    OllamaService,
    AiService,
    RerankService,
    TypesenseService,
    EnrichService,
    MemoryService,
  ],
})
export class MemoryModule {}
