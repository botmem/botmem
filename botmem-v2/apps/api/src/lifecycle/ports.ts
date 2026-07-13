import type { Readable } from 'node:stream';
import type { AuthenticatedPrincipal } from '../identity/domain.js';
import type { ExportPage, LifecycleJobClaim, LifecycleJobView } from './domain.js';

export interface LifecycleApiRepositoryPort {
  requestExport(input: {
    readonly principal: AuthenticatedPrincipal;
    readonly jobId: string;
    readonly requestedAt: string;
    readonly maxAttempts: number;
  }): Promise<LifecycleJobView>;
  requestDeletion(input: {
    readonly principal: AuthenticatedPrincipal;
    readonly jobId: string;
    readonly requestedAt: string;
    readonly maxAttempts: number;
  }): Promise<LifecycleJobView>;
  list(input: { readonly principal: AuthenticatedPrincipal }): Promise<readonly LifecycleJobView[]>;
  workerReady(input: {
    readonly now: string;
    readonly maximumAgeSeconds: number;
  }): Promise<boolean>;
  consumeExportArtifactKey(input: {
    readonly principal: AuthenticatedPrincipal;
    readonly jobId: string;
    readonly now: string;
  }): Promise<string | null>;
}

export interface LifecycleWorkerRepositoryPort {
  claim(input: {
    readonly workerId: string;
    readonly claimedAt: string;
    readonly leaseExpiresAt: string;
  }): Promise<LifecycleJobClaim | null>;
  renewLease(input: {
    readonly jobId: string;
    readonly workerId: string;
    readonly now: string;
    readonly leaseExpiresAt: string;
  }): Promise<boolean>;
  readExportPage(input: {
    readonly jobId: string;
    readonly workerId: string;
    readonly now: string;
    readonly cursor: { readonly accountId: string; readonly sourceEventId: string } | null;
    readonly pageSize: number;
  }): Promise<ExportPage>;
  deletionBlockers(input: {
    readonly jobId: string;
    readonly workerId: string;
    readonly now: string;
  }): Promise<{
    readonly pendingNotices: number;
    readonly billingState: 'not_required' | 'pending' | 'processing' | 'confirmed' | 'dead';
  }>;
  deferDeletion(input: {
    readonly jobId: string;
    readonly workerId: string;
    readonly now: string;
    readonly retryAt: string;
    readonly reason: 'BILLING_CANCELLATION_PENDING' | 'BILLING_CANCELLATION_DEAD';
  }): Promise<boolean>;
  listDeletionArtifacts(input: {
    readonly jobId: string;
    readonly workerId: string;
    readonly now: string;
  }): Promise<readonly { readonly jobId: string; readonly artifactKey: string }[]>;
  completeExport(input: {
    readonly jobId: string;
    readonly workerId: string;
    readonly completedAt: string;
    readonly artifactKey: string;
    readonly artifactExpiresAt: string;
  }): Promise<boolean>;
  completeDeletion(input: {
    readonly jobId: string;
    readonly workerId: string;
    readonly completedAt: string;
  }): Promise<boolean>;
  fail(input: {
    readonly jobId: string;
    readonly workerId: string;
    readonly failedAt: string;
    readonly retryAt: string;
    readonly failureCode: string;
  }): Promise<'retry' | 'dead' | null>;
  heartbeat(input: {
    readonly workerId: string;
    readonly startedAt: string;
    readonly seenAt: string;
  }): Promise<void>;
  listExpiredArtifacts(input: {
    readonly now: string;
    readonly limit: number;
  }): Promise<readonly { readonly jobId: string; readonly artifactKey: string }[]>;
  completeArtifactPurge(jobId: string): Promise<boolean>;
  purgeExpiredBillingAudits(input: {
    readonly now: string;
    readonly limit: number;
  }): Promise<number>;
  repair(input: {
    readonly jobId: string;
    readonly repairedAt: string;
    readonly repairReference: string;
  }): Promise<boolean>;
}

export interface LifecycleArtifactWriterPort {
  readonly maxRecordBytes: number;
  write(line: string): Promise<void>;
  commit(): Promise<string>;
  abort(): Promise<void>;
}

export interface LifecycleArtifactReaderPort {
  open(artifactKey: string): Promise<Readable>;
}

export interface LifecycleArtifactStorePort extends LifecycleArtifactReaderPort {
  create(input: {
    readonly workspaceId: string;
    readonly jobId: string;
  }): Promise<LifecycleArtifactWriterPort>;
  delete(artifactKey: string): Promise<void>;
  deleteWorkspace(workspaceId: string): Promise<void>;
  ready(): Promise<boolean>;
}

export interface DeviceDeletionNoticeClaim {
  readonly jobId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly deviceId: string;
  readonly attempts: number;
}

export interface DeviceDeletionNoticeRelayRepositoryPort {
  claim(input: {
    readonly relayId: string;
    readonly claimedAt: string;
    readonly leaseExpiresAt: string;
  }): Promise<DeviceDeletionNoticeClaim | null>;
  finish(input: {
    readonly jobId: string;
    readonly deviceId: string;
    readonly relayId: string;
    readonly state: 'delivered' | 'unreachable';
    readonly attemptedAt: string;
  }): Promise<boolean>;
  fail(input: {
    readonly jobId: string;
    readonly deviceId: string;
    readonly relayId: string;
    readonly failedAt: string;
    readonly retryAt: string;
  }): Promise<'pending' | 'unreachable' | null>;
}

/** Implemented by the existing API replica/presence relay, never by the lifecycle worker. */
export interface DeviceDeletionDeliveryPort {
  deliver(input: DeviceDeletionNoticeClaim): Promise<'delivered' | 'unreachable'>;
}

export interface BillingCancellationClaim {
  readonly jobId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly stripeSubscriptionId: string;
  readonly attempts: number;
}

export interface BillingCancellationRepositoryPort {
  claim(input: {
    readonly workerId: string;
    readonly claimedAt: string;
    readonly leaseExpiresAt: string;
    readonly maxAttempts: number;
  }): Promise<BillingCancellationClaim | null>;
  confirm(input: {
    readonly jobId: string;
    readonly workerId: string;
    readonly confirmedAt: string;
    readonly observedStripeStatus: 'canceled';
  }): Promise<boolean>;
  fail(input: {
    readonly jobId: string;
    readonly workerId: string;
    readonly failedAt: string;
    readonly retryAt: string;
    readonly maxAttempts: number;
    readonly failureCode: string;
  }): Promise<'pending' | 'dead' | null>;
}

export interface LifecycleClockPort {
  nowMs(): number;
}

export interface LifecycleIdPort {
  uuid(): string;
}

export interface LifecycleTelemetryPort {
  /** jobId is for in-process correlation only; production exporters must omit it. */
  event(input: {
    readonly event:
      | 'claimed'
      | 'completed'
      | 'retry'
      | 'dead'
      | 'artifact_purged'
      | 'local_delete_delivered'
      | 'local_delete_unreachable';
    readonly jobId: string;
    readonly kind?: 'export' | 'deletion';
    readonly code?: string;
  }): void;
}
