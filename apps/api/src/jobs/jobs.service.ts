import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { eq, desc, inArray, sql, and, lt, isNull } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { CryptoService } from '../crypto/crypto.service';
import { jobs } from '../db/schema';
import { TraceContext } from '../tracing/trace.context';
import { EventsService } from '../events/events.service';

/** How long a job can stay "running" with no progress before being marked stale */
const STALE_JOB_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours

@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);
  constructor(
    private dbService: DbService,
    private crypto: CryptoService,
    @InjectQueue('sync') private syncQueue: Queue,
    private traceContext: TraceContext,
    private events: EventsService,
  ) {}

  /** Decrypt accountIdentifier on a job row */
  private decryptJob<T extends { accountIdentifier: string | null }>(row: T): T {
    return { ...row, accountIdentifier: this.crypto.decrypt(row.accountIdentifier) };
  }

  async triggerSync(
    accountId: string,
    connectorType: string,
    accountIdentifier?: string,
    memoryBankId?: string,
  ) {
    const id = crypto.randomUUID();
    const now = new Date();

    await this.dbService.withCurrentUser((db) =>
      db.insert(jobs).values({
        id,
        accountId,
        connectorType,
        accountIdentifier: accountIdentifier ? this.crypto.encrypt(accountIdentifier) : null,
        memoryBankId: memoryBankId || null,
        status: 'queued',
        priority: 0,
        progress: 0,
        total: 0,
        createdAt: now,
      }),
    );

    const trace = this.traceContext.current();
    await this.syncQueue.add(
      'sync',
      {
        accountId,
        connectorType,
        jobId: id,
        memoryBankId: memoryBankId || undefined,
        ...(trace ? { _trace: { traceId: trace.traceId, spanId: trace.spanId } } : {}),
      },
      {
        jobId: id,
      },
    );

    const [job] = await this.dbService.withCurrentUser((db) =>
      db.select().from(jobs).where(eq(jobs.id, id)),
    );
    return job ? this.decryptJob(job) : job;
  }

  async getAll(filters?: { accountId?: string; connectorType?: string }) {
    const results = (
      await this.dbService.withCurrentUser((db) =>
        db.select().from(jobs).orderBy(desc(jobs.createdAt)),
      )
    ).map((j) => this.decryptJob(j));
    if (filters?.accountId) {
      return results.filter((j) => j.accountId === filters.accountId);
    }
    if (filters?.connectorType) {
      return results.filter((j) => j.connectorType === filters.connectorType);
    }
    return results;
  }

  async getActive() {
    const results = (
      await this.dbService.withCurrentUser((db) =>
        db.select().from(jobs).orderBy(desc(jobs.createdAt)),
      )
    ).map((j) => this.decryptJob(j));
    return results.filter((j) => j.status === 'running' || j.status === 'queued');
  }

  async getById(id: string) {
    const [job] = await this.dbService.withCurrentUser((db) =>
      db.select().from(jobs).where(eq(jobs.id, id)),
    );
    return job ? this.decryptJob(job) : null;
  }

  async updateJob(
    id: string,
    data: Partial<{
      status: string;
      progress: number;
      total: number;
      error: string;
      startedAt: Date | string;
      completedAt: Date | string;
    }>,
  ) {
    const toSet: Record<string, unknown> = { ...data };
    if (data.startedAt)
      toSet.startedAt = data.startedAt instanceof Date ? data.startedAt : new Date(data.startedAt);
    if (data.completedAt)
      toSet.completedAt =
        data.completedAt instanceof Date ? data.completedAt : new Date(data.completedAt);
    // updateJob is called from BullMQ processors (outside HTTP context) — use unscoped db
    // since the job row is already validated to belong to the correct user via the processor's
    // withUserId() scope. Direct db access is intentional here for cross-context compatibility.
    await this.dbService.db.update(jobs).set(toSet).where(eq(jobs.id, id));
  }

  async deleteJob(id: string) {
    await this.dbService.withCurrentUser((db) => db.delete(jobs).where(eq(jobs.id, id)));
  }

  async cancel(id: string) {
    await this.dbService.withCurrentUser((db) =>
      db.update(jobs).set({ status: 'cancelled', completedAt: new Date() }).where(eq(jobs.id, id)),
    );
    const bullJob = await this.syncQueue.getJob(id);
    if (bullJob) await bullJob.remove();
  }

  /**
   * Increment job progress by 1 and return the updated job.
   * Does NOT auto-mark the job as done -- that's handled by tryCompleteJob().
   *
   * Note: called from BullMQ processors (outside HTTP context) — uses unscoped db
   * intentionally, as processors use withUserId() for their own scope already.
   */
  async incrementProgress(
    jobId: string,
  ): Promise<{ progress: number; total: number; done: boolean }> {
    await this.dbService.db
      .update(jobs)
      .set({ progress: sql`${jobs.progress} + 1` })
      .where(eq(jobs.id, jobId));

    const [job] = await this.dbService.db
      .select({ progress: jobs.progress, total: jobs.total, status: jobs.status })
      .from(jobs)
      .where(eq(jobs.id, jobId));

    if (!job) return { progress: 0, total: 0, done: false };

    const progress = job.total > 0 ? Math.min(job.progress, job.total) : job.progress;
    return { progress, total: job.total, done: false };
  }

  /**
   * Check if a job can be marked done: progress >= total AND no items remain in pipeline queues.
   * Called by the enrich processor after incrementing progress.
   *
   * Note: called from BullMQ processors (outside HTTP context) — uses unscoped db
   * intentionally, as processors use withUserId() for their own scope already.
   */
  async tryCompleteJob(jobId: string): Promise<boolean> {
    const [job] = await this.dbService.db
      .select({ progress: jobs.progress, total: jobs.total, status: jobs.status })
      .from(jobs)
      .where(eq(jobs.id, jobId));

    if (!job || job.status !== 'running') return false;
    if (job.total <= 0 || job.progress < job.total) return false;

    await this.dbService.db
      .update(jobs)
      .set({
        status: 'done',
        progress: job.total,
        completedAt: new Date(),
      })
      .where(eq(jobs.id, jobId));

    return true;
  }

  async cleanupDone() {
    const done = await this.dbService.withCurrentUser((db) =>
      db
        .select({ id: jobs.id })
        .from(jobs)
        .where(inArray(jobs.status, ['done', 'cancelled'])),
    );
    if (done.length === 0) return 0;
    for (const j of done) {
      await this.dbService.withCurrentUser((db) => db.delete(jobs).where(eq(jobs.id, j.id)));
    }
    return done.length;
  }

  /**
   * Find jobs stuck in "running" status for longer than STALE_JOB_THRESHOLD_MS
   * and mark them as failed. Called periodically from SyncProcessor.onModuleInit.
   */
  async reapStaleJobs(): Promise<number> {
    const cutoff = new Date(Date.now() - STALE_JOB_THRESHOLD_MS);
    const stale = await this.dbService.db
      .select({
        id: jobs.id,
        connectorType: jobs.connectorType,
        progress: jobs.progress,
        total: jobs.total,
      })
      .from(jobs)
      .where(and(eq(jobs.status, 'running'), lt(jobs.startedAt, cutoff), isNull(jobs.completedAt)));

    for (const job of stale) {
      const error = `Job stalled — stuck in "running" for over ${STALE_JOB_THRESHOLD_MS / 3600000}h (progress: ${job.progress}/${job.total})`;
      await this.dbService.db
        .update(jobs)
        .set({ status: 'failed', error, completedAt: new Date() })
        .where(eq(jobs.id, job.id));
      this.logger.warn(`[reaper] Marked stale job ${job.id} (${job.connectorType}) as failed`);
      this.events.emitToChannel(`job:${job.id}`, 'job:complete', {
        jobId: job.id,
        status: 'failed',
      });
      this.events.emitToChannel('dashboard', 'dashboard:jobs', {
        trigger: 'job_reaped',
        jobId: job.id,
      });
    }

    return stale.length;
  }
}
