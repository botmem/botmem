import 'dotenv/config';
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { NestFactory } from '@nestjs/core';
import { Queue } from 'bullmq';
import { AccountsService } from '../accounts/accounts.service';
import { AnalyticsModule } from '../analytics/analytics.module';
import { ConfigModule } from '../config/config.module';
import { ConfigService } from '../config/config.service';
import { ConnectorsService } from '../connectors/connectors.service';
import { ConnectorsModule } from '../connectors/connectors.module';
import { CryptoModule } from '../crypto/crypto.module';
import { DbModule } from '../db/db.module';
import { PgSearchService } from '../memory/pg-search.service';
import { PeopleService } from '../people/people.service';
import { PeoplePipelineService } from '../people/people-pipeline.service';

@Module({
  imports: [
    ConfigModule,
    AnalyticsModule,
    DbModule,
    CryptoModule,
    ConnectorsModule,
    BullModule.forRootAsync({
      useFactory: (config: ConfigService) => ({
        connection: { url: config.redisUrl, maxRetriesPerRequest: null },
      }),
      inject: [ConfigService],
    }),
    BullModule.registerQueue({ name: 'sync' }),
  ],
  providers: [AccountsService, PgSearchService, PeopleService, PeoplePipelineService],
})
class PeoplePipelineCliModule {}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function numberArg(name: string): number | undefined {
  const prefix = `${name}=`;
  const value = process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

async function main() {
  const app = await NestFactory.createApplicationContext(PeoplePipelineCliModule, {
    logger: ['log', 'warn', 'error'],
  });
  try {
    const config = app.get(ConfigService);
    const connectors = app.get(ConnectorsService);
    await registerBuiltInConnectors(connectors);
    const pipeline = app.get(PeoplePipelineService);
    const memoryQueue = new Queue('memory', {
      connection: { url: config.redisUrl, maxRetriesPerRequest: null },
    });
    await memoryQueue.pause();
    console.log(`memory queue paused=${await memoryQueue.isPaused()}`);
    await memoryQueue.close();

    const result = await pipeline.rebuildFromExistingData({
      reset: hasFlag('--reset'),
      limit: numberArg('--limit'),
    });
    const validation = await pipeline.validateNoNameOnlyPeople();
    console.log(JSON.stringify({ result, validation }, null, 2));
  } finally {
    await app.close();
  }
}

async function registerBuiltInConnectors(connectors: ConnectorsService) {
  for (const packageName of [
    '@botmem/connector-photos-immich',
    '@botmem/connector-gmail',
    '@botmem/connector-slack',
    '@botmem/connector-whatsapp',
    '@botmem/connector-telegram',
    '@botmem/connector-imessage',
    '@botmem/connector-locations',
    '@botmem/connector-outlook',
  ]) {
    const mod = await import(packageName);
    const factory = mod.default || mod.createConnector;
    if (typeof factory !== 'function') {
      throw new Error(`Connector package ${packageName} does not export a factory`);
    }
    connectors.register(factory);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
