import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import type { ConnectorDataEvent } from '@botmem/connector-sdk';
import { BlobStoreService } from '../blob/blob-store.service';
import { CryptoService } from '../crypto/crypto.service';
import { DbService } from '../db/db.service';
import { rawEvents } from '../db/schema';
import { rawEventSourceHash } from '../db/raw-event-source-hash';
import { canonicalConnectorType } from '../connectors/canonical-connector-type';

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
    private blobStore: BlobStoreService,
  ) {}

  async ingest(input: RawEventIngestInput): Promise<RawEventIngestResult> {
    const rawEventId = randomUUID();
    const now = new Date();
    const event = await this.offloadInlineMedia(input.event);
    const connectorType = canonicalConnectorType(input.connectorType);
    const sourceHash = rawEventSourceHash(input.accountId, connectorType, input.event.sourceId);

    const insert = async (db: typeof this.dbService.db) =>
      db
        .insert(rawEvents)
        .values({
          id: rawEventId,
          accountId: input.accountId,
          connectorType,
          sourceId: event.sourceId,
          sourceHash,
          sourceType: event.sourceType,
          payload: this.crypto.encrypt(JSON.stringify(event))!,
          timestamp: new Date(event.timestamp),
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

  private async offloadInlineMedia(event: ConnectorDataEvent): Promise<ConnectorDataEvent> {
    const copy = JSON.parse(JSON.stringify(event)) as ConnectorDataEvent;
    await this.offloadInlineMediaInValue(copy);
    return copy;
  }

  private async offloadInlineMediaInValue(value: unknown): Promise<void> {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) await this.offloadInlineMediaInValue(item);
      return;
    }

    const node = value as Record<string, unknown>;
    const fileBase64 = node.fileBase64;
    if (typeof fileBase64 === 'string' && fileBase64) {
      // ponytail: generic JSON walk is enough for connector event payloads; use a schema visitor if payloads become huge.
      const mime = this.firstString(node.mimetype, node.mimeType, node.fileMimeType, node.mime);
      const fileName = this.firstString(node.fileName, node.filename);
      const stored = await this.blobStore.put(Buffer.from(fileBase64, 'base64'), mime);
      delete node.fileBase64;
      Object.assign(node, {
        blobRef: stored.ref,
        ...(mime ? { mime } : {}),
        ...(fileName ? { fileName } : {}),
        size: stored.size,
      });
    }

    for (const child of Object.values(node)) await this.offloadInlineMediaInValue(child);
  }

  private firstString(...values: unknown[]): string | undefined {
    return values.find((value): value is string => typeof value === 'string' && value !== '');
  }
}
