import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { DbModule } from '../db/db.module';
import { ConfigModule } from '../config/config.module';
import { EventsModule } from '../events/events.module';
import { ContactsModule } from '../contacts/contacts.module';
import { AccountsModule } from '../accounts/accounts.module';
import { SettingsModule } from '../settings/settings.module';
import { CryptoModule } from '../crypto/crypto.module';
import { JobsModule } from '../jobs/jobs.module';
import { OllamaService } from './ollama.service';
import { OpenRouterService } from './openrouter.service';
import { AiCacheService } from './ai-cache.service';
import { AiService } from './ai.service';
import { RerankService } from './rerank.service';
import { QdrantService } from './qdrant.service';
import { EnrichService } from './enrich.service';
import { CleanProcessor } from './clean.processor';
import { EmbedProcessor } from './embed.processor';
import { EnrichProcessor } from './enrich.processor';
import { BackfillProcessor } from './backfill.processor';
import { ReencryptProcessor } from './reencrypt.processor';
import { DecayProcessor } from './decay.processor';
import { MemoryService } from './memory.service';
import { MemoryController } from './memory.controller';

@Module({
  imports: [
    DbModule,
    ConfigModule,
    EventsModule,
    ContactsModule,
    AccountsModule,
    SettingsModule,
    CryptoModule,
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
    BullModule.registerQueue({ name: 'backfill' }),
    BullModule.registerQueue({ name: 'maintenance' }),
    BullModule.registerQueue({ name: 'reencrypt' }),
  ],
  controllers: [MemoryController],
  providers: [
    OllamaService,
    OpenRouterService,
    AiCacheService,
    RerankService,
    AiService,
    QdrantService,
    EnrichService,
    CleanProcessor,
    EmbedProcessor,
    EnrichProcessor,
    BackfillProcessor,
    ReencryptProcessor,
    DecayProcessor,
    MemoryService,
  ],
  exports: [OllamaService, AiService, RerankService, QdrantService, EnrichService, MemoryService],
})
export class MemoryModule {}
