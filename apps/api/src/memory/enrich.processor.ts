import { Processor, WorkerHost } from '@nestjs/bullmq';
import { OnModuleInit, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { EnrichService } from './enrich.service';
import { MemoryService } from './memory.service';
import { CryptoService } from '../crypto/crypto.service';
import { UserKeyService } from '../crypto/user-key.service';
import { EventsService } from '../events/events.service';
import { LogsService } from '../logs/logs.service';
import { JobsService } from '../jobs/jobs.service';
import { SettingsService } from '../settings/settings.service';
import { ConfigService } from '../config/config.service';
import { PluginRegistry } from '../plugins/plugin-registry';
import { rawEvents, memories, accounts, users } from '../db/schema';
import { TraceContext, generateTraceId, generateSpanId } from '../tracing/trace.context';

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
    private config: ConfigService,
    private traceContext: TraceContext,
  ) {
    super();
  }

  async onModuleInit() {
    this.worker.on('error', (err) => this.logger.warn(`[enrich worker] ${err.message}`));
    const defaultC = this.config.aiConcurrency.enrich;
    const concurrency =
      parseInt(await this.settingsService.get('enrich_concurrency'), 10) || defaultC;
    this.worker.concurrency = concurrency;
    this.worker.opts.lockDuration = 300_000;
    this.settingsService.onChange((key, value) => {
      if (key === 'enrich_concurrency') {
        this.worker.concurrency = parseInt(value, 10) || defaultC;
      }
    });
  }

  async process(
    job: Job<{
      rawEventId: string;
      memoryId: string;
      _trace?: { traceId: string; spanId: string };
    }>,
  ) {
    const trace = job.data._trace;
    const traceId = trace?.traceId || generateTraceId();
    const spanId = generateSpanId();
    return this.traceContext.run({ traceId, spanId }, () => this._process(job));
  }

  private async _process(
    job: Job<{
      rawEventId: string;
      memoryId: string;
      _trace?: { traceId: string; spanId: string };
    }>,
  ) {
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
    this.pluginRegistry
      .fireHook('afterEnrich', {
        id: memoryId,
        text: mem?.text,
        sourceType: mem?.sourceType,
        connectorType,
        eventTime: undefined,
        entities: mem?.entities,
        factuality: mem?.factuality,
      })
      .catch((err) => {
        this.logger.warn(
          `afterEnrich hook failed for memory ${memoryId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });

    // Compute search_tokens from plaintext BEFORE encryption so FTS works on encrypted memories.
    // The tsvector is non-sensitive (stemmed word positions, no raw text) and stored unencrypted.
    if (mem?.text) {
      try {
        await this.updateSearchTokens(memoryId, mem.text, ownerUserId);
      } catch (err) {
        this.logger.warn(
          `[enrich] search_tokens update failed for ${memoryId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Encrypt memory fields at rest — must succeed before marking done.
    // If user key is missing, this throws and BullMQ retries with backoff.
    await this.encryptMemoryAtRest(memoryId, ownerUserId ?? undefined);

    // Mark memory as done + pipeline complete — use withUserId scope if available
    await this.markPipelineComplete(memoryId, ownerUserId);

    this.events.emitToChannel('memories', 'memory:updated', {
      memoryId,
      sourceType: mem?.sourceType,
      connectorType,
      text: mem?.text?.slice(0, 100),
    });

    // Emit graph delta for incremental graph updates
    this.emitGraphDelta(memoryId);

    // Emit dashboard signals (debounced) — frontend re-fetches via REST
    this.events.emitDebounced(
      'dashboard:queue-stats',
      'dashboard',
      'dashboard:queue-stats-changed',
      async () => ({ ts: Date.now() }),
      2000,
    );
    this.events.emitDebounced(
      'dashboard:memory-stats',
      'dashboard',
      'dashboard:memory-stats-changed',
      async () => ({ ts: Date.now() }),
      2000,
    );

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
      // Orphaned memory with no owner — skip encryption (should rarely happen)
      this.logger.warn(`[Enrich] No owner for memory ${memoryId}, skipping encryption`);
      return;
    }

    const userKey = await this.userKeyService.getDek(ownerUserId);
    if (!userKey) {
      // User's recovery key not in cache — throw to trigger BullMQ retry.
      // The user must submit their recovery key (via login or /recovery-key endpoint)
      // for encryption to succeed. Retries with exponential backoff give time for that.
      throw new Error(`User key not available. Submit recovery key to unlock encryption.`);
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

  private async markPipelineComplete(memoryId: string, ownerUserId: string | null) {
    const doUpdate = (db: typeof this.dbService.db) =>
      db
        .update(memories)
        .set({ embeddingStatus: 'done', pipelineComplete: true, enrichedAt: new Date() })
        .where(eq(memories.id, memoryId));
    if (ownerUserId) {
      await this.dbService.withUserId(ownerUserId, doUpdate);
    } else {
      await doUpdate(this.dbService.db);
    }
  }

  private async updateSearchTokens(
    memoryId: string,
    plaintext: string,
    ownerUserId: string | null,
  ) {
    const doUpdate = (db: typeof this.dbService.db) =>
      db
        .update(memories)
        .set({ searchTokens: sql`to_tsvector('english', ${plaintext})` })
        .where(eq(memories.id, memoryId));
    if (ownerUserId) {
      await this.dbService.withUserId(ownerUserId, doUpdate);
    } else {
      await doUpdate(this.dbService.db);
    }
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
