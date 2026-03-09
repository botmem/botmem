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

    // Bootstrap (unscoped): resolve ownerUserId + parentJobId from raw event
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
    const rawAccountId = rawRows[0]?.accountId;

    // Resolve ownerUserId from account (unscoped bootstrap — accounts table needs userId)
    let ownerUserId: string | null = null;
    if (rawAccountId) {
      const [acct] = await this.dbService.db
        .select({ userId: accounts.userId })
        .from(accounts)
        .where(eq(accounts.id, rawAccountId));
      ownerUserId = acct?.userId ?? null;
    }

    // Run enrichment (enrichService uses unscoped db internally — acceptable for processor context)
    await this.enrichService.enrich(memoryId);

    // Read enriched memory for hook and event — use withUserId scope if available
    const readMemory = (db: typeof this.dbService.db) =>
      db
        .select({
          text: memories.text,
          sourceType: memories.sourceType,
          entities: memories.entities,
          factuality: memories.factuality,
        })
        .from(memories)
        .where(eq(memories.id, memoryId));

    const [mem] = ownerUserId
      ? await this.dbService.withUserId(ownerUserId, readMemory)
      : await readMemory(this.dbService.db);

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
    this.encryptMemoryAtRest(memoryId, ownerUserId ?? undefined).catch((err) => {
      this.logger.warn(`[Enrich] encryptMemoryAtRest failed for ${memoryId}: ${err.message}`);
    });

    // Mark memory as done — use withUserId scope if available
    const updateDone = (db: typeof this.dbService.db) =>
      db.update(memories).set({ embeddingStatus: 'done' }).where(eq(memories.id, memoryId));
    if (ownerUserId) {
      await this.dbService.withUserId(ownerUserId, updateDone);
    } else {
      await updateDone(this.dbService.db);
    }

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

  private async encryptMemoryAtRest(memoryId: string, ownerUserIdHint?: string) {
    // Read memory fields — use ownerUserIdHint scope if available (resolved in process())
    const readRows = (db: typeof this.dbService.db) =>
      db
        .select({
          text: memories.text,
          entities: memories.entities,
          claims: memories.claims,
          metadata: memories.metadata,
          accountId: memories.accountId,
        })
        .from(memories)
        .where(eq(memories.id, memoryId));

    const rows = ownerUserIdHint
      ? await this.dbService.withUserId(ownerUserIdHint, readRows)
      : await readRows(this.dbService.db);

    if (!rows.length) return;
    const mem = rows[0];

    // Resolve owner userId: use hint from process() or fall back to account lookup
    let ownerUserId: string | undefined = ownerUserIdHint;
    if (!ownerUserId && mem.accountId) {
      // Unscoped bootstrap — accounts lookup to get userId
      const [acct] = await this.dbService.db
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
      const writeAppSecret = (db: typeof this.dbService.db) =>
        db
          .update(memories)
          .set({
            text: enc.text,
            entities: enc.entities,
            claims: enc.claims,
            metadata: enc.metadata,
            keyVersion: 0,
          })
          .where(eq(memories.id, memoryId));
      // No ownerUserId means no RLS scope — write unscoped
      await writeAppSecret(this.dbService.db);
      return;
    }

    const userKey = this.userKeyService.getKey(ownerUserId);
    if (!userKey) {
      throw new EncryptionKeyMissingError(ownerUserId);
    }

    // Get user's current keyVersion — users table is NOT RLS-protected, unscoped OK
    const [user] = await this.dbService.db
      .select({ keyVersion: users.keyVersion })
      .from(users)
      .where(eq(users.id, ownerUserId));
    const keyVersion = user?.keyVersion ?? 1;

    const enc = this.crypto.encryptMemoryFieldsWithKey(
      { text: mem.text, entities: mem.entities, claims: mem.claims, metadata: mem.metadata },
      userKey,
    );
    await this.dbService.withUserId(ownerUserId, (db) =>
      db
        .update(memories)
        .set({
          text: enc.text,
          entities: enc.entities,
          claims: enc.claims,
          metadata: enc.metadata,
          keyVersion,
        })
        .where(eq(memories.id, memoryId)),
    );
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
