import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { CryptoService } from '../crypto/crypto.service';
import { UserKeyService } from '../crypto/user-key.service';
import { AiService } from './ai.service';
import { ContentCleaner } from './content-cleaner';
import { TypesenseService } from './typesense.service';
import { EnrichService } from './enrich.service';
import { ConfigService } from '../config/config.service';
import { memories, memoryLinks } from '../db/schema';

const BATCH_SIZE = 5000;

export interface MigrationProgress {
  status: 'idle' | 'running' | 'completed' | 'failed';
  total: number;
  processed: number;
  cached: number;
  reembedded: number;
  cleaned: number;
  enriched: number;
  corroborated: number;
  errors: number;
  startedAt: string | null;
  completedAt: string | null;
  currentBatch: number;
  errorSamples: string[];
}

@Injectable()
export class MigrationService {
  private readonly logger = new Logger(MigrationService.name);
  private progress: MigrationProgress = this.emptyProgress();

  constructor(
    private db: DbService,
    private crypto: CryptoService,
    private userKeyService: UserKeyService,
    private ai: AiService,
    private contentCleaner: ContentCleaner,
    private typesense: TypesenseService,
    private enrichService: EnrichService,
    private config: ConfigService,
    @InjectQueue('memory') private memoryQueue: Queue,
  ) {}

  private emptyProgress(): MigrationProgress {
    return {
      status: 'idle',
      total: 0,
      processed: 0,
      cached: 0,
      reembedded: 0,
      cleaned: 0,
      enriched: 0,
      corroborated: 0,
      errors: 0,
      startedAt: null,
      completedAt: null,
      currentBatch: 0,
      errorSamples: [],
    };
  }

  getProgress(): MigrationProgress {
    return { ...this.progress };
  }

  async startMigration(
    userId: string,
    _force = false,
  ): Promise<{ started: boolean; message: string }> {
    if (this.progress.status === 'running') {
      return {
        started: false,
        message: `Migration already running (${this.progress.processed}/${this.progress.total})`,
      };
    }

    // Get user DEK for decryption
    const userKey = await this.userKeyService.getDek(userId);
    if (!userKey) {
      return {
        started: false,
        message: 'Recovery key required. Submit via POST /user-auth/recovery-key first.',
      };
    }

    // Count total memories
    const [{ count }] = await this.db.db
      .select({ count: sql<number>`count(*)::int` })
      .from(memories)
      .where(eq(memories.accountId, sql`ANY(SELECT id FROM accounts WHERE user_id = ${userId})`));

    this.progress = {
      ...this.emptyProgress(),
      status: 'running',
      total: count,
      startedAt: new Date().toISOString(),
    };

    // Run migration in background
    this.runMigration(userId, userKey).catch((err) => {
      this.logger.error(`Migration failed: ${err.message}`);
      this.progress.status = 'failed';
      this.progress.errorSamples.push(err.message);
    });

    return { started: true, message: `Migration started for ${count} memories` };
  }

  private async runMigration(userId: string, userKey: Buffer): Promise<void> {
    const db = this.db.db;
    let lastId = '';
    let batchNum = 0;

    this.logger.log(`[migration] Starting full re-process of ${this.progress.total} memories`);

    for (;;) {
      batchNum++;
      this.progress.currentBatch = batchNum;

      // Cursor-based pagination — O(1) instead of O(offset) for Postgres
      const batch = await db
        .select({
          id: memories.id,
          text: memories.text,
          metadata: memories.metadata,
          entities: memories.entities,
          sourceType: memories.sourceType,
          connectorType: memories.connectorType,
          eventTime: memories.eventTime,
          accountId: memories.accountId,
          sourceId: memories.sourceId,
          weights: memories.weights,
          recallCount: memories.recallCount,
          pinned: memories.pinned,
          factuality: memories.factuality,
          factualityLabel: memories.factualityLabel,
          memoryBankId: memories.memoryBankId,
        })
        .from(memories)
        .where(sql`${memories.id} > ${lastId}`)
        .orderBy(memories.id)
        .limit(BATCH_SIZE);

      if (!batch.length) break;
      lastId = batch[batch.length - 1].id;

      // Process batch with controlled concurrency (use API limits from config)
      const concurrency = this.config.aiConcurrency.embed;
      const chunks = this.chunkArray(batch, concurrency);
      for (const chunk of chunks) {
        await Promise.all(
          chunk.map((mem) =>
            this.processSingleMemory(mem, userKey).catch((err) => {
              this.progress.errors++;
              if (this.progress.errorSamples.length < 10) {
                this.progress.errorSamples.push(`${mem.id.slice(0, 8)}: ${err.message}`);
              }
              this.logger.warn(`[migration] ${mem.id.slice(0, 8)} failed: ${err.message}`);
            }),
          ),
        );
      }

      // cursor advances via lastId
      this.logger.log(
        `[migration] Batch ${batchNum}: ${this.progress.processed}/${this.progress.total} ` +
          `(cached=${this.progress.cached}, reembedded=${this.progress.reembedded}, errors=${this.progress.errors})`,
      );
    }

    // Phase 2: Run corroboration on all memories with supports links
    this.logger.log('[migration] Phase 2: Running factuality corroboration...');
    await this.runCorroboration(userId);

    this.progress.status = 'completed';
    this.progress.completedAt = new Date().toISOString();
    this.logger.log(
      `[migration] Complete: ${this.progress.processed} processed, ` +
        `${this.progress.cached} cached, ${this.progress.reembedded} reembedded, ` +
        `${this.progress.corroborated} corroborated, ${this.progress.errors} errors`,
    );
  }

  private async processSingleMemory(
    mem: {
      id: string;
      text: string;
      metadata: string;
      entities: string;
      sourceType: string;
      connectorType: string;
      eventTime: Date;
      accountId: string | null;
      sourceId: string;
      weights: unknown;
      recallCount: number;
      pinned: boolean;
      factuality: string;
      factualityLabel: string | null;
      memoryBankId: string | null;
    },
    userKey: Buffer,
  ): Promise<void> {
    const db = this.db.db;

    // 1. Decrypt
    let plainText: string;
    try {
      plainText = this.crypto.decryptWithKey(mem.text, userKey) ?? mem.text ?? '';
    } catch {
      plainText = mem.text ?? '';
    }

    let plainMetadata: Record<string, unknown> = {};
    try {
      if (mem.metadata) {
        const decrypted = this.crypto.decryptWithKey(mem.metadata, userKey) ?? mem.metadata;
        plainMetadata = decrypted ? JSON.parse(decrypted) : {};
      }
    } catch {
      plainMetadata = {};
    }

    // Skip contact/group source types
    if (mem.sourceType === 'contact' || mem.sourceType === 'group') {
      this.progress.processed++;
      return;
    }

    // 2. Re-parse files if applicable
    const hasFile = plainMetadata.fileUrl || plainMetadata.fileBase64;
    const fileMime = (plainMetadata.mimetype as string) || '';
    if (
      hasFile &&
      mem.sourceType === 'file' &&
      (fileMime === 'application/pdf' ||
        fileMime.includes('word') ||
        fileMime.includes('spreadsheet') ||
        fileMime.includes('document'))
    ) {
      try {
        let fileBuffer: Buffer | null = null;
        if (plainMetadata.fileBase64) {
          fileBuffer = Buffer.from(plainMetadata.fileBase64 as string, 'base64');
        } else if (plainMetadata.fileUrl) {
          const res = await fetch(plainMetadata.fileUrl as string, {
            signal: AbortSignal.timeout(30_000),
          });
          if (res.ok) {
            fileBuffer = Buffer.from(await res.arrayBuffer());
          }
        }
        if (fileBuffer) {
          const parsed = await this.contentCleaner.parseFile(fileBuffer, fileMime);
          if (parsed) plainText = parsed;
        }
      } catch {
        // Keep original text on file parse failure
      }
    }

    // 3. Clean text
    const cleanedText = this.contentCleaner.cleanText(plainText, mem.sourceType, mem.connectorType);
    if (!cleanedText) {
      this.progress.processed++;
      return;
    }

    const textChanged = cleanedText !== plainText;
    if (textChanged) this.progress.cleaned++;

    // Fast path: text unchanged — skip re-embed, re-enrich, DB update, Typesense upsert
    if (!textChanged) {
      this.progress.cached++;
      this.progress.processed++;
      return;
    }

    // 4. Re-embed — only needed when text changed
    let vector: number[];
    try {
      if (mem.sourceType === 'photo' && this.config.embedBackend === 'gemini') {
        // Photo multimodal embeddings use image bytes, not text — keep existing
        vector = [];
      } else {
        vector = await this.ai.embed(cleanedText);
        this.progress.reembedded++;
      }
    } catch (err) {
      this.logger.warn(`[migration] ${mem.id.slice(0, 8)} embed failed: ${(err as Error).message}`);
      this.progress.errors++;
      this.progress.processed++;
      return;
    }

    // 5. Re-enrich (emails/documents only, uses LLM cache)
    let entitiesJson = '[]';
    try {
      if (mem.entities) {
        entitiesJson = this.crypto.decryptWithKey(mem.entities, userKey) ?? mem.entities ?? '[]';
      }
    } catch {
      /* keep default */
    }

    let factualityJson: string | null = null;
    try {
      if (mem.factuality) {
        factualityJson = this.crypto.decryptWithKey(mem.factuality, userKey) ?? mem.factuality;
      }
    } catch {
      /* keep null */
    }
    let factualityLabel = mem.factualityLabel;

    if (textChanged && (mem.sourceType === 'email' || mem.sourceType === 'document')) {
      try {
        const enrichResult = await this.enrichService.enrichInline({
          text: cleanedText,
          sourceType: mem.sourceType,
          connectorType: mem.connectorType,
          metadata: plainMetadata,
        });
        if (enrichResult.entities?.length) {
          entitiesJson = JSON.stringify(enrichResult.entities);
        }
        if (enrichResult.factuality) {
          factualityJson = JSON.stringify(enrichResult.factuality);
          factualityLabel = enrichResult.factuality.label;
        }
        this.progress.enriched++;
      } catch {
        // Keep existing entities/factuality on enrich failure
      }
    }

    // 6. Re-encrypt + update
    const encrypted = this.crypto.encryptMemoryFieldsWithKey(
      {
        text: cleanedText,
        entities: entitiesJson,
        claims: '[]',
        metadata: JSON.stringify(plainMetadata),
      },
      userKey,
    );

    await db
      .update(memories)
      .set({
        text: encrypted.text,
        entities: encrypted.entities,
        metadata: encrypted.metadata,
        factuality: factualityJson
          ? this.crypto.encryptWithKey(factualityJson, userKey)!
          : mem.factuality,
        ...(factualityLabel ? { factualityLabel } : {}),
        pipelineComplete: true,
        searchTokens: sql`to_tsvector('english', ${cleanedText})`,
      })
      .where(eq(memories.id, mem.id));

    // 7. Upsert to Typesense (if we have a vector)
    if (vector.length > 0) {
      const peopleNames: string[] = [];
      // Extract people from metadata if available
      if (plainMetadata.participants) {
        for (const p of plainMetadata.participants as Array<{ name?: string }>) {
          if (p.name) peopleNames.push(p.name);
        }
      }

      let parsedEntities: Array<{ type: string; value: string }> = [];
      try {
        parsedEntities = JSON.parse(entitiesJson);
      } catch {
        /* keep empty */
      }

      const typesensePayload: Record<string, unknown> = {
        text: cleanedText,
        source_type: mem.sourceType,
        connector_type: mem.connectorType,
        event_time: mem.eventTime ? new Date(mem.eventTime).getTime() : 0,
        account_id: mem.accountId,
        memory_bank_id: mem.memoryBankId || '',
        people: peopleNames,
        importance: (mem.weights as Record<string, number>)?.importance ?? 0.5,
        recall_count: mem.recallCount ?? 0,
        pinned: mem.pinned ?? false,
        factuality_label: factualityLabel ?? 'UNVERIFIED',
        entities_text: parsedEntities.map((e) => `${e.type}:${e.value}`).join(' '),
      };

      try {
        await this.typesense.upsert(mem.id, vector, typesensePayload);
      } catch (err) {
        this.logger.warn(
          `[migration] ${mem.id.slice(0, 8)} typesense upsert failed: ${(err as Error).message}`,
        );
      }
    }

    this.progress.processed++;
  }

  private async runCorroboration(_userId: string): Promise<void> {
    // Find all memories that have supports links
    const db = this.db.db;
    const linkedMemoryIds = await db
      .selectDistinct({ id: memoryLinks.srcMemoryId })
      .from(memoryLinks)
      .where(eq(memoryLinks.linkType, 'supports'));

    this.logger.log(
      `[migration] Corroborating ${linkedMemoryIds.length} memories with supports links`,
    );

    for (const { id } of linkedMemoryIds) {
      try {
        await this.enrichService.corroborateFactuality(id);
        this.progress.corroborated++;
      } catch (err) {
        this.logger.warn(
          `[migration] corroborate ${id.slice(0, 8)} failed: ${(err as Error).message}`,
        );
      }
    }
  }

  private chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }
}
