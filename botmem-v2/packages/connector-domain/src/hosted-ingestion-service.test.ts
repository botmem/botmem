import { describe, expect, it } from 'vitest';
import {
  ConnectorAccount,
  ConcurrentSyncError,
  HostedIngestionService,
  IdempotencyConflictError,
  OptimisticConcurrencyError,
  SyncOwnershipError,
  connectorAccountId,
  ingestRevisionId,
  outboxMessageId,
  syncId,
  tenantId,
  type ConnectorAccountSnapshot,
  type HostedIngestionUnitOfWork,
  type IngestionIdFactory,
  type PlannedIngestRevision,
  type SyncClaim,
  type SyncClose,
  type SyncPageCommit,
} from './index.js';

const TENANT_ID = tenantId('10000000-0000-4000-8000-000000000001');
const ACCOUNT_ID = connectorAccountId('20000000-0000-4000-8000-000000000001');
const NOW = '2026-07-13T10:00:00.000Z';
const LATER = '2026-07-13T10:15:00.000Z';

interface StoredRevision extends PlannedIngestRevision {
  readonly tenantId: typeof TENANT_ID;
  readonly accountId: typeof ACCOUNT_ID;
}

interface StoredOutboxMessage {
  readonly id: string;
  readonly tenantId: typeof TENANT_ID;
  readonly revisionId: string;
}

class SequentialIds implements IngestionIdFactory {
  private revisionSequence = 0;
  private outboxSequence = 10_000;

  public nextRevisionId() {
    this.revisionSequence += 1;
    return ingestRevisionId(this.uuid(this.revisionSequence));
  }

  public nextOutboxMessageId() {
    this.outboxSequence += 1;
    return outboxMessageId(this.uuid(this.outboxSequence));
  }

  private uuid(sequence: number): string {
    return `00000000-0000-4000-8000-${sequence.toString(16).padStart(12, '0')}`;
  }
}

/**
 * Transactional reference adapter. It writes into copies and swaps them into
 * place only after every invariant has succeeded, matching a PostgreSQL commit.
 */
class InMemoryHostedIngestionUnitOfWork implements HostedIngestionUnitOfWork {
  public readonly accounts = new Map<string, ConnectorAccountSnapshot>();
  public revisions: StoredRevision[] = [];
  public outbox: StoredOutboxMessage[] = [];
  public heads = new Map<string, StoredRevision>();
  public failBeforeOutboxCommit = false;

  public constructor(account: ConnectorAccountSnapshot) {
    this.accounts.set(this.accountKey(account.tenantId, account.id), account);
  }

  public async loadAccount(tenant: typeof TENANT_ID, account: typeof ACCOUNT_ID) {
    return this.accounts.get(this.accountKey(tenant, account)) ?? null;
  }

  public async claimSync(claim: SyncClaim) {
    const key = this.accountKey(claim.tenantId, claim.accountId);
    const current = this.requiredAccount(key);
    if (current.activeSync && current.activeSync.id !== claim.replacesExpiredSyncId) {
      throw new ConcurrentSyncError();
    }
    if (current.aggregateVersion !== claim.expectedAggregateVersion) {
      throw new OptimisticConcurrencyError();
    }
    const next: ConnectorAccountSnapshot = Object.freeze({
      ...current,
      aggregateVersion: current.aggregateVersion + 1,
      activeSync: claim.sync,
    });
    this.accounts.set(key, next);
    return next;
  }

  public async commitPage(commit: SyncPageCommit) {
    const accountKey = this.accountKey(commit.tenantId, commit.accountId);
    const current = this.requiredAccount(accountKey);
    if (current.activeSync?.id !== commit.syncId) {
      throw new SyncOwnershipError();
    }
    if (
      current.aggregateVersion !== commit.expectedAggregateVersion ||
      current.cursorVersion !== commit.expectedCursorVersion
    ) {
      throw new OptimisticConcurrencyError();
    }

    const nextRevisions = [...this.revisions];
    const nextOutbox = [...this.outbox];
    const nextHeads = new Map(this.heads);
    const insertedIds: StoredRevision['id'][] = [];
    let duplicates = 0;

    for (const revision of commit.revisions) {
      const revisionKey = this.revisionKey(
        commit.accountId,
        revision.sourceEventId,
        revision.sourceRevision,
      );
      const existing = nextRevisions.find(
        (candidate) =>
          this.revisionKey(
            candidate.accountId,
            candidate.sourceEventId,
            candidate.sourceRevision,
          ) === revisionKey,
      );
      if (existing) {
        if (existing.contentHash !== revision.contentHash) {
          throw new IdempotencyConflictError();
        }
        duplicates += 1;
        continue;
      }

      const stored: StoredRevision = Object.freeze({
        ...revision,
        tenantId: commit.tenantId,
        accountId: commit.accountId,
      });
      nextRevisions.push(stored);
      insertedIds.push(stored.id);
      nextHeads.set(this.headKey(commit.accountId, stored.sourceEventId), stored);
      nextOutbox.push(
        Object.freeze({
          id: revision.outboxId,
          tenantId: commit.tenantId,
          revisionId: revision.id,
        }),
      );
    }

    if (this.failBeforeOutboxCommit) {
      throw new Error('simulated outbox insert failure');
    }

    const nextAccount: ConnectorAccountSnapshot = Object.freeze({
      ...current,
      aggregateVersion: current.aggregateVersion + 1,
      cursorVersion: current.cursorVersion + 1,
      cursor: commit.nextCursor,
    });
    this.revisions = nextRevisions;
    this.outbox = nextOutbox;
    this.heads = nextHeads;
    this.accounts.set(accountKey, nextAccount);

    return Object.freeze({
      account: nextAccount,
      insertedRevisionIds: Object.freeze(insertedIds),
      duplicateRevisionCount: duplicates,
    });
  }

  public async closeSync(close: SyncClose) {
    const key = this.accountKey(close.tenantId, close.accountId);
    const current = this.requiredAccount(key);
    if (current.activeSync?.id !== close.syncId) {
      throw new SyncOwnershipError();
    }
    if (current.aggregateVersion !== close.expectedAggregateVersion) {
      throw new OptimisticConcurrencyError();
    }
    const next: ConnectorAccountSnapshot = Object.freeze({
      ...current,
      status: close.outcome === 'completed' ? 'ready' : 'degraded',
      aggregateVersion: current.aggregateVersion + 1,
      activeSync: null,
    });
    this.accounts.set(key, next);
    return next;
  }

  private requiredAccount(key: string): ConnectorAccountSnapshot {
    const account = this.accounts.get(key);
    if (!account) {
      throw new Error('test account missing');
    }
    return account;
  }

  private accountKey(tenant: string, account: string): string {
    return `${tenant}/${account}`;
  }

  private revisionKey(account: string, sourceEventId: string, sourceRevision: string): string {
    return `${account}/${sourceEventId.length}:${sourceEventId}${sourceRevision}`;
  }

  private headKey(account: string, sourceEventId: string): string {
    return `${account}/${sourceEventId}`;
  }
}

function readyAccount(): ConnectorAccountSnapshot {
  return ConnectorAccount.create({
    id: ACCOUNT_ID,
    tenantId: TENANT_ID,
    connector: 'gmail',
    authKind: 'oauth2',
    providerSubjectHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    credentialRef: 'secret://connector/gmail/account-1',
    status: 'ready',
  }).snapshot();
}

function createHarness() {
  const unitOfWork = new InMemoryHostedIngestionUnitOfWork(readyAccount());
  return {
    unitOfWork,
    service: new HostedIngestionService(unitOfWork, new SequentialIds()),
  };
}

async function start(service: HostedIngestionService, id = '30000000-0000-4000-8000-000000000001') {
  const attemptId = syncId(id);
  await service.startSync({
    tenantId: TENANT_ID,
    accountId: ACCOUNT_ID,
    syncId: attemptId,
    startedAt: NOW,
    leaseExpiresAt: LATER,
  });
  return attemptId;
}

describe('HostedIngestionService', () => {
  it('commitPage_whenOutboxWriteFails_keepsCursorEventsAndOutboxAtomic', async () => {
    const { service, unitOfWork } = createHarness();
    const attemptId = await start(service);
    unitOfWork.failBeforeOutboxCommit = true;

    await expect(
      service.commitPage({
        tenantId: TENANT_ID,
        accountId: ACCOUNT_ID,
        syncId: attemptId,
        expectedCursorVersion: 0,
        nextCursor: { page: 'next' },
        observedAt: NOW,
        events: [
          {
            sourceEventId: 'message-1',
            sourceRevision: 'v1',
            kind: 'email',
            occurredAt: NOW,
            contentHash: 'a'.repeat(64),
            payload: { subject: 'alpha' },
          },
        ],
      }),
    ).rejects.toThrow('simulated outbox insert failure');

    const afterFailure = await unitOfWork.loadAccount(TENANT_ID, ACCOUNT_ID);
    expect(afterFailure?.cursorVersion).toBe(0);
    expect(afterFailure?.cursor).toEqual({});
    expect(unitOfWork.revisions).toEqual([]);
    expect(unitOfWork.heads.size).toBe(0);
    expect(unitOfWork.outbox).toEqual([]);

    unitOfWork.failBeforeOutboxCommit = false;
    const committed = await service.commitPage({
      tenantId: TENANT_ID,
      accountId: ACCOUNT_ID,
      syncId: attemptId,
      expectedCursorVersion: 0,
      nextCursor: { page: 'next' },
      observedAt: NOW,
      events: [
        {
          sourceEventId: 'message-1',
          sourceRevision: 'v1',
          kind: 'email',
          occurredAt: NOW,
          contentHash: 'a'.repeat(64),
          payload: { subject: 'alpha' },
        },
      ],
    });
    expect(committed.account.cursorVersion).toBe(1);
    expect(unitOfWork.revisions).toHaveLength(1);
    expect(unitOfWork.outbox).toHaveLength(1);
  });

  it('commitPage_whenProviderEventMutates_appendsRevisionAndMovesHeadWithoutOverwrite', async () => {
    const { service, unitOfWork } = createHarness();
    const attemptId = await start(service);
    const base = {
      tenantId: TENANT_ID,
      accountId: ACCOUNT_ID,
      syncId: attemptId,
      observedAt: NOW,
    } as const;

    await service.commitPage({
      ...base,
      expectedCursorVersion: 0,
      nextCursor: { page: 1 },
      events: [
        {
          sourceEventId: 'mutable-message',
          sourceRevision: 'change-key-1',
          kind: 'email',
          occurredAt: NOW,
          contentHash: 'a'.repeat(64),
          payload: { subject: 'before' },
        },
      ],
    });
    const duplicate = await service.commitPage({
      ...base,
      expectedCursorVersion: 1,
      nextCursor: { page: 2 },
      events: [
        {
          sourceEventId: 'mutable-message',
          sourceRevision: 'change-key-1',
          kind: 'email',
          occurredAt: NOW,
          contentHash: 'a'.repeat(64),
          payload: { subject: 'before' },
        },
      ],
    });
    const changed = await service.commitPage({
      ...base,
      expectedCursorVersion: 2,
      nextCursor: { page: 3 },
      events: [
        {
          sourceEventId: 'mutable-message',
          sourceRevision: 'change-key-2',
          kind: 'email',
          occurredAt: NOW,
          contentHash: 'b'.repeat(64),
          payload: { subject: 'after' },
        },
      ],
    });

    expect(duplicate.insertedRevisionIds).toHaveLength(0);
    expect(duplicate.duplicateRevisionCount).toBe(1);
    expect(changed.insertedRevisionIds).toHaveLength(1);
    expect(unitOfWork.revisions).toHaveLength(2);
    expect(unitOfWork.revisions.map((revision) => revision.payload)).toEqual([
      { subject: 'before' },
      { subject: 'after' },
    ]);
    expect(unitOfWork.outbox).toHaveLength(2);
    expect(unitOfWork.heads.get(`${ACCOUNT_ID}/mutable-message`)?.sourceRevision).toBe(
      'change-key-2',
    );
    expect(changed.account.cursorVersion).toBe(3);
  });

  it('commitPage_whenSameRevisionHasDifferentContent_rejectsWithoutAdvancingCursor', async () => {
    const { service, unitOfWork } = createHarness();
    const attemptId = await start(service);
    const command = {
      tenantId: TENANT_ID,
      accountId: ACCOUNT_ID,
      syncId: attemptId,
      expectedCursorVersion: 0,
      nextCursor: { page: 1 },
      observedAt: NOW,
      events: [
        {
          sourceEventId: 'message-1',
          sourceRevision: 'v1',
          kind: 'email' as const,
          occurredAt: NOW,
          contentHash: 'a'.repeat(64),
          payload: { value: 'first' },
        },
      ],
    };
    await service.commitPage(command);

    await expect(
      service.commitPage({
        ...command,
        expectedCursorVersion: 1,
        nextCursor: { page: 2 },
        events: [{ ...command.events[0], contentHash: 'b'.repeat(64) }],
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    const account = await unitOfWork.loadAccount(TENANT_ID, ACCOUNT_ID);
    expect(account?.cursorVersion).toBe(1);
    expect(unitOfWork.revisions).toHaveLength(1);
    expect(unitOfWork.outbox).toHaveLength(1);
  });

  it('startSync_whenClaimsRace_allowsExactlyOneActiveAttempt', async () => {
    const { service, unitOfWork } = createHarness();
    const starts = await Promise.allSettled([
      start(service, '30000000-0000-4000-8000-000000000001'),
      start(service, '30000000-0000-4000-8000-000000000002'),
    ]);

    expect(starts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = starts.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ reason: expect.any(ConcurrentSyncError) });
    const account = await unitOfWork.loadAccount(TENANT_ID, ACCOUNT_ID);
    expect(account?.activeSync).not.toBeNull();
    expect(account?.aggregateVersion).toBe(1);
  });
});
