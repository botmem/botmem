import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import { ConnectorsService } from '../connectors/connectors.service';
import { AccountsService } from '../accounts/accounts.service';
import { JobsService } from './jobs.service';
import { LogsService } from '../logs/logs.service';
import { EventsService } from '../events/events.service';
import { DbService } from '../db/db.service';
import { rawEvents } from '../db/schema';
import type { SyncContext, ConnectorLogger, ConnectorDataEvent } from '@botmem/connector-sdk';

@Processor('sync')
export class SyncProcessor extends WorkerHost {
  constructor(
    private connectors: ConnectorsService,
    private accountsService: AccountsService,
    private jobsService: JobsService,
    private logsService: LogsService,
    private events: EventsService,
    private dbService: DbService,
    @InjectQueue('embed') private embedQueue: Queue,
  ) {
    super();
  }

  async process(job: Job<{ accountId: string; connectorType: string; jobId: string }>) {
    const { accountId, connectorType, jobId } = job.data;
    const connector = this.connectors.get(connectorType);
    let account = await this.accountsService.getById(accountId);

    await this.jobsService.updateJob(jobId, { status: 'running', startedAt: new Date().toISOString() });
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

    connector.on('data', (event: ConnectorDataEvent) => {
      this.events.emitToChannel(`job:${jobId}`, 'connector:data', event);

      // Persist raw event and enqueue embedding
      const rawEventId = randomUUID();
      const now = new Date().toISOString();
      this.dbService.db
        .insert(rawEvents)
        .values({
          id: rawEventId,
          accountId,
          connectorType,
          sourceId: event.sourceId,
          sourceType: event.sourceType,
          payload: JSON.stringify(event),
          timestamp: event.timestamp,
          jobId,
          createdAt: now,
        })
        .then(() =>
          this.embedQueue.add(
            'embed',
            { rawEventId },
            { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
          ),
        )
        .catch((err) =>
          logger.error(`Failed to persist/enqueue event ${event.sourceId}: ${err.message}`),
        );
    });

    connector.on('progress', (p) => {
      const cumulative = totalProcessed + p.processed;
      // Use the largest total we've seen (first page reports the full mailbox count)
      if (p.total && p.total > knownTotal) knownTotal = p.total;
      const total = Math.max(knownTotal, cumulative);
      this.jobsService.updateJob(jobId, { progress: cumulative, total });
      this.events.emitToChannel(`job:${jobId}`, 'job:progress', { jobId, processed: cumulative, total });
    });

    try {
      let hasMore = true;

      while (hasMore) {
        if (abortController.signal.aborted) break;

        const ctx: SyncContext = {
          accountId,
          auth: account.authContext ? JSON.parse(account.authContext) : {},
          cursor,
          jobId,
          logger,
          signal: abortController.signal,
        };

        const result = await connector.sync(ctx);
        totalProcessed += result.processed;
        cursor = result.cursor;
        hasMore = result.hasMore;

        // Update cursor after each page so we can resume if interrupted
        await this.accountsService.update(accountId, {
          lastCursor: result.cursor || undefined,
          itemsSynced: (account.itemsSynced || 0) + result.processed,
        });

        // Refresh account for next iteration
        account = await this.accountsService.getById(accountId);
      }

      await this.accountsService.update(accountId, {
        lastSyncAt: new Date().toISOString(),
        status: 'connected',
        lastError: null,
      });

      await this.jobsService.updateJob(jobId, {
        status: 'done',
        progress: totalProcessed,
        completedAt: new Date().toISOString(),
      });

      this.events.emitToChannel(`job:${jobId}`, 'job:complete', { jobId, status: 'done' });
    } catch (err: any) {
      await this.jobsService.updateJob(jobId, {
        status: 'failed',
        error: err.message,
        completedAt: new Date().toISOString(),
      });
      await this.accountsService.update(accountId, { status: 'error', lastError: err.message });
      this.events.emitToChannel(`job:${jobId}`, 'job:complete', { jobId, status: 'failed' });
      throw err;
    } finally {
      connector.removeAllListeners();
    }
  }

  private addLog(jobId: string, connectorType: string, accountId: string, level: string, message: string) {
    this.logsService.add({ jobId, connectorType, accountId, level, message });
    this.events.emitToChannel('logs', 'log', { jobId, connectorType, accountId, level, message, timestamp: new Date().toISOString() });
  }
}
