import {
  ConcurrentSyncError,
  InvalidDomainValueError,
  OptimisticConcurrencyError,
  SyncNotAllowedError,
  SyncOwnershipError,
} from './errors.js';
import type { PlannedIngestRevision } from './ingest-revision.js';
import {
  cloneJson,
  isoTimestamp,
  nonEmpty,
  type ConnectorAccountId,
  type JsonValue,
  type SyncId,
  type TenantId,
} from './value-objects.js';

export type HostedConnector = 'gmail' | 'outlook' | 'owntracks';
export type ConnectorAuthKind = 'oauth2' | 'basic';
export type ConnectorAccountStatus = 'disconnected' | 'ready' | 'degraded' | 'revoked';

export interface ActiveSync {
  readonly id: SyncId;
  readonly startedAt: string;
  readonly leaseExpiresAt: string;
}

export interface ConnectorAccountSnapshot {
  readonly id: ConnectorAccountId;
  readonly tenantId: TenantId;
  readonly connector: HostedConnector;
  readonly authKind: ConnectorAuthKind;
  readonly providerSubjectHash: string;
  readonly credentialRef: string;
  readonly status: ConnectorAccountStatus;
  readonly aggregateVersion: number;
  readonly cursorVersion: number;
  readonly cursor: JsonValue;
  readonly activeSync: ActiveSync | null;
}

export interface SyncClaim {
  readonly accountId: ConnectorAccountId;
  readonly tenantId: TenantId;
  readonly expectedAggregateVersion: number;
  readonly replacesExpiredSyncId: SyncId | null;
  readonly sync: ActiveSync;
}

export interface SyncPageCommit {
  readonly accountId: ConnectorAccountId;
  readonly tenantId: TenantId;
  readonly syncId: SyncId;
  readonly expectedAggregateVersion: number;
  readonly expectedCursorVersion: number;
  readonly nextCursor: JsonValue;
  readonly revisions: readonly PlannedIngestRevision[];
  readonly committedAt: string;
}

export interface SyncClose {
  readonly accountId: ConnectorAccountId;
  readonly tenantId: TenantId;
  readonly syncId: SyncId;
  readonly expectedAggregateVersion: number;
  readonly outcome: 'completed' | 'failed';
  readonly reasonCode: string | null;
  readonly closedAt: string;
}

function assertNonnegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new InvalidDomainValueError(`${label} must be a non-negative integer`);
  }
}

function assertProviderAuth(connector: HostedConnector, authKind: ConnectorAuthKind): void {
  const expected = connector === 'owntracks' ? 'basic' : 'oauth2';
  if (authKind !== expected) {
    throw new InvalidDomainValueError(`${connector} requires ${expected} authentication`);
  }
}

export class ConnectorAccount {
  private constructor(private readonly state: ConnectorAccountSnapshot) {}

  public static create(
    input: Omit<
      ConnectorAccountSnapshot,
      'activeSync' | 'aggregateVersion' | 'cursor' | 'cursorVersion'
    >,
  ): ConnectorAccount {
    return ConnectorAccount.rehydrate({
      ...input,
      aggregateVersion: 0,
      cursorVersion: 0,
      cursor: {},
      activeSync: null,
    });
  }

  public static rehydrate(snapshot: ConnectorAccountSnapshot): ConnectorAccount {
    assertProviderAuth(snapshot.connector, snapshot.authKind);
    if (!/^[0-9a-f]{64}$/.test(snapshot.providerSubjectHash)) {
      throw new InvalidDomainValueError('providerSubjectHash must be a lowercase SHA-256 hash');
    }
    nonEmpty(snapshot.credentialRef, 'credentialRef', 1024);
    assertNonnegativeInteger(snapshot.aggregateVersion, 'aggregateVersion');
    assertNonnegativeInteger(snapshot.cursorVersion, 'cursorVersion');
    if (snapshot.activeSync) {
      isoTimestamp(snapshot.activeSync.startedAt, 'activeSync.startedAt');
      isoTimestamp(snapshot.activeSync.leaseExpiresAt, 'activeSync.leaseExpiresAt');
      if (
        Date.parse(snapshot.activeSync.leaseExpiresAt) <= Date.parse(snapshot.activeSync.startedAt)
      ) {
        throw new InvalidDomainValueError('sync lease must expire after it starts');
      }
    }
    return new ConnectorAccount(
      Object.freeze({
        ...snapshot,
        cursor: cloneJson(snapshot.cursor),
        activeSync: snapshot.activeSync ? Object.freeze({ ...snapshot.activeSync }) : null,
      }),
    );
  }

  public snapshot(): ConnectorAccountSnapshot {
    return this.state;
  }

  public claimSync(sync: ActiveSync, now: string): SyncClaim {
    isoTimestamp(now, 'now');
    isoTimestamp(sync.startedAt, 'sync.startedAt');
    isoTimestamp(sync.leaseExpiresAt, 'sync.leaseExpiresAt');
    if (Date.parse(sync.leaseExpiresAt) <= Date.parse(sync.startedAt)) {
      throw new InvalidDomainValueError('sync lease must expire after it starts');
    }
    if (this.state.status !== 'ready' && this.state.status !== 'degraded') {
      throw new SyncNotAllowedError();
    }
    if (
      this.state.activeSync &&
      Date.parse(this.state.activeSync.leaseExpiresAt) > Date.parse(now)
    ) {
      throw new ConcurrentSyncError();
    }
    return Object.freeze({
      accountId: this.state.id,
      tenantId: this.state.tenantId,
      expectedAggregateVersion: this.state.aggregateVersion,
      replacesExpiredSyncId: this.state.activeSync?.id ?? null,
      sync: Object.freeze({ ...sync }),
    });
  }

  public commitPage(input: {
    readonly syncId: SyncId;
    readonly expectedCursorVersion: number;
    readonly nextCursor: JsonValue;
    readonly revisions: readonly PlannedIngestRevision[];
    readonly committedAt: string;
  }): SyncPageCommit {
    isoTimestamp(input.committedAt, 'committedAt');
    if (this.state.activeSync?.id !== input.syncId) {
      throw new SyncOwnershipError();
    }
    if (this.state.cursorVersion !== input.expectedCursorVersion) {
      throw new OptimisticConcurrencyError();
    }
    return Object.freeze({
      accountId: this.state.id,
      tenantId: this.state.tenantId,
      syncId: input.syncId,
      expectedAggregateVersion: this.state.aggregateVersion,
      expectedCursorVersion: input.expectedCursorVersion,
      nextCursor: cloneJson(input.nextCursor),
      revisions: Object.freeze([...input.revisions]),
      committedAt: input.committedAt,
    });
  }

  public closeSync(
    syncId: SyncId,
    outcome: SyncClose['outcome'],
    closedAt: string,
    reasonCode: string | null = null,
  ): SyncClose {
    isoTimestamp(closedAt, 'closedAt');
    if (this.state.activeSync?.id !== syncId) {
      throw new SyncOwnershipError();
    }
    return Object.freeze({
      accountId: this.state.id,
      tenantId: this.state.tenantId,
      syncId,
      expectedAggregateVersion: this.state.aggregateVersion,
      outcome,
      reasonCode: reasonCode === null ? null : nonEmpty(reasonCode, 'reasonCode', 128),
      closedAt,
    });
  }
}
