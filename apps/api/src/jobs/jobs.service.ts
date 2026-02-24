import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { eq, desc, inArray } from 'drizzle-orm';
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
    const now = new Date().toISOString();

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

  async updateJob(id: string, data: Partial<{ status: string; progress: number; total: number; error: string; startedAt: string; completedAt: string }>) {
    await this.db.update(jobs).set(data).where(eq(jobs.id, id));
  }

  async cancel(id: string) {
    await this.db.update(jobs).set({ status: 'cancelled', completedAt: new Date().toISOString() }).where(eq(jobs.id, id));
    const bullJob = await this.syncQueue.getJob(id);
    if (bullJob) await bullJob.remove();
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
