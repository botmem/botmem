import {
  ConnectorDomainError,
  HostedIngestionService,
  syncId,
  type ConnectorAccountSnapshot,
  type HostedIngestionUnitOfWork,
  type IngestionIdFactory,
  type JsonValue,
} from '@botmem-v2/connector-domain';
import { z } from 'zod';
import {
  GmailConnectorError,
  GmailSyncService,
  type GmailApiPort,
  type GmailClockPort,
  type GmailCredentialVaultPort,
  type GmailCryptoPort,
} from '../connectors/gmail/index.js';
import {
  OutlookConnectorError,
  OutlookSyncService,
  type OutlookClockPort,
  type OutlookCredentialVaultPort,
  type OutlookCryptoPort,
  type OutlookGraphApiPort,
} from '../connectors/outlook/index.js';
import {
  OwnTracksConnectorError,
  OwnTracksSyncService,
  type OwnTracksClockPort,
  type OwnTracksCredentialVaultPort,
  type OwnTracksHashPort,
  type OwnTracksLocationApiPort,
  type ValidatedOwnTracksEndpoint,
} from '../connectors/owntracks/index.js';
import { ConnectorCredentialError } from './ports.js';
import type { HostedSyncJobClaim, HostedSyncWorkerJobStore } from './hosted-sync-job-store.js';

const ownTracksConfigSchema = z
  .object({
    endpoint: z.string().url(),
    allowedPorts: z.array(z.number().int().min(1).max(65_535)).min(1).max(16),
  })
  .strict();

export interface HostedSyncAccountConfigReader {
  readConnectionConfig(claim: HostedSyncJobClaim): Promise<JsonValue | null>;
}

export interface HostedSyncTelemetryEvent {
  readonly event:
    | 'worker_started'
    | 'worker_heartbeat_failed'
    | 'job_claimed'
    | 'job_succeeded'
    | 'job_failed'
    | 'job_cancelled';
  readonly connector?: 'gmail' | 'outlook' | 'owntracks';
  readonly attempt?: number;
  readonly durationMs?: number;
  readonly failureCode?: string;
  readonly retryable?: boolean;
}

/** Telemetry receives an intentionally identifier-free, secret-free schema. */
export interface HostedSyncTelemetryPort {
  record(event: HostedSyncTelemetryEvent): void | Promise<void>;
}

export interface HostedSyncWorkerPolicy {
  readonly workerId: string;
  readonly maxRunMs: number;
  readonly leaseMs: number;
  readonly maxAttempts: number;
  readonly pollMs: number;
  readonly heartbeatMs: number;
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
}

export interface HostedSyncWorkerDependencies {
  readonly jobs: HostedSyncWorkerJobStore;
  readonly ingestionUnitOfWork: HostedIngestionUnitOfWork;
  readonly ids: IngestionIdFactory;
  readonly accountConfig: HostedSyncAccountConfigReader;
  readonly gmail: GmailApiPort;
  readonly gmailVault: GmailCredentialVaultPort;
  readonly outlook: OutlookGraphApiPort;
  readonly outlookVault: OutlookCredentialVaultPort;
  readonly owntracks: OwnTracksLocationApiPort;
  readonly ownTracksVault: OwnTracksCredentialVaultPort;
  readonly crypto: Pick<GmailCryptoPort & OutlookCryptoPort, 'sha256Hex'>;
  readonly ownTracksHash: OwnTracksHashPort;
  readonly clock: GmailClockPort & OutlookClockPort & Pick<OwnTracksClockPort, 'now'>;
  readonly telemetry: HostedSyncTelemetryPort;
  readonly policy: HostedSyncWorkerPolicy;
}

export class HostedSyncWorker {
  private readonly gmail: GmailSyncService;
  private readonly outlook: OutlookSyncService;
  private readonly owntracks: OwnTracksSyncService;

  constructor(private readonly dependencies: HostedSyncWorkerDependencies) {
    validatePolicy(dependencies.policy);
    const ingestion = new HostedIngestionService(
      dependencies.ingestionUnitOfWork,
      dependencies.ids,
    );
    this.gmail = new GmailSyncService(
      ingestion,
      dependencies.gmail,
      dependencies.gmailVault,
      dependencies.crypto,
      dependencies.clock,
    );
    this.outlook = new OutlookSyncService(
      ingestion,
      dependencies.outlook,
      dependencies.outlookVault,
      dependencies.crypto,
      dependencies.clock,
    );
    this.owntracks = new OwnTracksSyncService(
      ingestion,
      dependencies.owntracks,
      dependencies.ownTracksVault,
      dependencies.ownTracksHash,
      {
        now: () => dependencies.clock.now(),
        sleep: abortableSleep,
      },
    );
  }

  async runOnce(callerSignal?: AbortSignal): Promise<boolean> {
    await this.dependencies.jobs.heartbeat(
      this.dependencies.policy.workerId,
      this.dependencies.clock.now(),
    );
    return this.processOne(callerSignal);
  }

  async runForever(signal: AbortSignal): Promise<void> {
    await this.safeTelemetry({ event: 'worker_started' });
    try {
      await Promise.all([this.workLoop(signal), this.heartbeatLoop(signal)]);
    } catch (error) {
      // An abort is the expected graceful-shutdown path for both loops. Do not
      // turn a requested process stop into an unhandled worker failure.
      if (!signal.aborted) throw error;
    }
  }

  private async workLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const worked = await this.processOne(signal);
      if (!worked) await abortableSleep(this.dependencies.policy.pollMs, signal);
    }
  }

  private async heartbeatLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.dependencies.jobs.heartbeat(
          this.dependencies.policy.workerId,
          this.dependencies.clock.now(),
        );
      } catch {
        await this.safeTelemetry({
          event: 'worker_heartbeat_failed',
          failureCode: 'SYNC_HEARTBEAT_FAILED',
        });
      }
      await abortableSleep(this.dependencies.policy.heartbeatMs, signal);
    }
  }

  private async processOne(callerSignal?: AbortSignal): Promise<boolean> {
    if (callerSignal?.aborted) return false;
    const claimTime = this.dependencies.clock.now();
    const claim = await this.dependencies.jobs.claim({
      workerId: this.dependencies.policy.workerId,
      now: claimTime,
      leaseExpiresAt: new Date(
        Date.parse(claimTime) + this.dependencies.policy.leaseMs,
      ).toISOString(),
      maxAttempts: this.dependencies.policy.maxAttempts,
    });
    if (!claim) return false;

    const startedAtMs = Date.now();
    await this.safeTelemetry({
      event: 'job_claimed',
      connector: claim.connector,
      attempt: claim.attempt,
    });
    const deadline = new AbortController();
    const abortFromCaller = () => deadline.abort('worker_shutdown');
    callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
    const timeout = setTimeout(
      () => deadline.abort('sync_deadline'),
      this.dependencies.policy.maxRunMs,
    );
    try {
      const account = await this.dependencies.ingestionUnitOfWork.loadAccount(
        claim.tenantId,
        claim.accountId,
      );
      if (
        !account ||
        account.connector !== claim.connector ||
        (account.status !== 'ready' && account.status !== 'degraded')
      ) {
        await this.dependencies.jobs.cancel(
          claim,
          this.dependencies.clock.now(),
          'ACCOUNT_UNAVAILABLE',
        );
        await this.safeTelemetry({
          event: 'job_cancelled',
          connector: claim.connector,
          attempt: claim.attempt,
          failureCode: 'ACCOUNT_UNAVAILABLE',
        });
        return true;
      }
      await this.runConnector(claim, account, deadline.signal);
      const completedAt = this.dependencies.clock.now();
      await this.dependencies.jobs.complete(claim, completedAt);
      await this.safeTelemetry({
        event: 'job_succeeded',
        connector: claim.connector,
        attempt: claim.attempt,
        durationMs: Math.max(0, Date.now() - startedAtMs),
      });
      return true;
    } catch (error) {
      const failure = classifyFailure(error, deadline.signal, callerSignal);
      const failedAt = this.dependencies.clock.now();
      const retryDelay = retryDelayMs(
        claim.attempt,
        this.dependencies.policy.retryBaseMs,
        this.dependencies.policy.retryMaxMs,
      );
      await this.dependencies.jobs.fail({
        claim,
        failedAt,
        failureCode: failure.code,
        retryable: failure.retryable,
        retryAt: new Date(Date.parse(failedAt) + retryDelay).toISOString(),
        maxAttempts: this.dependencies.policy.maxAttempts,
      });
      await this.safeTelemetry({
        event: 'job_failed',
        connector: claim.connector,
        attempt: claim.attempt,
        durationMs: Math.max(0, Date.now() - startedAtMs),
        failureCode: failure.code,
        retryable: failure.retryable,
      });
      return true;
    } finally {
      clearTimeout(timeout);
      callerSignal?.removeEventListener('abort', abortFromCaller);
    }
  }

  private async runConnector(
    claim: HostedSyncJobClaim,
    account: ConnectorAccountSnapshot,
    signal: AbortSignal,
  ): Promise<void> {
    const common = {
      tenantId: claim.tenantId,
      accountId: claim.accountId,
      syncId: syncId(claim.leaseToken),
      startedAt: this.dependencies.clock.now(),
      leaseExpiresAt: claim.leaseExpiresAt,
      signal,
    } as const;
    if (claim.connector === 'gmail') {
      await this.gmail.run({ ...common, credentialRef: account.credentialRef });
      return;
    }
    if (claim.connector === 'outlook') {
      await this.outlook.run({ ...common, credentialRef: account.credentialRef });
      return;
    }
    const config = await this.dependencies.accountConfig.readConnectionConfig(claim);
    await this.owntracks.run({
      ...common,
      endpoint: parseOwnTracksConfig(config),
    });
  }

  private async safeTelemetry(event: HostedSyncTelemetryEvent): Promise<void> {
    try {
      await this.dependencies.telemetry.record(Object.freeze({ ...event }));
    } catch {
      // Telemetry cannot change sync correctness or leak the underlying error.
    }
  }
}

function parseOwnTracksConfig(value: JsonValue | null): ValidatedOwnTracksEndpoint {
  try {
    const parsed = ownTracksConfigSchema.parse(value);
    const url = new URL(parsed.endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error();
    return Object.freeze({
      endpoint: url.toString(),
      allowedPorts: Object.freeze([...new Set(parsed.allowedPorts)].sort((a, b) => a - b)),
    });
  } catch {
    throw new HostedSyncConfigurationError();
  }
}

export class HostedSyncConfigurationError extends Error {
  override readonly name = 'HostedSyncConfigurationError';
}

function classifyFailure(
  error: unknown,
  deadline: AbortSignal,
  caller: AbortSignal | undefined,
): { readonly code: string; readonly retryable: boolean } {
  if (deadline.aborted) {
    return caller?.aborted
      ? { code: 'WORKER_SHUTDOWN', retryable: true }
      : { code: 'SYNC_DEADLINE_EXCEEDED', retryable: true };
  }
  if (
    error instanceof GmailConnectorError ||
    error instanceof OutlookConnectorError ||
    error instanceof OwnTracksConnectorError
  ) {
    return { code: error.code, retryable: error.retryable };
  }
  if (error instanceof ConnectorDomainError) {
    return {
      code: error.code,
      retryable:
        error.code === 'CONCURRENT_SYNC' ||
        error.code === 'OPTIMISTIC_CONCURRENCY_CONFLICT' ||
        error.code === 'SYNC_OWNERSHIP_CONFLICT',
    };
  }
  if (error instanceof ConnectorCredentialError) {
    return { code: 'CONNECTOR_CREDENTIAL_UNAVAILABLE', retryable: false };
  }
  if (error instanceof HostedSyncConfigurationError) {
    return { code: 'SYNC_CONFIGURATION_INVALID', retryable: false };
  }
  return { code: 'SYNC_WORKER_UNEXPECTED', retryable: true };
}

function retryDelayMs(attempt: number, base: number, maximum: number): number {
  return Math.min(maximum, base * 2 ** Math.max(0, attempt - 1));
}

function validatePolicy(policy: HostedSyncWorkerPolicy): void {
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(policy.workerId)) {
    throw new Error('hosted sync worker id is invalid');
  }
  if (
    !Number.isInteger(policy.maxRunMs) ||
    policy.maxRunMs < 1_000 ||
    !Number.isInteger(policy.leaseMs) ||
    policy.leaseMs <= policy.maxRunMs ||
    policy.leaseMs > 3_600_000 ||
    !Number.isInteger(policy.maxAttempts) ||
    policy.maxAttempts < 1 ||
    policy.maxAttempts > 20 ||
    !Number.isInteger(policy.pollMs) ||
    policy.pollMs < 50 ||
    policy.pollMs > 60_000 ||
    !Number.isInteger(policy.heartbeatMs) ||
    policy.heartbeatMs < 1_000 ||
    policy.heartbeatMs > 300_000 ||
    !Number.isInteger(policy.retryBaseMs) ||
    policy.retryBaseMs < 100 ||
    !Number.isInteger(policy.retryMaxMs) ||
    policy.retryMaxMs < policy.retryBaseMs
  ) {
    throw new Error('hosted sync worker policy is outside safe bounds');
  }
}

async function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(complete, milliseconds);
    function complete() {
      signal?.removeEventListener('abort', abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('aborted', 'AbortError'));
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}
