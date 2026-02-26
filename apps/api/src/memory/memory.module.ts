import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { DbModule } from '../db/db.module';
import { ConfigModule } from '../config/config.module';
import { EventsModule } from '../events/events.module';
import { ContactsModule } from '../contacts/contacts.module';
import { AccountsModule } from '../accounts/accounts.module';
import { SettingsModule } from '../settings/settings.module';
import { OllamaService } from './ollama.service';
import { QdrantService } from './qdrant.service';
import { EmbedProcessor } from './embed.processor';
import { EnrichProcessor } from './enrich.processor';
import { BackfillProcessor } from './backfill.processor';
import { FileProcessor } from './file.processor';
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
    BullModule.registerQueue({ name: 'embed' }),
    BullModule.registerQueue({ name: 'enrich' }),
    BullModule.registerQueue({ name: 'backfill' }),
    BullModule.registerQueue({ name: 'file' }),
  ],
  controllers: [MemoryController],
  providers: [
    OllamaService,
    QdrantService,
    EmbedProcessor,
    EnrichProcessor,
    BackfillProcessor,
    FileProcessor,
    MemoryService,
  ],
  exports: [OllamaService, QdrantService, MemoryService],
})
export class MemoryModule {}
