import {
  HostedIngestionService,
  connectorAccountId,
  ingestRevisionId,
  outboxMessageId,
  syncId,
  tenantId,
  type IngestionIdFactory,
} from '@botmem-v2/connector-domain';
import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NodePostgresPoolAdapter } from '../search/node-postgres.js';
import {
  NodeIngestionIdFactory,
  PostgresHostedIngestionUnitOfWork,
} from './postgres-hosted-ingestion.js';

const WORKER_DATABASE_URL = process.env['BOTMEM_TEST_WORKER_DATABASE_URL'];
const ADMIN_DATABASE_URL = process.env['BOTMEM_TEST_ADMIN_DATABASE_URL'];
const enabled = Boolean(WORKER_DATABASE_URL && ADMIN_DATABASE_URL);

const TENANT_ID = tenantId('10000000-0000-4000-8000-000000000091');
const ACCOUNT_ID = connectorAccountId('20000000-0000-4000-8000-000000000091');
const SYNC_ID = syncId('30000000-0000-4000-8000-000000000091');
const REVISION_ID = ingestRevisionId('40000000-0000-4000-8000-000000000091');
const OUTBOX_ID = outboxMessageId('50000000-0000-4000-8000-000000000091');

class FixedIds implements IngestionIdFactory {
  nextRevisionId() {
    return REVISION_ID;
  }

  nextOutboxMessageId() {
    return OUTBOX_ID;
  }
}

describe.skipIf(!enabled)('PostgresHostedIngestionUnitOfWork real PostgreSQL', () => {
  const admin = new Pool({ connectionString: ADMIN_DATABASE_URL });
  const worker = new NodePostgresPoolAdapter({ connectionString: WORKER_DATABASE_URL });

  beforeAll(async () => {
    await admin.query(
      `
      INSERT INTO botmem.connector_account (
        id, tenant_id, connector, auth_kind, provider_subject_hash,
        credential_ref, status
      )
      VALUES ($1::uuid, $2::uuid, 'gmail', 'oauth2', $3, $4, 'ready')
      ON CONFLICT (id) DO NOTHING
    `,
      [ACCOUNT_ID, TENANT_ID, 'a'.repeat(64), 'vault://gmail/integration'],
    );
  });

  afterAll(async () => {
    await worker.close();
    await admin.end();
  });

  it('syncsOnePageWithAtomicRevisionHeadOutboxAndCursor', async () => {
    const service = new HostedIngestionService(
      new PostgresHostedIngestionUnitOfWork(worker),
      new FixedIds(),
    );
    await service.startSync({
      tenantId: TENANT_ID,
      accountId: ACCOUNT_ID,
      syncId: SYNC_ID,
      startedAt: '2026-07-13T10:00:00.000Z',
      leaseExpiresAt: '2026-07-13T10:15:00.000Z',
    });
    const committed = await service.commitPage({
      tenantId: TENANT_ID,
      accountId: ACCOUNT_ID,
      syncId: SYNC_ID,
      expectedCursorVersion: 0,
      nextCursor: { historyId: '2' },
      observedAt: '2026-07-13T10:01:00.000Z',
      events: [
        {
          sourceEventId: 'message-91',
          sourceRevision: 'history-2',
          kind: 'email',
          occurredAt: '2026-07-13T09:00:00.000Z',
          contentHash: createHash('sha256').update('message-91/history-2').digest('hex'),
          payload: { subject: 'integration sentinel' },
        },
      ],
    });
    expect(committed).toMatchObject({
      insertedRevisionIds: [REVISION_ID],
      duplicateRevisionCount: 0,
      account: { cursorVersion: 1, aggregateVersion: 2 },
    });
    await service.closeSync({
      tenantId: TENANT_ID,
      accountId: ACCOUNT_ID,
      syncId: SYNC_ID,
      outcome: 'completed',
      closedAt: '2026-07-13T10:02:00.000Z',
    });

    const evidence = await admin.query<{
      revisions: string;
      heads: string;
      outbox: string;
      cursor_version: string;
      aggregate_version: string;
      active_syncs: string;
    }>(
      `
      SELECT
        (SELECT count(*) FROM botmem.ingest_event_revision WHERE tenant_id = $1) AS revisions,
        (SELECT count(*) FROM botmem.ingest_event_head WHERE tenant_id = $1) AS heads,
        (SELECT count(*) FROM botmem.transactional_outbox WHERE tenant_id = $1) AS outbox,
        (SELECT cursor_version FROM botmem.connector_checkpoint WHERE account_id = $2) AS cursor_version,
        (SELECT aggregate_version FROM botmem.connector_account WHERE id = $2) AS aggregate_version,
        (SELECT count(*) FROM botmem.connector_sync WHERE account_id = $2 AND state = 'active') AS active_syncs
    `,
      [TENANT_ID, ACCOUNT_ID],
    );
    expect(evidence.rows[0]).toEqual({
      revisions: '1',
      heads: '1',
      outbox: '1',
      cursor_version: '1',
      aggregate_version: '3',
      active_syncs: '0',
    });
  });

  it('nodeIdFactory_returnsValidDistinctUUIDs', () => {
    const ids = new NodeIngestionIdFactory();
    expect(ids.nextRevisionId()).not.toBe(ids.nextRevisionId());
    expect(ids.nextOutboxMessageId()).not.toBe(ids.nextOutboxMessageId());
  });
});
