import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { OnModuleInit, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Job, Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { ConnectorsService } from '../connectors/connectors.service';
import { AccountsService } from '../accounts/accounts.service';
import { AuthService } from '../auth/auth.service';
import { JobsService } from './jobs.service';
import { LogsService } from '../logs/logs.service';
import { EventsService } from '../events/events.service';
import { DbService } from '../db/db.service';
import { CryptoService } from '../crypto/crypto.service';
import { accounts, people, personIdentifiers } from '../db/schema';
import { SettingsService } from '../settings/settings.service';
import { ConfigService } from '../config/config.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { TraceContext, generateTraceId, generateSpanId } from '../tracing/trace.context';
import { ImsgTunnelService } from '../imsg-tunnel/imsg-tunnel.service';
import { Traced } from '../tracing/traced.decorator';
import { RawEventIngestService } from '../ingestion/raw-event-ingest.service';
import { ConnectorSyncPolicyService } from '../connectors/connector-sync-policy.service';
import {
  BaseConnector,
  type SyncContext,
  type ConnectorLogger,
  type ConnectorDataEvent,
} from '@botmem/connector-sdk';

@Processor('sync')
export class SyncProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(SyncProcessor.name);
  private readonly rawEventIngest: RawEventIngestService;
  private readonly syncPolicy: ConnectorSyncPolicyService;

  constructor(
    private connectors: ConnectorsService,
    private accountsService: AccountsService,
    private authService: AuthService,
    private jobsService: JobsService,
    private logsService: LogsService,
    private events: EventsService,
    private dbService: DbService,
    private crypto: CryptoService,
    @InjectQueue('memory') private memoryQueue: Queue,
    private settingsService: SettingsService,
    private configService: ConfigService,
    private analytics: AnalyticsService,
    private traceContext: TraceContext,
    private moduleRef: ModuleRef,
    @Optional() rawEventIngest?: RawEventIngestService,
    @Optional() syncPolicy?: ConnectorSyncPolicyService,
  ) {
    super();
    this.rawEventIngest =
      rawEventIngest ?? new RawEventIngestService(this.dbService, this.crypto, this.memoryQueue);
    this.syncPolicy = syncPolicy ?? new ConnectorSyncPolicyService();
  }

  /** Lazily resolve ImsgTunnelService — returns null if not available. */
  private getImsgTunnel(): ImsgTunnelService | null {
    try {
      return this.moduleRef.get(ImsgTunnelService, { strict: false });
    } catch {
      return null;
    }
  }

  private async getKnownPhoneNumbers(ownerUserId: string | undefined): Promise<string[]> {
    if (!ownerUserId) return [];
    try {
      const rows = await this.dbService.withUserId(ownerUserId, (db) =>
        db
          .select({ value: personIdentifiers.identifierValue })
          .from(personIdentifiers)
          .innerJoin(people, eq(people.id, personIdentifiers.personId))
          .where(
            and(eq(people.userId, ownerUserId), eq(personIdentifiers.identifierType, 'phone')),
          ),
      );

      const seen = new Set<string>();
      for (const row of rows) {
        const value = this.crypto.decrypt(row.value) ?? row.value;
        const normalized = value.replace(/[^\d+]/g, '');
        if (normalized) seen.add(normalized);
      }
      return [...seen];
    } catch (err) {
      this.logger.debug(
        `Failed to load known phone numbers for WhatsApp identity lookup: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return [];
    }
  }

  async onModuleInit() {
    this.worker.on('error', (err) => this.logger.warn(`[sync worker] ${err.message}`));
    const defaultSyncC = this.configService.aiBackend === 'openrouter' ? 8 : 2;
    const concurrency =
      parseInt(await this.settingsService.get('sync_concurrency'), 10) || defaultSyncC;
    this.worker.concurrency = concurrency;
    // Settings-based sync_debug_limit takes priority over env var
    const settingsLimit = parseInt(await this.settingsService.get('sync_debug_limit'), 10);
    BaseConnector.DEBUG_SYNC_LIMIT =
      !isNaN(settingsLimit) && settingsLimit > 0
        ? settingsLimit
        : this.configService.syncDebugLimit;
    this.settingsService.onChange((key, value) => {
      if (key === 'sync_concurrency') {
        this.worker.concurrency = parseInt(value, 10) || defaultSyncC;
      }
      if (key === 'sync_debug_limit') {
        BaseConnector.DEBUG_SYNC_LIMIT = parseInt(value, 10) || 0;
      }
    });

    // Periodic stale job reaper — runs every 10 minutes
    setInterval(
      () => {
        this.jobsService.reapStaleJobs().catch((err) => {
          this.logger.warn(`[reaper] Failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      },
      10 * 60 * 1000,
    );
    // Run once on startup (after a short delay to let DB initialize)
    setTimeout(() => {
      this.jobsService.reapStaleJobs().catch(() => {});
    }, 30_000);
  }

  async process(
    job: Job<{
      accountId: string;
      connectorType: string;
      jobId?: string;
      scheduled?: boolean;
      memoryBankId?: string;
      _trace?: { traceId: string; spanId: string };
    }>,
  ) {
    const trace = job.data._trace;
    const traceId = trace?.traceId || generateTraceId();
    const spanId = generateSpanId();
    return this.traceContext.run({ traceId, spanId }, () => this._process(job));
  }

  @Traced('sync.process')
  private async _process(
    job: Job<{
      accountId: string;
      connectorType: string;
      jobId?: string;
      scheduled?: boolean;
      memoryBankId?: string;
      _trace?: { traceId: string; spanId: string };
    }>,
  ) {
    const { accountId, connectorType } = job.data;
    let { jobId } = job.data;
    const currentTrace = this.traceContext.current()!;
    const syncStartTime = Date.now();
    const connectorFactory = this.connectors as ConnectorsService & {
      create?: (id: string) => BaseConnector;
    };
    const connector =
      typeof connectorFactory.create === 'function'
        ? connectorFactory.create(connectorType)
        : this.connectors.get(connectorType);
    let account = await this.accountsService.getById(accountId);

    if (job.data.scheduled || !jobId) {
      const scheduled = await this.jobsService.startScheduledSync(accountId, connectorType);
      if (!scheduled.job) return;
      jobId = scheduled.job.id;
      if (scheduled.skipped) {
        this.events.emitToChannel('dashboard', 'dashboard:jobs', {
          trigger: 'sync_skipped',
          jobId,
        });
        return;
      }
    }
    if (!jobId) return;

    // Enrich trace context with job metadata for PostHog log correlation
    this.traceContext.set({ jobId, connectorType });

    // Bootstrap (unscoped): resolve ownerUserId for RLS-scoped rawEvents insert
    let ownerUserId: string | undefined;
    {
      const [acct] = await this.dbService.db
        .select({ userId: accounts.userId })
        .from(accounts)
        .where(eq(accounts.id, accountId));
      ownerUserId = acct?.userId ?? undefined;
      if (ownerUserId) this.traceContext.set({ userId: ownerUserId });
    }

    await this.jobsService.updateJob(jobId, {
      status: 'running',
      progress: 0,
      total: 0,
      error: null,
      startedAt: new Date(),
    });
    await this.accountsService.update(accountId, { status: 'syncing', lastError: null });
    this.events.emitToChannel(`job:${jobId}`, 'job:progress', { jobId, progress: 0 });

    const logger: ConnectorLogger = {
      info: (msg) => this.addLog(jobId, connectorType, accountId, 'info', msg),
      warn: (msg) => this.addLog(jobId, connectorType, accountId, 'warn', msg),
      error: (msg) => this.addLog(jobId, connectorType, accountId, 'error', msg),
      debug: (msg) => this.addLog(jobId, connectorType, accountId, 'debug', msg),
    };

    const abortController = new AbortController();
    let cursor = account.lastCursor;
    let totalProcessed = 0;
    let totalInserted = 0;
    let knownTotal = 0;
    let degradedReason: string | null = null;
    const pendingWrites: Promise<void>[] = [];
    const knownPhoneNumbers =
      connectorType === 'whatsapp' ? await this.getKnownPhoneNumbers(ownerUserId) : [];
    if (knownPhoneNumbers.length) {
      logger.info(`Loaded ${knownPhoneNumbers.length} known phone number(s) for identity lookup`);
    }

    connector.on('data', (event: ConnectorDataEvent) => {
      this.events.emitToChannel(`job:${jobId}`, 'connector:data', event);

      const writePromise = this.rawEventIngest
        .ingest({
          accountId,
          connectorType,
          event,
          jobId,
          userId: ownerUserId,
          trace: { traceId: currentTrace.traceId, spanId: currentTrace.spanId },
        })
        .then((result) => {
          if (result.inserted) totalInserted += 1;
        })
        .catch((err) => {
          logger.error(`Failed to persist/enqueue event ${event.sourceId}: ${err.message}`);
          throw err;
        });
      pendingWrites.push(writePromise);
    });

    connector.on('progress', (p) => {
      const cumulative = totalProcessed + p.processed;
      // Use the largest total we've seen (first page reports the full mailbox count)
      if (p.total && p.total > knownTotal) knownTotal = p.total;
      const total = Math.max(knownTotal, cumulative);
      // Only update total — progress is incremented by embed processor as items become memories
      this.jobsService.updateJob(jobId, { total });
      this.events.emitToChannel(`job:${jobId}`, 'job:progress', {
        jobId,
        processed: undefined,
        total,
      });
    });
    connector.on('degraded', (event: { message?: string }) => {
      degradedReason = event?.message || 'Connector completed with warnings';
      logger.warn(degradedReason);
    });

    try {
      let hasMore = true;
      connector.resetSyncLimit();

      while (hasMore) {
        if (abortController.signal.aborted) break;

        const auth = account.authContext ? JSON.parse(account.authContext) : {};
        try {
          const saved = await this.authService.getSavedCredentials(connectorType);
          if (saved && typeof saved === 'object') {
            const existingRaw = auth?.raw && typeof auth.raw === 'object' ? auth.raw : {};
            auth.raw = { ...saved, ...existingRaw };
          }
        } catch {
          // Proceed without merging saved credentials (e.g. redirectUri)
        }

        const effectiveCursor = this.syncPolicy.shouldIgnoreCursor(
          connectorType,
          job.data.scheduled,
        )
          ? null
          : cursor;
        const rawCtx: SyncContext = {
          accountId,
          auth,
          cursor: effectiveCursor,
          jobId,
          logger,
          signal: abortController.signal,
          knownPhoneNumbers,
        };

        const ctx = connector.wrapSyncContext(rawCtx);

        // Inject tunnel transport for remote iMessage bridge (lazy — module may not be loaded)
        if (
          connectorType === 'imessage' &&
          account.tunnelMode &&
          'setTunnelTransport' in connector
        ) {
          const tunnel = this.getImsgTunnel();
          if (!tunnel) {
            throw new Error(
              'iMessage tunnel service is unavailable. Restart Botmem and try again.',
            );
          }
          const { WsTunnelTransport } = await import('../imsg-tunnel/ws-tunnel-transport');
          (connector as unknown as { setTunnelTransport(t: unknown): void }).setTunnelTransport(
            new WsTunnelTransport(tunnel, accountId),
          );
        } else if (connectorType === 'imessage') {
          throw new Error(
            'Legacy local iMessage TCP bridge is no longer supported. Reconnect iMessage from connector setup, run the generated bridge command, then retry sync.',
          );
        }

        const result = await connector.sync(ctx);
        totalProcessed += result.processed;
        cursor = result.cursor;
        hasMore = result.hasMore && !connector.isLimitReached;

        // Update cursor after each page so we can resume if interrupted
        await this.accountsService.update(accountId, {
          lastCursor: result.cursor ?? null,
          itemsSynced: (account.itemsSynced || 0) + result.processed,
        });

        // Refresh account for next iteration
        account = await this.accountsService.getById(accountId);
      }

      await this.accountsService.update(accountId, {
        lastSyncAt: new Date(),
        status: degradedReason ? 'degraded' : 'connected',
        lastError: degradedReason,
      });

      // Wait for all pending DB writes / embed enqueues to finish
      await Promise.all(pendingWrites);

      const pipelineTotal = totalInserted;
      if (pipelineTotal === 0) {
        // Nothing to process through pipeline — mark done immediately
        await this.jobsService.updateJob(jobId, {
          status: 'done',
          progress: 0,
          total: 0,
          completedAt: new Date(),
        });
        this.events.emitToChannel(`job:${jobId}`, 'job:complete', { jobId, status: 'done' });
        this.events.emitToChannel('dashboard', 'dashboard:jobs', {
          trigger: 'sync_complete',
          jobId,
        });
      } else {
        // Set total to actual emitted count so progress never exceeds it
        await this.jobsService.updateJob(jobId, { total: pipelineTotal });
        logger.info(`Sync complete, ${pipelineTotal} emitted item(s) now in pipeline`);
      }
      this.analytics.capture('sync_complete', {
        connector_type: connectorType,
        duration_ms: Date.now() - syncStartTime,
        item_count: pipelineTotal,
      });
    } catch (err: unknown) {
      // If the error is from hitting the sync limit, treat as success
      if (connector.isLimitReached) {
        await this.accountsService.update(accountId, {
          lastSyncAt: new Date(),
          status: 'connected',
          lastError: null,
        });
        await Promise.all(pendingWrites);
        const pipelineTotal = totalInserted;
        if (pipelineTotal === 0) {
          await this.jobsService.updateJob(jobId, {
            status: 'done',
            progress: 0,
            total: 0,
            completedAt: new Date(),
          });
          this.events.emitToChannel(`job:${jobId}`, 'job:complete', { jobId, status: 'done' });
        }
        // else: job stays "running", embed processor will mark done when all items complete
        return;
      }

      const errMsg = err instanceof Error ? err.message : String(err);
      const errName = err instanceof Error ? err.name : 'UnknownError';

      this.analytics.capture('sync_error', {
        connector_type: connectorType,
        error_type: errName,
      });

      const maxAttempts = job.opts.attempts ?? 1;
      const failurePolicy = this.syncPolicy.classifyFailure(connectorType, errMsg);
      const fatal = failurePolicy.fatal;
      const recoverableRuntimeFailure = failurePolicy.recoverableRuntimeFailure;
      const isLastAttempt = fatal || job.attemptsMade >= maxAttempts - 1;

      if (isLastAttempt) {
        await this.jobsService.updateJob(jobId, {
          status: 'failed',
          error: errMsg,
          completedAt: new Date(),
        });

        const accountStatus = failurePolicy.accountStatus;

        await this.accountsService.update(
          accountId,
          recoverableRuntimeFailure
            ? { status: 'connected', lastError: null }
            : { status: accountStatus, lastError: errMsg },
        );
        this.events.emitToChannel(`job:${jobId}`, 'job:complete', { jobId, status: 'failed' });
        this.events.emitToChannel('dashboard', 'dashboard:jobs', { trigger: 'sync_failed', jobId });

        // Broadcast notification so frontend updates in real-time
        if (!recoverableRuntimeFailure && accountStatus === 'reconnect_required') {
          this.events.emitToChannel('notifications', 'connector:warning', {
            connectorType,
            message: errMsg,
            action: 'reauth',
          });
        }
        if (fatal) return;
      }
      throw err;
    } finally {
      // Wait for all pending DB writes to complete before removing listeners
      await Promise.allSettled(pendingWrites);
      connector.removeAllListeners();
    }
  }

  private addLog(
    jobId: string,
    connectorType: string,
    accountId: string,
    level: string,
    message: string,
  ) {
    const stage = 'sync';
    this.logsService.add({ jobId, connectorType, accountId, stage, level, message });
  }
}
