// OTel must be loaded before ANY other imports to patch http/pg.
import './tracing/otel';

import 'reflect-metadata';
import * as net from 'net';

net.setDefaultAutoSelectFamily(false);

import * as dotenv from 'dotenv';
import { resolve } from 'path';

dotenv.config({ path: resolve(__dirname, '..', '..', '..', '.env') });

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

const logger = new Logger('WorkerBootstrap');

function formatProcessError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  return String(err);
}

process.on('unhandledRejection', (reason) => {
  logger.error(`[unhandledRejection] ${formatProcessError(reason)}`);
});

process.on('uncaughtException', (err) => {
  logger.error(`[uncaughtException] ${formatProcessError(err)}`);
});

async function bootstrap() {
  process.env.BOTMEM_PROCESS_ROLE = process.env.BOTMEM_PROCESS_ROLE || 'worker';

  const app = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
  });
  app.enableShutdownHooks();
  logger.log('Botmem queue worker started');

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.log('Shutting down worker...');
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

bootstrap().catch((err) => {
  logger.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
