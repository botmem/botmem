import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { DbModule } from '../db/db.module';
import { ConfigModule } from '../config/config.module';
import { EventsModule } from '../events/events.module';
import { ContactsModule } from '../contacts/contacts.module';
import { AccountsModule } from '../accounts/accounts.module';
import { SettingsModule } from '../settings/settings.module';
import { JobsModule } from '../jobs/jobs.module';
import { OllamaService } from './ollama.service';
import { QdrantService } from './qdrant.service';
import { EnrichService } from './enrich.service';
import { CleanProcessor } from './clean.processor';
import { EmbedProcessor } from './embed.processor';
import { EnrichProcessor } from './enrich.processor';
import { BackfillProcessor } from './backfill.processor';
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
    forwardRef(() => JobsModule),
    BullModule.registerQueue({ name: 'clean' }),
    BullModule.registerQueue({ name: 'embed' }),
    BullModule.registerQueue({ name: 'enrich' }),
    BullModule.registerQueue({ name: 'backfill' }),
    BullModule.registerQueue({ name: 'maintenance' }),
  ],
  controllers: [MemoryController],
  providers: [
    OllamaService,
    QdrantService,
    EnrichService,
    CleanProcessor,
    EmbedProcessor,
    EnrichProcessor,
    BackfillProcessor,
    DecayProcessor,
    MemoryService,
  ],
  exports: [OllamaService, QdrantService, EnrichService, MemoryService],
})
export class MemoryModule {}
