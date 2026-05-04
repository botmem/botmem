import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import type { ConnectorDataEvent } from '@botmem/connector-sdk';
import { CryptoService } from '../crypto/crypto.service';
import { DbService } from '../db/db.service';
import { rawEvents } from '../db/schema';
import { rawEventSourceHash } from '../db/raw-event-source-hash';

export interface RawEventIngestInput {
  accountId: string;
  connectorType: string;
  event: ConnectorDataEvent;
  jobId?: string | null;
  userId?: string | null;
  trace?: { traceId: string; spanId: string };
}

export interface RawEventIngestResult {
  inserted: boolean;
  rawEventId: string;
}

@Injectable()
export class RawEventIngestService {
  constructor(
    private dbService: DbService,
    private crypto: CryptoService,
    @InjectQueue('memory') private memoryQueue: Queue,
  ) {}

  async ingest(input: RawEventIngestInput): Promise<RawEventIngestResult> {
    const rawEventId = randomUUID();
    const now = new Date();
    const sourceHash = rawEventSourceHash(
      input.accountId,
      input.connectorType,
      input.event.sourceId,
    );

    const insert = async (db: typeof this.dbService.db) =>
      db
        .insert(rawEvents)
        .values({
          id: rawEventId,
          accountId: input.accountId,
          connectorType: input.connectorType,
          sourceId: input.event.sourceId,
          sourceHash,
          sourceType: input.event.sourceType,
          payload: this.crypto.encrypt(JSON.stringify(input.event))!,
          timestamp: new Date(input.event.timestamp),
          jobId: input.jobId ?? null,
          createdAt: now,
        })
        .onConflictDoNothing({ target: rawEvents.sourceHash })
        .returning({ id: rawEvents.id });

    const inserted = input.userId
      ? await this.dbService.withUserId(input.userId, insert)
      : await insert(this.dbService.db);

    if (inserted.length === 0) {
      return { inserted: false, rawEventId };
    }

    await this.memoryQueue.add(
      'process',
      {
        rawEventId,
        ...(input.trace ? { _trace: input.trace } : {}),
      },
      { attempts: 5, backoff: { type: 'exponential', delay: 5000 } },
    );

    return { inserted: true, rawEventId };
  }
}
