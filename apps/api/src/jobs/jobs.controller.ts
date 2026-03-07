import { Controller, Get, Post, Delete, Param, Query } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { JobsService } from './jobs.service';
import { AccountsService } from '../accounts/accounts.service';
import type { Job } from '@botmem/shared';

function toApiJob(row: any): Job {
  return {
    id: row.id,
    connector: row.connectorType,
    accountId: row.accountId,
    accountIdentifier: row.accountIdentifier || null,
    status: row.status,
    priority: row.priority,
    progress: row.progress,
    total: row.total,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    error: row.error,
  };
}

@Controller('jobs')
export class JobsController {
  constructor(
    private jobsService: JobsService,
    private accountsService: AccountsService,
    @InjectQueue('sync') private syncQueue: Queue,
    @InjectQueue('clean') private cleanQueue: Queue,
    @InjectQueue('embed') private embedQueue: Queue,
    @InjectQueue('enrich') private enrichQueue: Queue,
    @InjectQueue('backfill') private backfillQueue: Queue,
  ) {}

  @Get()
  async list(@Query('accountId') accountId?: string) {
    // Detect stale running jobs so the UI sees accurate statuses
    await this.jobsService.markStaleRunning();
    const rows = await this.jobsService.getAll({ accountId });
    return { jobs: rows.map(toApiJob) };
  }

  @Get('queues')
  async queues() {
    const getStats = async (queue: Queue) => {
      const [waiting, active, completed, failed, delayed] = await Promise.all([
        queue.getWaitingCount(),
        queue.getActiveCount(),
        queue.getCompletedCount(),
        queue.getFailedCount(),
        queue.getDelayedCount(),
      ]);
      return { waiting, active, completed, failed, delayed };
    };
    const [sync, clean, embed, enrich, backfill] = await Promise.all([
      getStats(this.syncQueue),
      getStats(this.cleanQueue),
      getStats(this.embedQueue),
      getStats(this.enrichQueue),
      getStats(this.backfillQueue),
    ]);

    return { sync, clean, embed, enrich, backfill };
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const row = await this.jobsService.getById(id);
    if (!row) return { error: 'not found' };
    return toApiJob(row);
  }

  @Post('sync/:accountId')
  async triggerSync(@Param('accountId') accountId: string) {
    const account = await this.accountsService.getById(accountId);
    const row = await this.jobsService.triggerSync(accountId, account.connectorType, account.identifier);
    return { job: toApiJob(row) };
  }

  @Post('retry-failed')
  async retryFailed() {
    const rows = await this.jobsService.getAll();
    let retried = 0;
    const retriedAccountIds = new Set<string>();

    for (const job of rows) {
      if (job.status !== 'failed') continue;

      const account = await this.accountsService.getById(job.accountId);
      if (!account) continue;

      // Delete the old failed job row
      await this.jobsService.deleteJob(job.id);

      // Only trigger one sync per account (avoid duplicates if multiple failed jobs for same account)
      if (!retriedAccountIds.has(job.accountId)) {
        await this.jobsService.triggerSync(job.accountId, job.connectorType, job.accountIdentifier || undefined);
        retriedAccountIds.add(job.accountId);
        retried++;
      }
    }

    // Retry failed BullMQ pipeline jobs by re-adding them to their queue
    for (const queue of [this.cleanQueue, this.embedQueue, this.enrichQueue]) {
      const failed = await queue.getFailed();
      for (const fjob of failed) {
        await queue.add(fjob.name, fjob.data, {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
        });
        await fjob.remove();
      }
      retried += failed.length;
    }

    // Clean failed sync jobs from BullMQ
    const failedSync = await this.syncQueue.getFailed();
    for (const fjob of failedSync) {
      await fjob.remove();
    }

    return { ok: true, retried };
  }

  @Delete(':id')
  async cancel(@Param('id') id: string) {
    await this.jobsService.cancel(id);
    return { ok: true };
  }
}
