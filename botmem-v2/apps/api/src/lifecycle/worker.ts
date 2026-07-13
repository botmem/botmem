import { LifecycleLeaseLostError, type LifecycleJobClaim } from './domain.js';
import type {
  LifecycleArtifactStorePort,
  LifecycleArtifactWriterPort,
  LifecycleClockPort,
  LifecycleTelemetryPort,
  LifecycleWorkerRepositoryPort,
} from './ports.js';

export interface WorkspaceLifecycleWorkerOptions {
  readonly workerId: string;
  readonly leaseMs?: number;
  readonly exportPageSize?: number;
  readonly exportRetentionMs?: number;
  readonly pollIntervalMs?: number;
}

export class WorkspaceLifecycleWorker {
  private readonly startedAt: string;
  private readonly leaseMs: number;
  private readonly exportPageSize: number;
  private readonly exportRetentionMs: number;
  private readonly pollIntervalMs: number;

  constructor(
    private readonly jobs: LifecycleWorkerRepositoryPort,
    private readonly artifacts: LifecycleArtifactStorePort,
    private readonly clock: LifecycleClockPort,
    private readonly telemetry: LifecycleTelemetryPort,
    private readonly options: WorkspaceLifecycleWorkerOptions,
  ) {
    if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(options.workerId)) {
      throw new Error('lifecycle worker ID is invalid');
    }
    this.leaseMs = options.leaseMs ?? 5 * 60_000;
    this.exportPageSize = options.exportPageSize ?? 200;
    this.exportRetentionMs = options.exportRetentionMs ?? 7 * 86_400_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    if (this.leaseMs < 30_000 || this.leaseMs > 15 * 60_000) {
      throw new RangeError('lifecycle lease must be between 30 seconds and 15 minutes');
    }
    if (this.exportPageSize < 1 || this.exportPageSize > 1_000) {
      throw new RangeError('lifecycle export page size must be between 1 and 1000');
    }
    if (this.exportRetentionMs < 60_000 || this.exportRetentionMs > 31 * 86_400_000) {
      throw new RangeError('lifecycle export retention must be between one minute and 31 days');
    }
    if (this.pollIntervalMs < 100 || this.pollIntervalMs > 60_000) {
      throw new RangeError('lifecycle poll interval must be between 100ms and one minute');
    }
    this.startedAt = new Date(this.clock.nowMs()).toISOString();
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const worked = await this.runOnce();
      if (!worked) await wait(this.pollIntervalMs, signal);
    }
  }

  async runOnce(): Promise<boolean> {
    const nowMs = this.clock.nowMs();
    const now = new Date(nowMs).toISOString();
    await this.jobs.heartbeat({
      workerId: this.options.workerId,
      startedAt: this.startedAt,
      seenAt: now,
    });
    await this.purgeExpired(now);
    const job = await this.jobs.claim({
      workerId: this.options.workerId,
      claimedAt: now,
      leaseExpiresAt: new Date(nowMs + this.leaseMs).toISOString(),
    });
    if (!job) return false;
    this.telemetry.event({ event: 'claimed', jobId: job.jobId, kind: job.kind });
    if (job.kind === 'export') await this.processExport(job);
    else await this.processDeletion(job);
    return true;
  }

  ready(): Promise<boolean> {
    return this.artifacts.ready();
  }

  private async processExport(job: LifecycleJobClaim): Promise<void> {
    let writer: LifecycleArtifactWriterPort | undefined;
    let artifactKey: string | undefined;
    let failureCode = 'EXPORT_STORAGE_FAILED';
    try {
      writer = await this.artifacts.create({ workspaceId: job.workspaceId, jobId: job.jobId });
      await writer.write(
        `${JSON.stringify({
          type: 'manifest',
          version: 2,
          workspaceId: job.workspaceId,
          exportedAt: new Date(this.clock.nowMs()).toISOString(),
          contentBoundary: 'hosted-only',
          localContentIncluded: false,
          credentialsIncluded: false,
        })}\n`,
      );

      let cursor: { readonly accountId: string; readonly sourceEventId: string } | null = null;
      do {
        failureCode = 'EXPORT_READ_FAILED';
        const nowMs = this.clock.nowMs();
        const now = new Date(nowMs).toISOString();
        const renewed = await this.jobs.renewLease({
          jobId: job.jobId,
          workerId: this.options.workerId,
          now,
          leaseExpiresAt: new Date(nowMs + this.leaseMs).toISOString(),
        });
        if (!renewed) throw new LifecycleLeaseLostError();
        const page = await this.jobs.readExportPage({
          jobId: job.jobId,
          workerId: this.options.workerId,
          now,
          cursor,
          pageSize: this.exportPageSize,
        });
        failureCode = 'EXPORT_STORAGE_FAILED';
        for (const item of page.items) {
          // Only user-owned hosted event fields are emitted. Internal hashes,
          // encrypted credentials, projection data, and local device content
          // are absent from this contract.
          await writer.write(
            `${JSON.stringify({
              type: 'hosted_event',
              connector: item.connector,
              sourceEventId: item.sourceEventId,
              sourceRevision: item.sourceRevision,
              kind: item.kind,
              occurredAt: item.occurredAt,
              observedAt: item.observedAt,
              payload: item.payload,
              tombstone: item.tombstone,
            })}\n`,
          );
        }
        cursor = page.nextCursor;
      } while (cursor);

      artifactKey = await writer.commit();
      writer = undefined;
      failureCode = 'EXPORT_FINALIZE_FAILED';
      const completedMs = this.clock.nowMs();
      const completed = await this.jobs.completeExport({
        jobId: job.jobId,
        workerId: this.options.workerId,
        completedAt: new Date(completedMs).toISOString(),
        artifactKey,
        artifactExpiresAt: new Date(completedMs + this.exportRetentionMs).toISOString(),
      });
      if (!completed) throw new LifecycleLeaseLostError();
      this.telemetry.event({ event: 'completed', jobId: job.jobId, kind: 'export' });
    } catch (error) {
      await writer?.abort().catch(() => undefined);
      if (artifactKey) await this.artifacts.delete(artifactKey).catch(() => undefined);
      await this.recordFailure(
        job,
        error instanceof LifecycleLeaseLostError ? 'LEASE_LOST' : failureCode,
      );
    }
  }

  private async processDeletion(job: LifecycleJobClaim): Promise<void> {
    let failureCode = 'EXPORT_ARTIFACT_PURGE_FAILED';
    try {
      const blockerNowMs = this.clock.nowMs();
      const blockers = await this.jobs.deletionBlockers({
        jobId: job.jobId,
        workerId: this.options.workerId,
        now: new Date(blockerNowMs).toISOString(),
      });
      if (blockers.billingState !== 'confirmed' && blockers.billingState !== 'not_required') {
        const reason =
          blockers.billingState === 'dead'
            ? 'BILLING_CANCELLATION_DEAD'
            : 'BILLING_CANCELLATION_PENDING';
        const deferred = await this.jobs.deferDeletion({
          jobId: job.jobId,
          workerId: this.options.workerId,
          now: new Date(blockerNowMs).toISOString(),
          retryAt: new Date(blockerNowMs + 30_000).toISOString(),
          reason,
        });
        if (!deferred) throw new LifecycleLeaseLostError();
        this.telemetry.event({ event: 'retry', jobId: job.jobId, kind: 'deletion', code: reason });
        return;
      }
      const artifactNow = new Date(this.clock.nowMs()).toISOString();
      const deletionArtifacts = await this.jobs.listDeletionArtifacts({
        jobId: job.jobId,
        workerId: this.options.workerId,
        now: artifactNow,
      });
      for (const artifact of deletionArtifacts) {
        await this.artifacts.delete(artifact.artifactKey);
        if (!(await this.jobs.completeArtifactPurge(artifact.jobId))) {
          throw new LifecycleLeaseLostError();
        }
        this.telemetry.event({ event: 'artifact_purged', jobId: artifact.jobId });
      }
      // Removes crash-left temporary/reservation files as well as any orphaned
      // final file that never acquired a durable database locator.
      await this.artifacts.deleteWorkspace(job.workspaceId);
      failureCode = 'HOSTED_ERASE_FAILED';
      const completed = await this.jobs.completeDeletion({
        jobId: job.jobId,
        workerId: this.options.workerId,
        completedAt: new Date(this.clock.nowMs()).toISOString(),
      });
      if (!completed) throw new LifecycleLeaseLostError();
      this.telemetry.event({ event: 'completed', jobId: job.jobId, kind: 'deletion' });
    } catch (error) {
      await this.recordFailure(
        job,
        error instanceof LifecycleLeaseLostError ? 'LEASE_LOST' : failureCode,
      );
    }
  }

  private async recordFailure(job: LifecycleJobClaim, code: string): Promise<void> {
    const failedAtMs = this.clock.nowMs();
    const delay = Math.min(60 * 60_000, 30_000 * 2 ** Math.max(0, job.attempts - 1));
    const state = await this.jobs.fail({
      jobId: job.jobId,
      workerId: this.options.workerId,
      failedAt: new Date(failedAtMs).toISOString(),
      retryAt: new Date(failedAtMs + delay).toISOString(),
      failureCode: code,
    });
    if (state) {
      this.telemetry.event({ event: state, jobId: job.jobId, kind: job.kind, code });
    }
  }

  private async purgeExpired(now: string): Promise<void> {
    await this.jobs.purgeExpiredBillingAudits({ now, limit: 100 });
    const expired = await this.jobs.listExpiredArtifacts({ now, limit: 20 });
    for (const artifact of expired) {
      try {
        await this.artifacts.delete(artifact.artifactKey);
        if (await this.jobs.completeArtifactPurge(artifact.jobId)) {
          this.telemetry.event({ event: 'artifact_purged', jobId: artifact.jobId });
        }
      } catch {
        // A later iteration retries the same durable expired-artifact row.
      }
    }
  }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timeout = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done(): void {
      clearTimeout(timeout);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}
