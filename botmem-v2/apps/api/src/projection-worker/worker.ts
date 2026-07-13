import type { RepairableProjection } from '../search/postgres-hosted-projection.js';
import type {
  ClaimedOutboxMessage,
  OutboxDispatcherPort,
  ProjectionWorkerClockPort,
  ProjectionWorkerReasonCode,
  ProjectionWorkerTelemetryPort,
} from './ports.js';
import type { HostedProjectionMaterializer, MaterializeProjectionResult } from './materializer.js';
import { projectionFailureReason } from './materializer.js';
import { OutboxSettlementConflictError } from './postgres-dispatcher.js';

export interface ProjectionRepairStorePort {
  listRepairable(input: {
    readonly workspaceId: string;
    readonly limit: number;
    readonly signal: AbortSignal;
  }): Promise<readonly RepairableProjection[]>;
}

export interface ProjectionWorkerOptions {
  readonly workerId: string;
  readonly batchSize?: number;
  readonly concurrency?: number;
  readonly pollMs?: number;
  readonly leaseMs?: number;
  readonly taskTimeoutMs?: number;
  readonly maxAttempts?: number;
  readonly backoffBaseMs?: number;
  readonly backoffMaxMs?: number;
  readonly repairIntervalMs?: number;
  readonly repairWorkspaceBatch?: number;
  readonly repairBatch?: number;
  readonly shutdownTimeoutMs?: number;
}

export interface ProjectionWorkerStatus {
  readonly running: boolean;
  readonly stopping: boolean;
  readonly activeTasks: number;
  readonly lastHeartbeatAt: string | null;
  readonly lastSuccessfulClaimAt: string | null;
}

interface NormalizedOptions {
  readonly workerId: string;
  readonly batchSize: number;
  readonly concurrency: number;
  readonly pollMs: number;
  readonly leaseMs: number;
  readonly taskTimeoutMs: number;
  readonly maxAttempts: number;
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
  readonly repairIntervalMs: number;
  readonly repairWorkspaceBatch: number;
  readonly repairBatch: number;
  readonly shutdownTimeoutMs: number;
}

/** Durable PostgreSQL outbox runner with bounded work, leases and repair. */
export class ProjectionOutboxWorker {
  private readonly options: NormalizedOptions;
  private readonly controller = new AbortController();
  private loop: Promise<void> | null = null;
  private activeTasks = 0;
  private stopping = false;
  private lastHeartbeatMs: number | null = null;
  private lastSuccessfulClaimMs: number | null = null;
  private nextRepairAtMs = 0;

  constructor(
    private readonly dispatcher: OutboxDispatcherPort,
    private readonly materializer: Pick<HostedProjectionMaterializer, 'project'>,
    private readonly repairStore: ProjectionRepairStorePort,
    private readonly telemetry: ProjectionWorkerTelemetryPort,
    options: ProjectionWorkerOptions,
    private readonly clock: ProjectionWorkerClockPort = { nowMs: () => Date.now() },
  ) {
    this.options = normalizeOptions(options);
  }

  start(): void {
    if (this.loop) return;
    if (this.controller.signal.aborted) throw new Error('projection worker cannot restart');
    this.lastHeartbeatMs = this.clock.nowMs();
    this.telemetry.event({ level: 'info', code: 'worker_started' });
    this.loop = this.runLoop();
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.waitForLoop();
    this.stopping = true;
    this.controller.abort();
    const deadline = shutdownDeadline(this.options.shutdownTimeoutMs);
    await Promise.race([this.waitForLoop(), deadline.promise]);
    deadline.dispose();
    this.telemetry.event({ level: 'info', code: 'worker_stopped' });
  }

  status(): ProjectionWorkerStatus {
    return Object.freeze({
      running: this.loop !== null && !this.stopping,
      stopping: this.stopping,
      activeTasks: this.activeTasks,
      lastHeartbeatAt: isoOrNull(this.lastHeartbeatMs),
      lastSuccessfulClaimAt: isoOrNull(this.lastSuccessfulClaimMs),
    });
  }

  isInternallyReady(maxHeartbeatAgeMs = Math.max(10_000, this.options.pollMs * 4)): boolean {
    if (!this.loop || this.stopping || this.lastHeartbeatMs === null) return false;
    return this.clock.nowMs() - this.lastHeartbeatMs <= maxHeartbeatAgeMs;
  }

  async runOnce(signal: AbortSignal = this.controller.signal): Promise<number> {
    throwIfAborted(signal);
    this.heartbeat();
    let messages: readonly ClaimedOutboxMessage[];
    try {
      messages = await this.dispatcher.claim({
        owner: this.options.workerId,
        limit: Math.min(this.options.batchSize, this.options.concurrency),
        leaseMs: this.options.leaseMs,
        signal,
      });
      this.lastSuccessfulClaimMs = this.clock.nowMs();
    } catch (error) {
      if (!signal.aborted) this.telemetry.event({ level: 'error', code: 'claim_failed' });
      throw error;
    }
    this.telemetry.metric({ name: 'outbox_claimed', value: messages.length });
    await Promise.all(messages.map((message) => this.processMessage(message, signal)));
    this.heartbeat();
    return messages.length;
  }

  async runRepairOnce(signal: AbortSignal = this.controller.signal): Promise<number> {
    throwIfAborted(signal);
    let repaired = 0;
    let afterWorkspaceId: string | undefined;
    for (;;) {
      const workspaceIds = await this.dispatcher.listRepairWorkspaces({
        ...(afterWorkspaceId ? { afterWorkspaceId } : {}),
        limit: this.options.repairWorkspaceBatch,
        signal,
      });
      for (const workspaceId of workspaceIds) {
        const repairs = await this.repairStore.listRepairable({
          workspaceId,
          limit: this.options.repairBatch,
          signal,
        });
        for (const repair of repairs) {
          try {
            await this.runRepair(workspaceId, repair, signal);
            repaired += 1;
            this.telemetry.metric({ name: 'projection_repaired', value: 1 });
          } catch (error) {
            if (signal.aborted) throw error;
            this.telemetry.event({ level: 'warn', code: 'repair_failed' });
            this.telemetry.metric({
              name: 'projection_failed',
              value: 1,
              reasonCode: 'repair_failed',
            });
          }
        }
      }
      if (workspaceIds.length < this.options.repairWorkspaceBatch) break;
      afterWorkspaceId = workspaceIds.at(-1);
    }
    this.heartbeat();
    return repaired;
  }

  private async runLoop(): Promise<void> {
    while (!this.controller.signal.aborted) {
      try {
        const count = await this.runOnce(this.controller.signal);
        if (this.clock.nowMs() >= this.nextRepairAtMs) {
          await this.runRepairOnce(this.controller.signal);
          this.nextRepairAtMs = this.clock.nowMs() + this.options.repairIntervalMs;
        }
        if (count === 0) await delay(this.options.pollMs, this.controller.signal);
      } catch {
        if (!this.controller.signal.aborted) {
          await delay(this.options.pollMs, this.controller.signal).catch(() => undefined);
        }
      }
      this.heartbeat();
    }
  }

  private async processMessage(
    message: ClaimedOutboxMessage,
    outerSignal: AbortSignal,
  ): Promise<void> {
    this.activeTasks += 1;
    const task = taskSignal(outerSignal, this.options.taskTimeoutMs);
    try {
      const result = await this.materializer.project({
        workspaceId: message.workspaceId,
        accountId: message.accountId,
        revisionId: message.revisionId,
        workerId: this.options.workerId,
        leaseExpiresAt: message.leaseExpiresAt,
        signal: task.signal,
      });
      await this.dispatcher.complete({
        messageId: message.messageId,
        owner: this.options.workerId,
        publishedAt: new Date(this.clock.nowMs()).toISOString(),
        signal: task.signal,
      });
      this.recordSuccess(result);
    } catch (error) {
      const timedOut = task.timedOut();
      const reason = timedOut
        ? 'task_timeout'
        : outerSignal.aborted
          ? 'task_cancelled'
          : projectionFailureReason(error);
      if (error instanceof OutboxSettlementConflictError) {
        this.telemetry.event({ level: 'warn', code: 'projection_settlement_conflict' });
        return;
      }
      await this.recordFailure(message, reason, outerSignal);
    } finally {
      task.dispose();
      this.activeTasks -= 1;
    }
  }

  private async recordFailure(
    message: ClaimedOutboxMessage,
    reason: ProjectionWorkerReasonCode,
    outerSignal: AbortSignal,
  ): Promise<void> {
    this.telemetry.event({ level: reason === 'task_cancelled' ? 'info' : 'warn', code: reason });
    this.telemetry.metric({ name: 'projection_failed', value: 1, reasonCode: reason });
    // Shutdown cancellation leaves the lease intact for another worker. A
    // projection commit followed by process loss is recovered the same way.
    if (outerSignal.aborted) return;
    const dead = message.attempt >= this.options.maxAttempts;
    const now = this.clock.nowMs();
    try {
      await this.dispatcher.fail({
        messageId: message.messageId,
        owner: this.options.workerId,
        dead,
        nextAttemptAt: new Date(now + (dead ? 0 : this.backoffMs(message.attempt))).toISOString(),
        signal: outerSignal,
      });
      this.telemetry.metric({
        name: dead ? 'outbox_dead' : 'outbox_retried',
        value: 1,
        reasonCode: reason,
      });
    } catch {
      this.telemetry.event({ level: 'warn', code: 'projection_settlement_conflict' });
    }
  }

  private async runRepair(
    workspaceId: string,
    repair: RepairableProjection,
    outerSignal: AbortSignal,
  ): Promise<void> {
    const task = taskSignal(outerSignal, this.options.taskTimeoutMs);
    try {
      await this.materializer.project({
        workspaceId,
        accountId: repair.accountId,
        revisionId: repair.revisionId,
        workerId: `${this.options.workerId}:repair`,
        leaseExpiresAt: new Date(this.clock.nowMs() + this.options.leaseMs).toISOString(),
        signal: task.signal,
      });
    } finally {
      task.dispose();
    }
  }

  private recordSuccess(result: MaterializeProjectionResult): void {
    this.telemetry.metric({ name: 'outbox_published', value: 1 });
    if (result.readiness === 'ready') {
      this.telemetry.metric({ name: 'search_probe_ready', value: 1 });
    } else {
      this.telemetry.event({ level: 'info', code: 'search_probe_deferred' });
      this.telemetry.metric({ name: 'search_probe_deferred', value: 1 });
    }
  }

  private backoffMs(attempt: number): number {
    const exponent = Math.min(30, Math.max(0, attempt - 1));
    const raw = Math.min(this.options.backoffMaxMs, this.options.backoffBaseMs * 2 ** exponent);
    const digest = [...this.options.workerId].reduce(
      (value, character) => value + character.charCodeAt(0),
      attempt,
    );
    return Math.min(this.options.backoffMaxMs, Math.round(raw * (0.875 + (digest % 251) / 1_000)));
  }

  private heartbeat(): void {
    this.lastHeartbeatMs = this.clock.nowMs();
  }

  private async waitForLoop(): Promise<void> {
    await this.loop?.catch(() => undefined);
  }
}

function normalizeOptions(options: ProjectionWorkerOptions): NormalizedOptions {
  const normalized: NormalizedOptions = Object.freeze({
    workerId: options.workerId,
    batchSize: options.batchSize ?? 16,
    concurrency: options.concurrency ?? 8,
    pollMs: options.pollMs ?? 1_000,
    leaseMs: options.leaseMs ?? 60_000,
    taskTimeoutMs: options.taskTimeoutMs ?? 45_000,
    maxAttempts: options.maxAttempts ?? 8,
    backoffBaseMs: options.backoffBaseMs ?? 1_000,
    backoffMaxMs: options.backoffMaxMs ?? 300_000,
    repairIntervalMs: options.repairIntervalMs ?? 300_000,
    repairWorkspaceBatch: options.repairWorkspaceBatch ?? 100,
    repairBatch: options.repairBatch ?? 100,
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? 20_000,
  });
  if (!/^[A-Za-z0-9._:-]{1,96}$/u.test(normalized.workerId))
    throw new TypeError('workerId is invalid');
  integerRange(normalized.batchSize, 1, 64, 'batchSize');
  integerRange(normalized.concurrency, 1, 64, 'concurrency');
  integerRange(normalized.pollMs, 50, 60_000, 'pollMs');
  integerRange(normalized.leaseMs, 5_000, 300_000, 'leaseMs');
  integerRange(normalized.taskTimeoutMs, 100, 290_000, 'taskTimeoutMs');
  integerRange(normalized.maxAttempts, 1, 100, 'maxAttempts');
  integerRange(normalized.backoffBaseMs, 100, 300_000, 'backoffBaseMs');
  integerRange(normalized.backoffMaxMs, normalized.backoffBaseMs, 3_600_000, 'backoffMaxMs');
  integerRange(normalized.repairIntervalMs, 1_000, 86_400_000, 'repairIntervalMs');
  integerRange(normalized.repairWorkspaceBatch, 1, 500, 'repairWorkspaceBatch');
  integerRange(normalized.repairBatch, 1, 500, 'repairBatch');
  integerRange(normalized.shutdownTimeoutMs, 100, 60_000, 'shutdownTimeoutMs');
  if (normalized.leaseMs < normalized.taskTimeoutMs + 5_000) {
    throw new RangeError('leaseMs must exceed taskTimeoutMs by at least 5000ms');
  }
  return normalized;
}

function taskSignal(
  parent: AbortSignal,
  timeoutMs: number,
): {
  readonly signal: AbortSignal;
  readonly timedOut: () => boolean;
  readonly dispose: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(parent.reason);
  parent.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  if (parent.aborted) abort();
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      parent.removeEventListener('abort', abort);
    },
  };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const finish = () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(abortError());
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function shutdownDeadline(ms: number): {
  readonly promise: Promise<void>;
  readonly dispose: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref();
  });
  return { promise, dispose: () => clearTimeout(timer) };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function abortError(): Error {
  const error = new Error('projection worker aborted');
  error.name = 'AbortError';
  return error;
}

function integerRange(value: number, minimum: number, maximum: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${field} is out of range`);
  }
}

function isoOrNull(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}
