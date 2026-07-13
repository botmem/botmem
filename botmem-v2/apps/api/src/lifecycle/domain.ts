import type { AuthenticatedPrincipal } from '../identity/domain.js';

export type LifecycleJobKind = 'export' | 'deletion';
export type LifecycleJobState =
  | 'queued'
  | 'running'
  | 'retry'
  | 'ready'
  | 'completed'
  | 'expired'
  | 'dead';

export interface LocalDeletionSummary {
  readonly delivered: number;
  readonly unreachable: number;
  readonly pending: number;
}

export interface LifecycleJobView {
  readonly jobId: string;
  readonly kind: LifecycleJobKind;
  readonly state: LifecycleJobState;
  readonly requestedAt: string;
  readonly attempts: number;
  readonly availableUntil: string | null;
  readonly completedAt: string | null;
  readonly failureCode: string | null;
  readonly localDelete: LocalDeletionSummary | null;
}

export interface LifecycleJobClaim {
  readonly jobId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly requestedByUserId: string;
  readonly kind: LifecycleJobKind;
  readonly attempts: number;
}

export interface HostedExportRecord {
  readonly accountId: string;
  readonly sourceEventId: string;
  readonly connector: 'gmail' | 'outlook' | 'owntracks';
  readonly sourceRevision: string;
  readonly kind: 'email' | 'location';
  readonly occurredAt: string | null;
  readonly observedAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly tombstone: boolean;
}

export interface ExportPage {
  readonly items: readonly HostedExportRecord[];
  readonly nextCursor: {
    readonly accountId: string;
    readonly sourceEventId: string;
  } | null;
}

export function assertOwnerBrowserPrincipal(principal: AuthenticatedPrincipal): void {
  if (principal.credentialKind !== 'browser_session') {
    throw new LifecycleAuthorizationError();
  }
  if (principal.membershipRole !== 'owner') {
    throw new LifecycleAuthorizationError();
  }
}

export class LifecycleAuthorizationError extends Error {
  override readonly name = 'LifecycleAuthorizationError';
}

export class LifecycleInputError extends Error {
  override readonly name = 'LifecycleInputError';
}

export class LifecycleJobNotFoundError extends Error {
  override readonly name = 'LifecycleJobNotFoundError';
}

export class LifecycleExportNotReadyError extends Error {
  override readonly name = 'LifecycleExportNotReadyError';
}

export class LifecycleLeaseLostError extends Error {
  override readonly name = 'LifecycleLeaseLostError';
}
