import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Job as BullJob, Queue } from 'bullmq';
import { eq, desc, inArray, sql, and, lt, isNull, or, gt } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { CryptoService } from '../crypto/crypto.service';
import { jobs, accounts } from '../db/schema';
import { TraceContext } from '../tracing/trace.context';
import { EventsService } from '../events/events.service';
import { QuotaService } from '../billing/quota.service';

/** How long a job can stay "running" with no progress before being marked stale */
const STALE_JOB_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours
const WHATSAPP_HISTORY_CURSOR = 'whatsapp-history-v1';

@Injectable()
export class JobsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(JobsService.name);
  constructor(
    private dbService: DbService,
    private crypto: CryptoService,
    @InjectQueue('sync') private syncQueue: Queue,
    private traceContext: TraceContext,
    private events: EventsService,
    private quotaService: QuotaService,
  ) {}

  async onApplicationBootstrap() {
    await this.reconcileCompletedBullJobs();
    if (process.env.BOTMEM_SKIP_JOB_RECOVERY !== '1') {
      await this.recoverStaleState();
    }
    await this.cleanOrphanedRepeatJobs();
  }

  /**
   * Recover work interrupted by a process restart.
   *
   * Older startup logic marked these rows failed, which made the UI truthful but stranded
   * retryable work. A restart is not a connector failure, so keep the original job row and
   * requeue it with the same BullMQ id.
   */
  private async recoverStaleState() {
    const recentRestartCutoff = new Date(Date.now() - 15 * 60 * 1000);
    const candidates = await this.dbService.db
      .select({
        id: jobs.id,
        accountId: jobs.accountId,
        connectorType: jobs.connectorType,
        memoryBankId: jobs.memoryBankId,
        status: jobs.status,
        error: jobs.error,
      })
      .from(jobs)
      .where(
        or(
          inArray(jobs.status, ['queued', 'running']),
          and(
            eq(jobs.status, 'failed'),
            eq(jobs.error, 'Server restarted'),
            gt(jobs.completedAt, recentRestartCutoff),
          ),
        ),
      )
      .orderBy(desc(jobs.createdAt))
      .limit(100);

    const activeAccounts = new Set(
      candidates
        .filter((job) => job.status === 'queued' || job.status === 'running')
        .map((job) => job.accountId),
    );
    const recoveredFailedAccounts = new Set<string>();
    let requeued = 0;
    for (const job of candidates) {
      if (
        job.connectorType === 'whatsapp' &&
        (await this.hasCompletedWhatsAppHistory(job.accountId))
      ) {
        const now = new Date();
        await this.dbService.db
          .update(jobs)
          .set({
            status: 'cancelled',
            error: 'Cancelled stale WhatsApp sync; realtime handles updates after initial history',
            completedAt: now,
          })
          .where(eq(jobs.id, job.id));
        await this.dbService.db
          .update(accounts)
          .set({ status: 'connected', lastError: null, updatedAt: now })
          .where(eq(accounts.id, job.accountId));
        continue;
      }

      // For previously failed restart rows, only recover the latest one per account. Queued/running
      // rows are already unique in normal operation and should all be restored.
      if (job.status === 'failed') {
        if (activeAccounts.has(job.accountId)) continue;
        if (recoveredFailedAccounts.has(job.accountId)) continue;
        recoveredFailedAccounts.add(job.accountId);
      }

      const existingBullJob = await this.syncQueue.getJob(job.id);
      if (existingBullJob) {
        const state = await existingBullJob.getState().catch(() => 'unknown');
        if (state === 'active' || state === 'waiting' || state === 'delayed') continue;
        await existingBullJob.remove().catch(() => undefined);
      }

      await this.dbService.db
        .update(jobs)
        .set({
          status: 'queued',
          error: null,
          startedAt: null,
          completedAt: null,
        })
        .where(eq(jobs.id, job.id));

      await this.dbService.db
        .update(accounts)
        .set({ status: 'connected', lastError: null })
        .where(eq(accounts.id, job.accountId));

      await this.syncQueue.add(
        'sync',
        {
          accountId: job.accountId,
          connectorType: job.connectorType,
          jobId: job.id,
          memoryBankId: job.memoryBankId || undefined,
        },
        { jobId: job.id },
      );
      requeued++;
    }

    if (requeued > 0) {
      this.logger.log(`[startup] Requeued ${requeued} restart-interrupted sync job(s)`);
    }
  }

  private async hasCompletedWhatsAppHistory(accountId: string): Promise<boolean> {
    const [account] = await this.dbService.db
      .select({ lastCursor: accounts.lastCursor })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);
    return account?.lastCursor === WHATSAPP_HISTORY_CURSOR;
  }

  /** Remove BullMQ repeat jobs whose accounts no longer exist. */
  private async cleanOrphanedRepeatJobs() {
    const repeatJobs = await this.syncQueue.getRepeatableJobs();
    let removed = 0;

    for (const rj of repeatJobs) {
      // Repeatable job names follow pattern: scheduled:<accountId>
      const accountId = rj.name?.replace('scheduled:', '');
      if (!accountId) continue;

      const [acct] = await this.dbService.db
        .select({ id: accounts.id })
        .from(accounts)
        .where(eq(accounts.id, accountId))
        .limit(1);

      if (!acct) {
        await this.syncQueue.removeRepeatableByKey(rj.key);
        removed++;
      }
    }

    if (removed > 0) {
      this.logger.log(`[startup] Removed ${removed} orphaned repeat job(s)`);
    }
  }

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
    // Prevent concurrent syncs for the same account — skip if one is already queued/running
    const [existing] = await this.dbService.withCurrentUser((db) =>
      db
        .select({ id: jobs.id, status: jobs.status })
        .from(jobs)
        .where(and(eq(jobs.accountId, accountId), inArray(jobs.status, ['queued', 'running'])))
        .limit(1),
    );
    if (existing) {
      this.logger.log(
        `Skipping sync for account ${accountId} — job ${existing.id} already ${existing.status}`,
      );
      const [job] = await this.dbService.withCurrentUser((db) =>
        db.select().from(jobs).where(eq(jobs.id, existing.id)),
      );
      return job ? this.decryptJob(job) : job;
    }

    // Advisory quota check — warn user if at limit (sync still proceeds for contacts)
    const [acctRow] = await this.dbService.db
      .select({ userId: accounts.userId })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);
    if (acctRow?.userId) {
      const quota = await this.quotaService.canCreateMemory(acctRow.userId);
      if (!quota.allowed) {
        this.events.emitToChannel(`user:${acctRow.userId}`, 'quota:warning', {
          accountId,
          connectorType,
          used: quota.used,
          limit: quota.limit,
        });
      }
    }

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

  async startScheduledSync(accountId: string, connectorType: string) {
    const [existing] = await this.dbService.db
      .select({ id: jobs.id, status: jobs.status })
      .from(jobs)
      .where(and(eq(jobs.accountId, accountId), inArray(jobs.status, ['queued', 'running'])))
      .limit(1);

    const [account] = await this.dbService.db
      .select({
        identifier: accounts.identifier,
        userId: accounts.userId,
        lastCursor: accounts.lastCursor,
      })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);

    if (connectorType === 'whatsapp' && account?.lastCursor === WHATSAPP_HISTORY_CURSOR) {
      const id = crypto.randomUUID();
      const now = new Date();
      const error = 'Skipped scheduled sync; WhatsApp uses realtime after initial history sync';
      await this.dbService.db.insert(jobs).values({
        id,
        accountId,
        connectorType,
        accountIdentifier: account?.identifier ? this.crypto.encrypt(account.identifier) : null,
        memoryBankId: null,
        status: 'cancelled',
        priority: 0,
        progress: 0,
        total: 0,
        error,
        createdAt: now,
        completedAt: now,
      });
      this.logger.log(`Skipping scheduled sync for account ${accountId} — ${error}`);
      const [row] = await this.dbService.db.select().from(jobs).where(eq(jobs.id, id));
      return { skipped: true, job: row ? this.decryptJob(row) : row };
    }

    if (existing) {
      const id = crypto.randomUUID();
      const now = new Date();
      const error = `Skipped scheduled sync because job ${existing.id} is already ${existing.status}`;
      await this.dbService.db.insert(jobs).values({
        id,
        accountId,
        connectorType,
        accountIdentifier: account?.identifier ? this.crypto.encrypt(account.identifier) : null,
        memoryBankId: null,
        status: 'cancelled',
        priority: 0,
        progress: 0,
        total: 0,
        error,
        createdAt: now,
        completedAt: now,
      });
      this.logger.log(`Skipping scheduled sync for account ${accountId} — ${error}`);
      const [row] = await this.dbService.db.select().from(jobs).where(eq(jobs.id, id));
      return { skipped: true, job: row ? this.decryptJob(row) : row };
    }

    if (account?.userId) {
      const quota = await this.quotaService.canCreateMemory(account.userId);
      if (!quota.allowed) {
        this.events.emitToChannel(`user:${account.userId}`, 'quota:warning', {
          accountId,
          connectorType,
          used: quota.used,
          limit: quota.limit,
        });
      }
    }

    const id = crypto.randomUUID();
    const now = new Date();
    await this.dbService.db.insert(jobs).values({
      id,
      accountId,
      connectorType,
      accountIdentifier: account?.identifier ? this.crypto.encrypt(account.identifier) : null,
      memoryBankId: null,
      status: 'queued',
      priority: 0,
      progress: 0,
      total: 0,
      createdAt: now,
    });

    const [row] = await this.dbService.db.select().from(jobs).where(eq(jobs.id, id));
    return { skipped: false, job: row ? this.decryptJob(row) : row };
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

  /** Get all jobs belonging to a specific user's accounts (DB-level filtering). */
  async getAllForUser(userId: string, filters?: { accountId?: string }) {
    const userAccountRows = await this.dbService.withCurrentUser((db) =>
      db.select({ id: accounts.id }).from(accounts).where(eq(accounts.userId, userId)),
    );
    const userAccountIds = userAccountRows.map((a) => a.id);
    if (userAccountIds.length === 0) return [];

    const conditions = [inArray(jobs.accountId, userAccountIds)];
    if (filters?.accountId) conditions.push(eq(jobs.accountId, filters.accountId));

    const results = await this.dbService.withCurrentUser((db) =>
      db
        .select()
        .from(jobs)
        .where(and(...conditions))
        .orderBy(desc(jobs.createdAt)),
    );
    return results.map((j) => this.decryptJob(j));
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
      error: string | null;
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
    if (data.completedAt === null) toSet.completedAt = null;
    if (data.status === 'queued' || data.status === 'running') {
      toSet.completedAt = null;
    }
    // updateJob is called from BullMQ processors (outside HTTP context) — use unscoped db
    // since the job row is already validated to belong to the correct user via the processor's
    // withUserId() scope. Direct db access is intentional here for cross-context compatibility.
    await this.dbService.db.update(jobs).set(toSet).where(eq(jobs.id, id));
  }

  async getQueueStats(queues: Record<string, Queue>) {
    const stats: Record<
      string,
      {
        waiting: number;
        active: number;
        completed: number;
        failed: number;
        delayed: number;
        contradictions?: Array<{
          jobId: string;
          dbStatus?: string;
          bullState: string;
          action: string;
        }>;
      }
    > = {};
    for (const [name, queue] of Object.entries(queues)) {
      const counts = await queue.getJobCounts(
        'waiting',
        'active',
        'completed',
        'failed',
        'delayed',
      );
      stats[name] = {
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        completed: counts.completed ?? 0,
        failed: counts.failed ?? 0,
        delayed: counts.delayed ?? 0,
      };
    }
    if (queues.sync) {
      const contradictions = await this.findSyncContradictions(queues.sync, true);
      if (contradictions.length) stats.sync.contradictions = contradictions;
    }
    for (const legacyName of ['embed', 'enrich']) {
      const legacy = stats[legacyName];
      if (!legacy) continue;
      if (legacy.waiting || legacy.active || legacy.failed || legacy.delayed) {
        legacy.contradictions = [
          {
            jobId: '*',
            bullState: 'legacy_work_present',
            action: 'legacy queue work should be migrated to memory',
          },
        ];
      }
    }
    return stats;
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
      .select({
        accountId: jobs.accountId,
        progress: jobs.progress,
        total: jobs.total,
        status: jobs.status,
      })
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
      .select({
        accountId: jobs.accountId,
        progress: jobs.progress,
        total: jobs.total,
        status: jobs.status,
      })
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

    await this.dbService.db
      .update(accounts)
      .set({ status: 'connected', lastError: null, updatedAt: new Date() })
      .where(and(eq(accounts.id, job.accountId), eq(accounts.status, 'syncing')));

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
    await this.reconcileCompletedBullJobs();

    const cutoff = new Date(Date.now() - STALE_JOB_THRESHOLD_MS);
    const stale = await this.dbService.db
      .select({
        id: jobs.id,
        accountId: jobs.accountId,
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
      await this.dbService.db
        .update(accounts)
        .set({ status: 'failed', lastError: error, updatedAt: new Date() })
        .where(eq(accounts.id, job.accountId));
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

  async reconcileCompletedBullJobs(): Promise<number> {
    const cleaned = await this.findSyncContradictions(this.syncQueue, true);
    if (cleaned.length > 0) {
      this.logger.warn(`[reconciler] Found ${cleaned.length} DB/BullMQ contradiction(s)`);
    }

    const activeRowsResult = await this.dbService.db
      .select({
        id: jobs.id,
        accountId: jobs.accountId,
        progress: jobs.progress,
        total: jobs.total,
      })
      .from(jobs)
      .where(and(eq(jobs.status, 'running'), isNull(jobs.completedAt)));
    const activeRows = Array.isArray(activeRowsResult) ? activeRowsResult : [];

    let reconciled = 0;
    for (const row of activeRows) {
      const bullJob = (await this.syncQueue.getJob(row.id)) as BullJob | null;
      if (!bullJob) continue;
      const state = await bullJob.getState();
      if (state !== 'completed') continue;
      if (row.total > 0 && row.progress < row.total) continue;

      await this.dbService.db
        .update(jobs)
        .set({
          status: 'done',
          progress: row.total > 0 ? row.total : row.progress,
          completedAt: new Date(),
          error: null,
        })
        .where(eq(jobs.id, row.id));
      await this.dbService.db
        .update(accounts)
        .set({ status: 'connected', lastError: null, updatedAt: new Date() })
        .where(and(eq(accounts.id, row.accountId), eq(accounts.status, 'syncing')));
      this.events.emitToChannel(`job:${row.id}`, 'job:complete', {
        jobId: row.id,
        status: 'done',
      });
      reconciled++;
    }

    if (reconciled > 0) {
      this.logger.log(`[reconciler] Marked ${reconciled} completed BullMQ job(s) done in DB`);
    }
    return reconciled;
  }

  private async findSyncContradictions(
    queue: Queue,
    repair: boolean,
  ): Promise<Array<{ jobId: string; dbStatus?: string; bullState: string; action: string }>> {
    const terminalRowsResult = await this.dbService.db
      .select({ id: jobs.id, status: jobs.status })
      .from(jobs)
      .where(inArray(jobs.status, ['done', 'failed', 'cancelled']));
    const terminalRows = Array.isArray(terminalRowsResult) ? terminalRowsResult : [];
    const contradictions: Array<{
      jobId: string;
      dbStatus?: string;
      bullState: string;
      action: string;
    }> = [];
    const now = Date.now();
    for (const row of terminalRows) {
      const bullJob = (await queue.getJob(row.id)) as BullJob | null;
      if (!bullJob) continue;
      const state = await bullJob.getState();
      if (!['active', 'waiting', 'delayed'].includes(state)) continue;
      const processedOn = typeof bullJob.processedOn === 'number' ? bullJob.processedOn : 0;
      const oldEnough = state !== 'active' || processedOn === 0 || now - processedOn > 30_000;
      let action = 'reported';
      if (repair && oldEnough) {
        try {
          await bullJob.remove();
          action = 'removed_bullmq_entry';
        } catch (err) {
          action = `remove_failed:${err instanceof Error ? err.message : String(err)}`;
        }
      }
      contradictions.push({ jobId: row.id, dbStatus: row.status, bullState: state, action });
    }
    return contradictions;
  }

  /** Remove all BullMQ repeatable jobs for a given account. Called when an account is deleted. */
  async removeRepeatableJobsForAccount(accountId: string): Promise<number> {
    const repeatJobs = await this.syncQueue.getRepeatableJobs();
    let removed = 0;

    for (const rj of repeatJobs) {
      if (rj.name === `scheduled:${accountId}`) {
        await this.syncQueue.removeRepeatableByKey(rj.key);
        removed++;
      }
    }

    if (removed > 0) {
      this.logger.log(`Removed ${removed} repeatable job(s) for account ${accountId}`);
    }
    return removed;
  }
}
