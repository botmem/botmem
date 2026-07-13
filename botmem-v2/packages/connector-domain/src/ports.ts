import type {
  ConnectorAccountSnapshot,
  SyncClaim,
  SyncClose,
  SyncPageCommit,
} from './connector-account.js';
import type { ProviderEventRevisionInput, PlannedIngestRevision } from './ingest-revision.js';
import type {
  ConnectorAccountId,
  IngestRevisionId,
  JsonValue,
  OutboxMessageId,
  SyncId,
  TenantId,
} from './value-objects.js';

/** Driving port: the only supported orchestration surface for a hosted connector sync. */
export interface HostedIngestionUseCase {
  startSync(command: StartSyncCommand): Promise<ConnectorAccountSnapshot>;
  commitPage(command: CommitSyncPageCommand): Promise<CommitSyncPageResult>;
  closeSync(command: CloseSyncCommand): Promise<ConnectorAccountSnapshot>;
}

export interface StartSyncCommand {
  readonly tenantId: TenantId;
  readonly accountId: ConnectorAccountId;
  readonly syncId: SyncId;
  readonly startedAt: string;
  readonly leaseExpiresAt: string;
}

export interface CommitSyncPageCommand {
  readonly tenantId: TenantId;
  readonly accountId: ConnectorAccountId;
  readonly syncId: SyncId;
  readonly expectedCursorVersion: number;
  readonly nextCursor: JsonValue;
  readonly events: readonly ProviderEventRevisionInput[];
  readonly observedAt: string;
}

export interface CloseSyncCommand {
  readonly tenantId: TenantId;
  readonly accountId: ConnectorAccountId;
  readonly syncId: SyncId;
  readonly outcome: SyncClose['outcome'];
  readonly reasonCode?: string;
  readonly closedAt: string;
}

export interface CommitSyncPageResult {
  readonly account: ConnectorAccountSnapshot;
  readonly insertedRevisionIds: readonly IngestRevisionId[];
  readonly duplicateRevisionCount: number;
}

/**
 * Driven port implemented by PostgreSQL. Every method is one serializable database
 * transaction. In particular, commitPage must append event revisions, move event
 * heads, enqueue one outbox row per new revision, and advance the cursor together.
 */
export interface HostedIngestionUnitOfWork {
  loadAccount(
    tenantId: TenantId,
    accountId: ConnectorAccountId,
  ): Promise<ConnectorAccountSnapshot | null>;
  claimSync(claim: SyncClaim): Promise<ConnectorAccountSnapshot>;
  commitPage(commit: SyncPageCommit): Promise<CommitSyncPageResult>;
  closeSync(close: SyncClose): Promise<ConnectorAccountSnapshot>;
}

/** Driven port so the domain does not import a runtime-specific UUID generator. */
export interface IngestionIdFactory {
  nextRevisionId(): IngestRevisionId;
  nextOutboxMessageId(): OutboxMessageId;
}

/** Projection adapters use this shape when materializing an immutable revision. */
export interface ProjectionRevisionReader {
  getRevision(
    tenantId: TenantId,
    revisionId: IngestRevisionId,
  ): Promise<PlannedIngestRevision | null>;
}
