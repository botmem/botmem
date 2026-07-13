import {
  ConcurrentSyncError,
  IdempotencyConflictError,
  connectorAccountId,
  ingestRevisionId,
  outboxMessageId,
  syncId,
  tenantId,
  type SyncPageCommit,
} from '@botmem-v2/connector-domain';
import { describe, expect, it } from 'vitest';
import type {
  SqlClientPort,
  SqlPoolPort,
  SqlQueryConfig,
  SqlQueryResult,
} from '../search/postgres-ports.js';
import { PostgresHostedIngestionUnitOfWork } from './postgres-hosted-ingestion.js';

const TENANT_ID = tenantId('10000000-0000-4000-8000-000000000001');
const ACCOUNT_ID = connectorAccountId('20000000-0000-4000-8000-000000000001');
const SYNC_ID = syncId('30000000-0000-4000-8000-000000000001');
const REVISION_ID = ingestRevisionId('40000000-0000-4000-8000-000000000001');
const OUTBOX_ID = outboxMessageId('50000000-0000-4000-8000-000000000001');
const NOW = '2026-07-13T10:00:00.000Z';

class ScriptedClient implements SqlClientPort {
  readonly queries: SqlQueryConfig[] = [];
  released = false;

  constructor(
    private readonly answer: (query: SqlQueryConfig, occurrence: number) => SqlQueryResult<unknown>,
  ) {}

  async query<Row>(query: SqlQueryConfig): Promise<SqlQueryResult<Row>> {
    this.queries.push(query);
    return this.answer(query, this.queries.length) as SqlQueryResult<Row>;
  }

  release(): void {
    this.released = true;
  }
}

function pool(client: ScriptedClient): SqlPoolPort {
  return { connect: async () => client };
}

function accountRow(
  input: {
    readonly aggregateVersion?: number;
    readonly cursorVersion?: number;
    readonly active?: boolean;
    readonly leaseExpiresAt?: string;
  } = {},
) {
  return {
    id: ACCOUNT_ID,
    tenant_id: TENANT_ID,
    connector: 'gmail',
    auth_kind: 'oauth2',
    provider_subject_hash: 'a'.repeat(64),
    credential_ref: 'vault://gmail/account-1',
    status: 'ready',
    aggregate_version: input.aggregateVersion ?? 1,
    cursor_version: input.cursorVersion ?? 0,
    cursor: input.cursorVersion ? { page: 'next' } : {},
    active_sync_id: input.active === false ? null : SYNC_ID,
    active_sync_started_at: input.active === false ? null : NOW,
    active_sync_lease_expires_at:
      input.active === false ? null : (input.leaseExpiresAt ?? '2026-07-13T10:15:00.000Z'),
  };
}

function result<Row>(row: Row): SqlQueryResult<Row> {
  return { rows: [row], rowCount: 1 };
}

function pageCommit(): SyncPageCommit {
  return {
    tenantId: TENANT_ID,
    accountId: ACCOUNT_ID,
    syncId: SYNC_ID,
    expectedAggregateVersion: 1,
    expectedCursorVersion: 0,
    nextCursor: { page: 'next' },
    committedAt: NOW,
    revisions: [
      {
        id: REVISION_ID,
        outboxId: OUTBOX_ID,
        sourceEventId: 'message-1',
        sourceRevision: 'history-1',
        kind: 'email',
        occurredAt: '2026-07-13T09:00:00.000Z',
        observedAt: NOW,
        contentHash: 'b'.repeat(64),
        payload: { subject: 'private content stays in the revision only' },
        tombstone: false,
      },
    ],
  };
}

describe('PostgresHostedIngestionUnitOfWork', () => {
  it('loadAccount_setsLocalTenantAndMapsTheAggregate', async () => {
    const client = new ScriptedClient((query) =>
      query.text.includes('FROM botmem.connector_account ca')
        ? result(accountRow({ active: false }))
        : { rows: [], rowCount: null },
    );
    const unitOfWork = new PostgresHostedIngestionUnitOfWork(pool(client));

    await expect(unitOfWork.loadAccount(TENANT_ID, ACCOUNT_ID)).resolves.toMatchObject({
      id: ACCOUNT_ID,
      tenantId: TENANT_ID,
      connector: 'gmail',
      cursorVersion: 0,
      activeSync: null,
    });
    expect(client.queries.map((query) => query.text.trim())).toEqual([
      'BEGIN ISOLATION LEVEL SERIALIZABLE',
      'SET LOCAL ROLE botmem_worker',
      "SELECT set_config('botmem.tenant_id', $1, true)",
      expect.stringContaining('FROM botmem.connector_account ca'),
      'COMMIT',
    ]);
    expect(client.queries[2]?.values).toEqual([TENANT_ID]);
    expect(client.released).toBe(true);
  });

  it('commitPage_commitsRevisionHeadOutboxAndCursorInOneTenantTransaction', async () => {
    let snapshotRead = 0;
    const client = new ScriptedClient((query) => {
      if (query.text.includes('FROM botmem.connector_account ca')) {
        snapshotRead += 1;
        return result(
          snapshotRead === 1 ? accountRow() : accountRow({ aggregateVersion: 2, cursorVersion: 1 }),
        );
      }
      if (query.text.includes('INSERT INTO botmem.ingest_event_revision')) {
        return result({ id: REVISION_ID });
      }
      if (query.text.includes('RETURNING cursor_version')) {
        return result({ cursor_version: 1 });
      }
      return { rows: [], rowCount: query.text.trim() === 'COMMIT' ? null : 1 };
    });
    const unitOfWork = new PostgresHostedIngestionUnitOfWork(pool(client));

    await expect(unitOfWork.commitPage(pageCommit())).resolves.toMatchObject({
      insertedRevisionIds: [REVISION_ID],
      duplicateRevisionCount: 0,
      account: { aggregateVersion: 2, cursorVersion: 1 },
    });

    const statements = client.queries.map((query) => query.text);
    const revisionIndex = statements.findIndex((sql) =>
      sql.includes('INSERT INTO botmem.ingest_event_revision'),
    );
    const headIndex = statements.findIndex((sql) =>
      sql.includes('INSERT INTO botmem.ingest_event_head'),
    );
    const outboxIndex = statements.findIndex((sql) =>
      sql.includes('INSERT INTO botmem.transactional_outbox'),
    );
    const checkpointIndex = statements.findIndex((sql) =>
      sql.includes('INSERT INTO botmem.connector_checkpoint'),
    );
    expect(revisionIndex).toBeGreaterThan(1);
    expect(headIndex).toBeGreaterThan(revisionIndex);
    expect(outboxIndex).toBeGreaterThan(headIndex);
    expect(checkpointIndex).toBeGreaterThan(outboxIndex);
    expect(client.queries.at(-1)?.text).toBe('COMMIT');
    const outbox = client.queries[outboxIndex];
    expect(outbox?.values?.[4]).toBe(
      JSON.stringify({
        version: 1,
        tenantId: TENANT_ID,
        accountId: ACCOUNT_ID,
        revisionId: REVISION_ID,
      }),
    );
    expect(outbox?.values?.[4]).not.toContain('private content');
  });

  it('commitPage_whenDuplicateContentChanged_rollsBackBeforeHeadOutboxOrCursor', async () => {
    const client = new ScriptedClient((query) => {
      if (query.text.includes('FROM botmem.connector_account ca')) return result(accountRow());
      if (query.text.includes('INSERT INTO botmem.ingest_event_revision')) {
        return { rows: [], rowCount: 0 };
      }
      if (query.text.includes('SELECT id, content_hash')) {
        return result({ id: REVISION_ID, content_hash: 'c'.repeat(64) });
      }
      return { rows: [], rowCount: null };
    });
    const unitOfWork = new PostgresHostedIngestionUnitOfWork(pool(client));

    await expect(unitOfWork.commitPage(pageCommit())).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
    expect(client.queries.at(-1)?.text).toBe('ROLLBACK');
    expect(
      client.queries.some((query) =>
        query.text.includes('INSERT INTO botmem.transactional_outbox'),
      ),
    ).toBe(false);
    expect(
      client.queries.some((query) =>
        query.text.includes('INSERT INTO botmem.connector_checkpoint'),
      ),
    ).toBe(false);
  });

  it('claimSync_whenExistingLeaseHasNotExpired_rejectsBeforeInsert', async () => {
    const client = new ScriptedClient((query) =>
      query.text.includes('FROM botmem.connector_account ca')
        ? result(accountRow({ leaseExpiresAt: '2026-07-13T10:20:00.000Z' }))
        : { rows: [], rowCount: null },
    );
    const unitOfWork = new PostgresHostedIngestionUnitOfWork(pool(client));

    await expect(
      unitOfWork.claimSync({
        tenantId: TENANT_ID,
        accountId: ACCOUNT_ID,
        expectedAggregateVersion: 1,
        replacesExpiredSyncId: SYNC_ID,
        sync: {
          id: syncId('30000000-0000-4000-8000-000000000002'),
          startedAt: '2026-07-13T10:10:00.000Z',
          leaseExpiresAt: '2026-07-13T10:25:00.000Z',
        },
      }),
    ).rejects.toBeInstanceOf(ConcurrentSyncError);
    expect(client.queries.at(-1)?.text).toBe('ROLLBACK');
    expect(
      client.queries.some((query) => query.text.includes('INSERT INTO botmem.connector_sync')),
    ).toBe(false);
  });
});
