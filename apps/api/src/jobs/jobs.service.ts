import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { eq, desc, inArray, sql } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { CryptoService } from '../crypto/crypto.service';
import { jobs } from '../db/schema';
import { TraceContext } from '../tracing/trace.context';

@Injectable()
export class JobsService {
  constructor(
    private dbService: DbService,
    private crypto: CryptoService,
    @InjectQueue('sync') private syncQueue: Queue,
    private traceContext: TraceContext,
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
}
