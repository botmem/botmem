import { Processor, WorkerHost } from '@nestjs/bullmq';
import { OnModuleInit, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { EnrichService } from './enrich.service';
import { MemoryService } from './memory.service';
import { CryptoService } from '../crypto/crypto.service';
import { UserKeyService } from '../crypto/user-key.service';
import { EncryptionKeyMissingError } from '../crypto/encryption-key-missing.error';
import { EventsService } from '../events/events.service';
import { LogsService } from '../logs/logs.service';
import { JobsService } from '../jobs/jobs.service';
import { SettingsService } from '../settings/settings.service';
import { PluginRegistry } from '../plugins/plugin-registry';
import { rawEvents, memories, accounts, users } from '../db/schema';

@Processor('enrich')
export class EnrichProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(EnrichProcessor.name);
  constructor(
    private dbService: DbService,
    private enrichService: EnrichService,
    private memoryService: MemoryService,
    private crypto: CryptoService,
    private userKeyService: UserKeyService,
    private events: EventsService,
    private logsService: LogsService,
    private jobsService: JobsService,
    private settingsService: SettingsService,
    private pluginRegistry: PluginRegistry,
  ) {
    super();
  }

  async onModuleInit() {
    this.worker.on('error', (err) => this.logger.warn(`[enrich worker] ${err.message}`));
    const concurrency = parseInt(await this.settingsService.get('enrich_concurrency'), 10) || 8;
    this.worker.concurrency = concurrency;
    this.worker.opts.lockDuration = 300_000;
    this.settingsService.onChange((key, value) => {
      if (key === 'enrich_concurrency') {
        this.worker.concurrency = parseInt(value, 10) || 8;
      }
    });
  }

  async process(job: Job<{ rawEventId: string; memoryId: string }>) {
    const { rawEventId, memoryId } = job.data;

    // Look up parent job ID from the raw event
    const rawRows = await this.dbService.db
      .select({
        jobId: rawEvents.jobId,
        connectorType: rawEvents.connectorType,
        accountId: rawEvents.accountId,
      })
      .from(rawEvents)
      .where(eq(rawEvents.id, rawEventId));

    const parentJobId = rawRows[0]?.jobId;
    const connectorType = rawRows[0]?.connectorType || 'unknown';

    // Run enrichment
    await this.enrichService.enrich(memoryId);

    // Read enriched memory for hook and event
    const [mem] = await this.dbService.db
      .select({
        text: memories.text,
        sourceType: memories.sourceType,
        entities: memories.entities,
        factuality: memories.factuality,
      })
      .from(memories)
      .where(eq(memories.id, memoryId));

    // Fire afterEnrich hook (fire-and-forget)
    void this.pluginRegistry.fireHook('afterEnrich', {
      id: memoryId,
      text: mem?.text,
      sourceType: mem?.sourceType,
      connectorType,
      eventTime: undefined,
      entities: mem?.entities,
      factuality: mem?.factuality,
    });

    // Encrypt memory fields at rest before marking as done
    this.encryptMemoryAtRest(memoryId);

    // Mark memory as done
    await this.dbService.db
      .update(memories)
      .set({ embeddingStatus: 'done' })
      .where(eq(memories.id, memoryId));

    this.events.emitToChannel('memories', 'memory:updated', {
      memoryId,
      sourceType: mem?.sourceType,
      connectorType,
      text: mem?.text?.slice(0, 100),
    });

    // Emit graph delta for incremental graph updates
    this.emitGraphDelta(memoryId);

    // Dashboard stats are fetched per-user via REST — no global WS broadcast

    // Advance parent job progress
    await this.advanceAndComplete(parentJobId);
  }

  private async encryptMemoryAtRest(memoryId: string) {
    const db = this.dbService.db;
    const rows = await db
      .select({
        text: memories.text,
        entities: memories.entities,
        claims: memories.claims,
        metadata: memories.metadata,
        accountId: memories.accountId,
      })
      .from(memories)
      .where(eq(memories.id, memoryId));
    if (!rows.length) return;
    const mem = rows[0];

    // Resolve owner userId from account
    let ownerUserId: string | undefined;
    if (mem.accountId) {
      const [acct] = await db
        .select({ userId: accounts.userId })
        .from(accounts)
        .where(eq(accounts.id, mem.accountId));
      ownerUserId = acct?.userId ?? undefined;
    }

    if (!ownerUserId) {
      // No owner -- fall back to APP_SECRET encryption
      const enc = this.crypto.encryptMemoryFields({
        text: mem.text,
        entities: mem.entities,
        claims: mem.claims,
        metadata: mem.metadata,
      });
      await db
        .update(memories)
        .set({
          text: enc.text,
          entities: enc.entities,
          claims: enc.claims,
          metadata: enc.metadata,
          keyVersion: 0,
        })
        .where(eq(memories.id, memoryId));
      return;
    }

    const userKey = this.userKeyService.getKey(ownerUserId);
    if (!userKey) {
      throw new EncryptionKeyMissingError(ownerUserId);
    }

    // Get user's current keyVersion
    const [user] = await db
      .select({ keyVersion: users.keyVersion })
      .from(users)
      .where(eq(users.id, ownerUserId));
    const keyVersion = user?.keyVersion ?? 1;

    const enc = this.crypto.encryptMemoryFieldsWithKey(
      { text: mem.text, entities: mem.entities, claims: mem.claims, metadata: mem.metadata },
      userKey,
    );
    await db
      .update(memories)
      .set({
        text: enc.text,
        entities: enc.entities,
        claims: enc.claims,
        metadata: enc.metadata,
        keyVersion,
      })
      .where(eq(memories.id, memoryId));
  }

  private emitGraphDelta(memoryId: string) {
    this.memoryService
      .buildGraphDelta(memoryId)
      .then((delta) => {
        if (delta) this.events.emitToChannel('memories', 'graph:delta', delta);
      })
      .catch(() => {});
  }

  private async advanceAndComplete(jobId: string | null | undefined) {
    if (!jobId) return;
    try {
      const result = await this.jobsService.incrementProgress(jobId);
      this.events.emitToChannel(`job:${jobId}`, 'job:progress', {
        jobId,
        processed: result.progress,
        total: result.total,
      });
      const done = await this.jobsService.tryCompleteJob(jobId);
      if (done) {
        this.events.emitToChannel(`job:${jobId}`, 'job:complete', { jobId, status: 'done' });
        this.events.emitToChannel('dashboard', 'dashboard:jobs', {
          trigger: 'enrich_complete',
          jobId,
        });
      }
    } catch (err) {
      this.logger.warn(
        'Job progress advance failed',
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}
