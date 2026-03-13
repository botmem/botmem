import { Controller, Get, Post, Delete, Param, Query, Body, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { eq, and, or } from 'drizzle-orm';
import { JobsService } from './jobs.service';
import { AccountsService } from '../accounts/accounts.service';
import { MemoryBanksService } from '../memory-banks/memory-banks.service';
import { DbService } from '../db/db.service';
import { EventsService } from '../events/events.service';
import { rawEvents, memories, memoryContacts, memoryLinks, accounts } from '../db/schema';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { generateTraceId, generateSpanId } from '../tracing/trace.context';
import { Throttle } from '@nestjs/throttler';
import { RequiresJwt } from '../user-auth/decorators/requires-jwt.decorator';
import { CurrentUser } from '../user-auth/decorators/current-user.decorator';
import type { Job } from '@botmem/shared';

function toApiJob(row: {
  id: string;
  connectorType: string;
  accountId: string;
  accountIdentifier: string | null;
  memoryBankId: string | null;
  status: string;
  priority: number;
  progress: number;
  total: number;
  startedAt: Date | null;
  completedAt: Date | null;
  error: string | null;
}): Job & { memoryBankId?: string | null } {
  return {
    id: row.id,
    connector: row.connectorType,
    accountId: row.accountId,
    accountIdentifier: row.accountIdentifier || null,
    memoryBankId: row.memoryBankId || null,
    status: row.status as Job['status'],
    priority: row.priority,
    progress: row.progress,
    total: row.total,
    startedAt:
      row.startedAt instanceof Date
        ? row.startedAt.toISOString()
        : (row.startedAt as string | null),
    completedAt:
      row.completedAt instanceof Date
        ? row.completedAt.toISOString()
        : (row.completedAt as string | null),
    error: row.error,
  };
}

@ApiTags('Jobs')
@ApiBearerAuth()
@Controller('jobs')
export class JobsController {
  private readonly logger = new Logger(JobsController.name);
  constructor(
    private jobsService: JobsService,
    private accountsService: AccountsService,
    private memoryBanksService: MemoryBanksService,
    private dbService: DbService,
    private events: EventsService,
    @InjectQueue('sync') private syncQueue: Queue,
    @InjectQueue('clean') private cleanQueue: Queue,
    @InjectQueue('embed') private embedQueue: Queue,
    @InjectQueue('enrich') private enrichQueue: Queue,
  ) {}

  @Get()
  async list(@CurrentUser() user: { id: string }, @Query('accountId') accountId?: string) {
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
    const [sync, clean, embed, enrich] = await Promise.all([
      getStats(this.syncQueue),
      getStats(this.cleanQueue),
      getStats(this.embedQueue),
      getStats(this.enrichQueue),
    ]);

    return { sync, clean, embed, enrich };
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const row = await this.jobsService.getById(id);
    if (!row) return { error: 'not found' };
    return toApiJob(row);
  }

  @RequiresJwt()
  @Post('sync/:accountId')
  async triggerSync(
    @CurrentUser() user: { id: string },
    @Param('accountId') accountId: string,
    @Body() body?: { memoryBankId?: string },
  ) {
    const account = await this.accountsService.getById(accountId);

    // Validate memoryBankId belongs to the current user if provided
    if (body?.memoryBankId) {
      await this.memoryBanksService.getById(user.id, body.memoryBankId);
    }

    const row = await this.jobsService.triggerSync(
      accountId,
      account.connectorType,
      account.identifier,
      body?.memoryBankId,
    );
    return { job: toApiJob(row) };
  }

  @Throttle({ default: { limit: 5, ttl: 60000 } })
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

    // Retry failed BullMQ pipeline jobs in batches, looping until all are retried
    const BATCH = 500;

    // Embed/clean failures: delete stale memory, then re-enqueue through clean
    for (const queue of [this.cleanQueue, this.embedQueue]) {
      let failed = await queue.getFailed(0, BATCH);
      while (failed.length > 0) {
        for (const fjob of failed) {
          try {
            const rawEventId = fjob.data?.rawEventId;
            await fjob.remove();
            if (!rawEventId) continue;

            await this.dbService.withCurrentUser(async (db) => {
              // Find the raw event to get source_id + connector_type
              const raw = await db
                .select({ sourceId: rawEvents.sourceId, connectorType: rawEvents.connectorType })
                .from(rawEvents)
                .where(eq(rawEvents.id, rawEventId))
                .limit(1);
              if (!raw.length) return;

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
                const memId = existing[0].id;
                await db
                  .delete(memoryLinks)
                  .where(
                    or(eq(memoryLinks.srcMemoryId, memId), eq(memoryLinks.dstMemoryId, memId)),
                  );
                await db.delete(memoryContacts).where(eq(memoryContacts.memoryId, memId));
                await db.delete(memories).where(eq(memories.id, memId));
              }
            });

            await this.cleanQueue.add(
              'clean',
              { rawEventId, _trace: { traceId: generateTraceId(), spanId: generateSpanId() } },
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
        failed = await queue.getFailed(0, BATCH);
      }
    }

    // Enrich failures: re-add directly
    let enrichFailed = await this.enrichQueue.getFailed(0, BATCH);
    while (enrichFailed.length > 0) {
      for (const fjob of enrichFailed) {
        try {
          const { name, data } = fjob;
          await fjob.remove();
          await this.enrichQueue.add(
            name,
            { ...data, _trace: { traceId: generateTraceId(), spanId: generateSpanId() } },
            {
              attempts: 3,
              backoff: { type: 'exponential', delay: 5000 },
            },
          );
          retried++;
        } catch (err) {
          this.logger.warn(
            'Pipeline retry failed for enrich job',
            err instanceof Error ? err.message : String(err),
          );
        }
      }
      enrichFailed = await this.enrichQueue.getFailed(0, BATCH);
    }

    // Clean failed sync jobs from BullMQ
    let failedSync = await this.syncQueue.getFailed(0, BATCH);
    while (failedSync.length > 0) {
      await Promise.allSettled(failedSync.map((fjob) => fjob.remove()));
      failedSync = await this.syncQueue.getFailed(0, BATCH);
    }

    // Notify frontend immediately so dashboard updates without waiting for poll
    this.events.emitToChannel('dashboard', 'dashboard:jobs', { trigger: 'retry_failed', retried });
    this.events.emitToChannel('dashboard', 'dashboard:queue-stats-changed', { ts: Date.now() });

    return { ok: true, retried };
  }

  @RequiresJwt()
  @Delete(':id')
  async cancel(@Param('id') id: string) {
    await this.jobsService.cancel(id);
    return { ok: true };
  }
}
