import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { eq, desc, inArray, sql } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { jobs } from '../db/schema';

@Injectable()
export class JobsService {
  constructor(
    private dbService: DbService,
    @InjectQueue('sync') private syncQueue: Queue,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  async triggerSync(accountId: string, connectorType: string, accountIdentifier?: string) {
    const id = crypto.randomUUID();
    const now = new Date();

    await this.db.insert(jobs).values({
      id,
      accountId,
      connectorType,
      accountIdentifier: accountIdentifier || null,
      status: 'queued',
      priority: 0,
      progress: 0,
      total: 0,
      createdAt: now,
    });

    await this.syncQueue.add('sync', { accountId, connectorType, jobId: id }, {
      jobId: id,
    });

    const [job] = await this.db.select().from(jobs).where(eq(jobs.id, id));
    return job;
  }

  async getAll(filters?: { accountId?: string; connectorType?: string }) {
    const results = await this.db.select().from(jobs).orderBy(desc(jobs.createdAt));
    if (filters?.accountId) {
      return results.filter((j) => j.accountId === filters.accountId);
    }
    if (filters?.connectorType) {
      return results.filter((j) => j.connectorType === filters.connectorType);
    }
    return results;
  }

  async getActive() {
    const results = await this.db.select().from(jobs).orderBy(desc(jobs.createdAt));
    return results.filter((j) => j.status === 'running' || j.status === 'queued');
  }

  async getById(id: string) {
    const [job] = await this.db.select().from(jobs).where(eq(jobs.id, id));
    return job || null;
  }

  async updateJob(id: string, data: Partial<{ status: string; progress: number; total: number; error: string; startedAt: Date | string; completedAt: Date | string }>) {
    const toSet: any = { ...data };
    if (data.startedAt) toSet.startedAt = data.startedAt instanceof Date ? data.startedAt : new Date(data.startedAt);
    if (data.completedAt) toSet.completedAt = data.completedAt instanceof Date ? data.completedAt : new Date(data.completedAt);
    await this.db.update(jobs).set(toSet).where(eq(jobs.id, id));
  }

  async deleteJob(id: string) {
    await this.db.delete(jobs).where(eq(jobs.id, id));
  }

  async cancel(id: string) {
    await this.db.update(jobs).set({ status: 'cancelled', completedAt: new Date() }).where(eq(jobs.id, id));
    const bullJob = await this.syncQueue.getJob(id);
    if (bullJob) await bullJob.remove();
  }

  /**
   * Increment job progress by 1 and return the updated job.
   * Does NOT auto-mark the job as done -- that's handled by tryCompleteJob().
   */
  async incrementProgress(jobId: string): Promise<{ progress: number; total: number; done: boolean }> {
    await this.db.update(jobs)
      .set({ progress: sql`${jobs.progress} + 1` })
      .where(eq(jobs.id, jobId));

    const [job] = await this.db.select({ progress: jobs.progress, total: jobs.total, status: jobs.status })
      .from(jobs).where(eq(jobs.id, jobId));

    if (!job) return { progress: 0, total: 0, done: false };

    const progress = job.total > 0 ? Math.min(job.progress, job.total) : job.progress;
    return { progress, total: job.total, done: false };
  }

  /**
   * Check if a job can be marked done: progress >= total AND no items remain in pipeline queues.
   * Called by the enrich processor after incrementing progress.
   */
  async tryCompleteJob(jobId: string): Promise<boolean> {
    const [job] = await this.db.select({ progress: jobs.progress, total: jobs.total, status: jobs.status })
      .from(jobs).where(eq(jobs.id, jobId));

    if (!job || job.status !== 'running') return false;
    if (job.total <= 0 || job.progress < job.total) return false;

    await this.db.update(jobs).set({
      status: 'done',
      progress: job.total,
      completedAt: new Date(),
    }).where(eq(jobs.id, jobId));

    return true;
  }

  /**
   * Mark running jobs as failed if their BullMQ sync job is no longer active.
   * This catches jobs orphaned by server restarts or Redis flushes.
   */
  async markStaleRunning(): Promise<number> {
    const running = await this.db.select().from(jobs)
      .where(eq(jobs.status, 'running'));
    let marked = 0;
    for (const job of running) {
      const bullJob = await this.syncQueue.getJob(job.id);

      if (bullJob) {
        const isActive = await bullJob.isActive();
        const isCompleted = await bullJob.isCompleted();
        if (isActive || isCompleted) continue;
      }

      const startedAt = job.startedAt ? new Date(job.startedAt).getTime() : 0;
      const staleThreshold = 5 * 60 * 1000;
      if (Date.now() - startedAt < staleThreshold) continue;

      await this.db.update(jobs).set({
        status: 'failed',
        error: job.error || 'Pipeline stalled -- sync finished but not all items were processed',
        completedAt: job.completedAt || new Date(),
      }).where(eq(jobs.id, job.id));
      marked++;
    }
    return marked;
  }

  async cleanupDone() {
    const done = await this.db.select({ id: jobs.id }).from(jobs)
      .where(inArray(jobs.status, ['done', 'cancelled']));
    if (done.length === 0) return 0;
    for (const j of done) {
      await this.db.delete(jobs).where(eq(jobs.id, j.id));
    }
    return done.length;
  }
}
