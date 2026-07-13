import type { HostedProjectionInput } from '../search/hosted-projection-transformer.js';

export interface ClaimedOutboxMessage {
  readonly messageId: string;
  readonly workspaceId: string;
  readonly accountId: string;
  readonly revisionId: string;
  readonly attempt: number;
  readonly leaseExpiresAt: string;
}

export interface OutboxDispatcherPort {
  claim(input: {
    readonly owner: string;
    readonly limit: number;
    readonly leaseMs: number;
    readonly signal: AbortSignal;
  }): Promise<readonly ClaimedOutboxMessage[]>;
  complete(input: {
    readonly messageId: string;
    readonly owner: string;
    readonly publishedAt: string;
    readonly signal: AbortSignal;
  }): Promise<void>;
  fail(input: {
    readonly messageId: string;
    readonly owner: string;
    readonly dead: boolean;
    readonly nextAttemptAt: string;
    readonly signal: AbortSignal;
  }): Promise<void>;
  listRepairWorkspaces(input: {
    readonly afterWorkspaceId?: string;
    readonly limit: number;
    readonly signal: AbortSignal;
  }): Promise<readonly string[]>;
}

export interface HostedProjectionInputPort {
  load(input: {
    readonly workspaceId: string;
    readonly accountId: string;
    readonly revisionId: string;
    readonly signal: AbortSignal;
  }): Promise<HostedProjectionInput>;
}

export interface SearchReadinessProbePort {
  probe(input: {
    readonly workspaceId: string;
    readonly accountId: string;
    readonly signal: AbortSignal;
  }): Promise<'ready' | 'deferred'>;
}

export interface RuntimeDatabaseHealthPort {
  probe(signal: AbortSignal): Promise<void>;
}

export type ProjectionWorkerReasonCode =
  | 'claim_failed'
  | 'projection_input_unavailable'
  | 'projection_transform_rejected'
  | 'embedding_failed'
  | 'projection_failed'
  | 'projection_lease_conflict'
  | 'projection_settlement_conflict'
  | 'search_probe_failed'
  | 'search_probe_deferred'
  | 'task_timeout'
  | 'task_cancelled'
  | 'repair_failed'
  | 'database_unavailable';

export interface ProjectionWorkerTelemetryPort {
  event(input: {
    readonly level: 'info' | 'warn' | 'error';
    readonly code: ProjectionWorkerReasonCode | 'worker_started' | 'worker_stopped';
  }): void;
  metric(input: {
    readonly name:
      | 'outbox_claimed'
      | 'outbox_published'
      | 'outbox_retried'
      | 'outbox_dead'
      | 'projection_repaired'
      | 'projection_failed'
      | 'search_probe_ready'
      | 'search_probe_deferred';
    readonly value: number;
    readonly reasonCode?: ProjectionWorkerReasonCode;
  }): void;
}

export interface ProjectionWorkerClockPort {
  nowMs(): number;
}
