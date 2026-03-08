import { Controller, Get, Post, Delete, Param, Query, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { eq, and } from 'drizzle-orm';
import { JobsService } from './jobs.service';
import { AccountsService } from '../accounts/accounts.service';
import { DbService } from '../db/db.service';
import { rawEvents, memories, memoryContacts, accounts } from '../db/schema';
import { RequiresJwt } from '../user-auth/decorators/requires-jwt.decorator';
import { CurrentUser } from '../user-auth/decorators/current-user.decorator';
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
  private readonly logger = new Logger(JobsController.name);
  constructor(
    private jobsService: JobsService,
    private accountsService: AccountsService,
    private dbService: DbService,
    @InjectQueue('sync') private syncQueue: Queue,
    @InjectQueue('clean') private cleanQueue: Queue,
    @InjectQueue('embed') private embedQueue: Queue,
    @InjectQueue('enrich') private enrichQueue: Queue,
    @InjectQueue('backfill') private backfillQueue: Queue,
  ) {}

  @Get()
  async list(@CurrentUser() user: { id: string }, @Query('accountId') accountId?: string) {
    // Detect stale running jobs so the UI sees accurate statuses
    await this.jobsService.markStaleRunning();
    // User isolation: only show jobs for user's accounts
    const userAccounts = await this.dbService.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.userId, user.id));
    const userAccountIds = new Set(userAccounts.map((a) => a.id));
    const rows = await this.jobsService.getAll({ accountId });
    const filtered = rows.filter((r) => userAccountIds.has(r.accountId));
    return { jobs: filtered.map(toApiJob) };
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

  @RequiresJwt()
  @Post('sync/:accountId')
  async triggerSync(@Param('accountId') accountId: string) {
    const account = await this.accountsService.getById(accountId);
    const row = await this.jobsService.triggerSync(
      accountId,
      account.connectorType,
      account.identifier,
    );
    return { job: toApiJob(row) };
  }

  @RequiresJwt()
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
        await this.jobsService.triggerSync(
          job.accountId,
          job.connectorType,
          job.accountIdentifier || undefined,
        );
        retriedAccountIds.add(job.accountId);
        retried++;
      }
    }

    // Retry failed BullMQ pipeline jobs in batches
    const BATCH = 500;

    // Embed/clean failures: delete stale memory, then re-enqueue through clean
    const db = this.dbService.db;
    for (const queue of [this.cleanQueue, this.embedQueue]) {
      const failed = await queue.getFailed(0, BATCH);
      for (const fjob of failed) {
        try {
          const rawEventId = fjob.data?.rawEventId;
          await fjob.remove();
          if (!rawEventId) continue;

          // Find the raw event to get source_id + connector_type
          const raw = await db
            .select({ sourceId: rawEvents.sourceId, connectorType: rawEvents.connectorType })
            .from(rawEvents)
            .where(eq(rawEvents.id, rawEventId))
            .limit(1);
          if (!raw.length) continue;

          // Delete existing stale memory (if any) so clean processor won't skip as dedup
          const existing = await db
            .select({ id: memories.id })
            .from(memories)
            .where(
              and(
                eq(memories.sourceId, raw[0].sourceId),
                eq(memories.connectorType, raw[0].connectorType),
              ),
            )
            .limit(1);
          if (existing.length) {
            await db.delete(memoryContacts).where(eq(memoryContacts.memoryId, existing[0].id));
            await db.delete(memories).where(eq(memories.id, existing[0].id));
          }

          await this.cleanQueue.add(
            'clean',
            { rawEventId },
            {
              attempts: 3,
              backoff: { type: 'exponential', delay: 5000 },
            },
          );
          retried++;
        } catch (err) {
          this.logger.warn(
            'Pipeline retry failed for job',
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }

    // Enrich failures: re-add directly
    const enrichFailed = await this.enrichQueue.getFailed(0, BATCH);
    for (const fjob of enrichFailed) {
      try {
        const { name, data } = fjob;
        await fjob.remove();
        await this.enrichQueue.add(name, data, {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
        });
        retried++;
      } catch (err) {
        this.logger.warn(
          'Pipeline retry failed for enrich job',
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    // Clean failed sync jobs from BullMQ
    const failedSync = await this.syncQueue.getFailed(0, BATCH);
    await Promise.allSettled(failedSync.map((fjob) => fjob.remove()));

    return { ok: true, retried };
  }

  @RequiresJwt()
  @Delete(':id')
  async cancel(@Param('id') id: string) {
    await this.jobsService.cancel(id);
    return { ok: true };
  }
}
