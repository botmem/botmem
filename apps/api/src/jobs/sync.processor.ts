import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { OnModuleInit, Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import { ConnectorsService } from '../connectors/connectors.service';
import { AccountsService } from '../accounts/accounts.service';
import { AuthService } from '../auth/auth.service';
import { JobsService } from './jobs.service';
import { LogsService } from '../logs/logs.service';
import { EventsService } from '../events/events.service';
import { DbService } from '../db/db.service';
import { rawEvents } from '../db/schema';
import { SettingsService } from '../settings/settings.service';
import { ConfigService } from '../config/config.service';
import { BaseConnector } from '@botmem/connector-sdk';
import { AnalyticsService } from '../analytics/analytics.service';
import type { SyncContext, ConnectorLogger, ConnectorDataEvent } from '@botmem/connector-sdk';

@Processor('sync')
export class SyncProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(SyncProcessor.name);
  constructor(
    private connectors: ConnectorsService,
    private accountsService: AccountsService,
    private authService: AuthService,
    private jobsService: JobsService,
    private logsService: LogsService,
    private events: EventsService,
    private dbService: DbService,
    @InjectQueue('clean') private cleanQueue: Queue,
    private settingsService: SettingsService,
    private configService: ConfigService,
    private analytics: AnalyticsService,
  ) {
    super();
  }

  async onModuleInit() {
    this.worker.on('error', (err) => this.logger.warn(`[sync worker] ${err.message}`));
    const concurrency = parseInt(await this.settingsService.get('sync_concurrency'), 10) || 2;
    this.worker.concurrency = concurrency;
    // Settings-based sync_debug_limit takes priority over env var
    const settingsLimit = parseInt(await this.settingsService.get('sync_debug_limit'), 10);
    BaseConnector.DEBUG_SYNC_LIMIT = !isNaN(settingsLimit) && settingsLimit > 0
      ? settingsLimit
      : this.configService.syncDebugLimit;
    this.settingsService.onChange((key, value) => {
      if (key === 'sync_concurrency') {
        this.worker.concurrency = parseInt(value, 10) || 2;
      }
      if (key === 'sync_debug_limit') {
        BaseConnector.DEBUG_SYNC_LIMIT = parseInt(value, 10) || 0;
      }
    });
  }

  async process(job: Job<{ accountId: string; connectorType: string; jobId: string }>) {
    const { accountId, connectorType, jobId } = job.data;
    const syncStartTime = Date.now();
    const connector = this.connectors.get(connectorType);
    let account = await this.accountsService.getById(accountId);

    await this.jobsService.updateJob(jobId, { status: 'running', startedAt: new Date() });
    await this.accountsService.update(accountId, { status: 'syncing' });
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
    let knownTotal = 0;
    const pendingWrites: Promise<void>[] = [];

    connector.on('data', (event: ConnectorDataEvent) => {
      this.events.emitToChannel(`job:${jobId}`, 'connector:data', event);

      // Persist raw event and enqueue embedding — track the promise
      const rawEventId = randomUUID();
      const now = new Date();
      const writePromise = this.dbService.db
        .insert(rawEvents)
        .values({
          id: rawEventId,
          accountId,
          connectorType,
          sourceId: event.sourceId,
          sourceType: event.sourceType,
          payload: JSON.stringify(event),
          timestamp: new Date(event.timestamp),
          jobId,
          createdAt: now,
        })
        .then(() =>
          this.cleanQueue.add(
            'clean',
            { rawEventId },
            { attempts: 3, backoff: { type: 'exponential', delay: 1000 } },
          ),
        )
        .then(() => {})
        .catch((err) =>
          logger.error(`Failed to persist/enqueue event ${event.sourceId}: ${err.message}`),
        );
      pendingWrites.push(writePromise);
    });

    connector.on('progress', (p) => {
      const cumulative = totalProcessed + p.processed;
      // Use the largest total we've seen (first page reports the full mailbox count)
      if (p.total && p.total > knownTotal) knownTotal = p.total;
      const total = Math.max(knownTotal, cumulative);
      // Only update total — progress is incremented by embed processor as items become memories
      this.jobsService.updateJob(jobId, { total });
      this.events.emitToChannel(`job:${jobId}`, 'job:progress', { jobId, processed: undefined, total });
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

        const rawCtx: SyncContext = {
          accountId,
          auth,
          cursor,
          jobId,
          logger,
          signal: abortController.signal,
        };

        const ctx = connector.wrapSyncContext(rawCtx);
        const result = await connector.sync(ctx);
        totalProcessed += result.processed;
        cursor = result.cursor;
        hasMore = result.hasMore && !connector.isLimitReached;

        // Update cursor after each page so we can resume if interrupted
        await this.accountsService.update(accountId, {
          lastCursor: result.cursor || undefined,
          itemsSynced: (account.itemsSynced || 0) + result.processed,
        });

        // Refresh account for next iteration
        account = await this.accountsService.getById(accountId);
      }

      await this.accountsService.update(accountId, {
        lastSyncAt: new Date(),
        status: 'connected',
        lastError: null,
      });

      // Wait for all pending DB writes / embed enqueues to finish
      await Promise.allSettled(pendingWrites);

      if (totalProcessed === 0) {
        // Nothing to process through pipeline — mark done immediately
        await this.jobsService.updateJob(jobId, {
          status: 'done',
          progress: 0,
          total: 0,
          completedAt: new Date(),
        });
        this.events.emitToChannel(`job:${jobId}`, 'job:complete', { jobId, status: 'done' });
        this.events.emitToChannel('dashboard', 'dashboard:jobs', { trigger: 'sync_complete', jobId });
      } else {
        // Set total to actual emitted count so progress never exceeds it
        await this.jobsService.updateJob(jobId, { total: totalProcessed });
        logger.info(`Sync complete, ${totalProcessed} items now in pipeline`);
      }
      this.analytics.capture('sync_complete', {
        connector_type: connectorType,
        duration_ms: Date.now() - syncStartTime,
        item_count: totalProcessed,
      });
    } catch (err: any) {
      // If the error is from hitting the sync limit, treat as success
      if (connector.isLimitReached) {
        await this.accountsService.update(accountId, {
          lastSyncAt: new Date(),
          status: 'connected',
          lastError: null,
        });
        await Promise.allSettled(pendingWrites);
        if (totalProcessed === 0) {
          await this.jobsService.updateJob(jobId, { status: 'done', progress: 0, total: 0, completedAt: new Date() });
          this.events.emitToChannel(`job:${jobId}`, 'job:complete', { jobId, status: 'done' });
        }
        // else: job stays "running", embed processor will mark done when all items complete
        return;
      }

      this.analytics.capture('sync_error', {
        connector_type: connectorType,
        error_type: err.name,
      });
      await this.jobsService.updateJob(jobId, {
        status: 'failed',
        error: err.message,
        completedAt: new Date(),
      });
      await this.accountsService.update(accountId, { status: 'error', lastError: err.message });
      this.events.emitToChannel(`job:${jobId}`, 'job:complete', { jobId, status: 'failed' });
      this.events.emitToChannel('dashboard', 'dashboard:jobs', { trigger: 'sync_failed', jobId });
      throw err;
    } finally {
      // Wait for all pending DB writes to complete before removing listeners
      await Promise.allSettled(pendingWrites);
      connector.removeAllListeners();
    }
  }

  private addLog(jobId: string, connectorType: string, accountId: string, level: string, message: string) {
    const stage = 'sync';
    this.logsService.add({ jobId, connectorType, accountId, stage, level, message });
    this.events.emitToChannel('logs', 'log', { jobId, connectorType, accountId, stage, level, message, timestamp: new Date() });
  }
}
