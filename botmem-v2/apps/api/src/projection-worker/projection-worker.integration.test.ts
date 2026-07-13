import { parseSearchRequest } from '@botmem-v2/contracts';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NodePostgresPoolAdapter } from '../search/node-postgres.js';
import { PostgresHostedProjectionStore } from '../search/postgres-hosted-projection.js';
import { PostgresHostedSearch } from '../search/postgres-hosted-search.js';
import type { QueryEmbeddingPort } from '../search/postgres-ports.js';
import { HostedProjectionMaterializer } from './materializer.js';
import { PostgresOutboxDispatcher } from './postgres-dispatcher.js';
import { PostgresHostedProjectionInputReader } from './postgres-input.js';
import { PostgresSearchReadinessProbe } from './postgres-readiness-probe.js';
import { PostgresRuntimeRoleValidator } from './postgres-role-health.js';
import { ProjectionOutboxWorker } from './worker.js';

const ADMIN_DATABASE_URL = process.env['BOTMEM_TEST_ADMIN_DATABASE_URL'];
const API_DATABASE_URL = process.env['BOTMEM_TEST_API_DATABASE_URL'];
const WORKER_DATABASE_URL = process.env['BOTMEM_TEST_WORKER_DATABASE_URL'];
const DISPATCHER_DATABASE_URL = process.env['BOTMEM_TEST_DISPATCHER_DATABASE_URL'];
const enabled = Boolean(
  ADMIN_DATABASE_URL && API_DATABASE_URL && WORKER_DATABASE_URL && DISPATCHER_DATABASE_URL,
);

describe.skipIf(!enabled)('projection worker real PostgreSQL', () => {
  const admin = new Pool({ connectionString: ADMIN_DATABASE_URL! });
  const apiPool = new NodePostgresPoolAdapter({ connectionString: API_DATABASE_URL! });
  const workerPool = new NodePostgresPoolAdapter({ connectionString: WORKER_DATABASE_URL! });
  const dispatcherPool = new NodePostgresPoolAdapter({
    connectionString: DISPATCHER_DATABASE_URL!,
  });
  const dispatcher = new PostgresOutboxDispatcher(dispatcherPool);
  const store = new PostgresHostedProjectionStore(workerPool);
  let modelRevision = 'projection-integration-model-v1';

  beforeAll(async () => {
    const profile = await admin.query<{ model_revision: string }>(
      "SELECT model_revision FROM botmem.embedding_profile WHERE id = 'hosted-multilingual-v1'",
    );
    if (profile.rows[0]?.model_revision !== 'unconfigured') {
      modelRevision = profile.rows[0]!.model_revision;
    }
    const validator = new PostgresRuntimeRoleValidator();
    const signal = new AbortController().signal;
    await Promise.all([
      validator.validate(dispatcherPool, 'botmem_dispatcher', signal),
      validator.validate(workerPool, 'botmem_worker', signal),
      validator.validate(apiPool, 'botmem_api', signal),
    ]);
  });

  afterAll(async () => {
    await Promise.all([apiPool.close(), workerPool.close(), dispatcherPool.close()]);
    await admin.end();
  });

  it('claims content-free outbox work, projects it, probes it and returns it from real search', async () => {
    const fixture = await insertFixture(admin, 'claim-search');
    const embeddings = fixedEmbeddings(() => modelRevision);
    const worker = projectionWorker(embeddings);

    await expect(worker.runOnce()).resolves.toBeGreaterThanOrEqual(1);

    const evidence = await admin.query<{
      outbox_state: string;
      projection_state: string;
      searchable: boolean;
    }>(
      `
      SELECT outbox.state AS outbox_state, projection.state AS projection_state,
             health.searchable
        FROM botmem.transactional_outbox outbox
        JOIN botmem.projection_state projection ON projection.revision_id = outbox.revision_id
        JOIN botmem.hosted_source_health health ON health.account_id = outbox.account_id
       WHERE outbox.id = $1::uuid
    `,
      [fixture.outboxId],
    );
    expect(evidence.rows[0]).toEqual({
      outbox_state: 'published',
      projection_state: 'applied',
      searchable: true,
    });

    const result = await new PostgresHostedSearch(apiPool, embeddings, {
      statementTimeoutMs: 5_000,
    }).search(
      fixture.workspaceId,
      parseSearchRequest({ version: 2, query: fixture.sentinel, limit: 10 }),
      { queryId: randomUUID(), signal: new AbortController().signal },
    );
    expect(
      result.candidates.some((candidate) => candidate.sourceId === fixture.sourceEventId),
    ).toBe(true);
  });

  it('durably retries a transient projection failure and later publishes exactly one document', async () => {
    const fixture = await insertFixture(admin, 'retry');
    let calls = 0;
    const embeddings = fixedEmbeddings(() => {
      calls += 1;
      if (calls === 1) throw new Error('provider payload must not be logged');
      return modelRevision;
    });
    const worker = projectionWorker(embeddings);

    await worker.runOnce();
    const failed = await admin.query<{ state: string; attempts: number }>(
      'SELECT state, attempts FROM botmem.transactional_outbox WHERE id = $1::uuid',
      [fixture.outboxId],
    );
    expect(failed.rows[0]).toEqual({ state: 'pending', attempts: 1 });
    await admin.query(
      'UPDATE botmem.transactional_outbox SET next_attempt_at = statement_timestamp() WHERE id = $1::uuid',
      [fixture.outboxId],
    );

    await worker.runOnce();

    const recovered = await admin.query<{ state: string; documents: string }>(
      `
      SELECT outbox.state,
             (SELECT count(*) FROM botmem.hosted_document_revision WHERE revision_id = $2::uuid) AS documents
        FROM botmem.transactional_outbox outbox WHERE outbox.id = $1::uuid
    `,
      [fixture.outboxId, fixture.revisionId],
    );
    expect(recovered.rows[0]).toEqual({ state: 'published', documents: '1' });
  });

  it('returns real PostgreSQL lexical matches when query embeddings are unavailable', async () => {
    const fixture = await insertFixture(admin, 'lexical-fallback');
    await projectionWorker(fixedEmbeddings(() => modelRevision)).runOnce();
    const unavailableEmbeddings: QueryEmbeddingPort = {
      embed: vi.fn(async () => {
        throw Object.assign(new Error('provider payload must remain private'), {
          code: 'embedding_timeout',
        });
      }),
    };

    const result = await new PostgresHostedSearch(apiPool, unavailableEmbeddings, {
      statementTimeoutMs: 5_000,
    }).search(
      fixture.workspaceId,
      parseSearchRequest({ version: 2, query: fixture.sentinel, limit: 10 }),
      { queryId: randomUUID(), signal: new AbortController().signal },
    );

    expect(
      result.candidates.some((candidate) => candidate.sourceId === fixture.sourceEventId),
    ).toBe(true);
    expect(result.degradation).toEqual({
      reasonCode: 'embedding_timeout',
      retryable: true,
    });
  });

  it('repairs an active ingest head whose outbox was dead-lettered before projection', async () => {
    const fixture = await insertFixture(admin, 'repair', 'dead');
    const worker = projectionWorker(fixedEmbeddings(() => modelRevision));

    await expect(worker.runRepairOnce()).resolves.toBeGreaterThanOrEqual(1);

    const repaired = await admin.query<{
      state: string;
      projection_state: string;
      documents: string;
    }>(
      `
      SELECT outbox.state, projection.state AS projection_state,
             (SELECT count(*) FROM botmem.hosted_document_revision WHERE revision_id = $2::uuid) AS documents
        FROM botmem.transactional_outbox outbox
        JOIN botmem.projection_state projection ON projection.revision_id = outbox.revision_id
       WHERE outbox.id = $1::uuid
    `,
      [fixture.outboxId, fixture.revisionId],
    );
    expect(repaired.rows[0]).toEqual({
      state: 'dead',
      projection_state: 'applied',
      documents: '1',
    });
  });

  it('repairs an active ingest head even when its outbox row is missing', async () => {
    const fixture = await insertFixture(admin, 'repair-no-outbox');
    await admin.query('DELETE FROM botmem.transactional_outbox WHERE id = $1::uuid', [
      fixture.outboxId,
    ]);
    const worker = projectionWorker(fixedEmbeddings(() => modelRevision));

    await expect(worker.runRepairOnce()).resolves.toBeGreaterThanOrEqual(1);

    const repaired = await admin.query<{ projection_state: string; documents: string }>(
      `SELECT projection.state AS projection_state,
              (SELECT count(*) FROM botmem.hosted_document_revision
                WHERE revision_id = $1::uuid) AS documents
         FROM botmem.projection_state projection
        WHERE projection.revision_id = $1::uuid`,
      [fixture.revisionId],
    );
    expect(repaired.rows[0]).toEqual({ projection_state: 'applied', documents: '1' });
  });

  it('repairs a pending projection whose outbox row is missing', async () => {
    const fixture = await insertFixture(admin, 'repair-pending-no-outbox');
    await admin.query('DELETE FROM botmem.transactional_outbox WHERE id = $1::uuid', [
      fixture.outboxId,
    ]);
    await admin.query(
      `INSERT INTO botmem.projection_state (
         tenant_id, account_id, projection_name, revision_id, state, attempts
       ) VALUES ($1::uuid, $2::uuid, 'hosted_search_v1', $3::uuid, 'pending', 0)`,
      [fixture.workspaceId, fixture.accountId, fixture.revisionId],
    );

    await expect(
      projectionWorker(fixedEmbeddings(() => modelRevision)).runRepairOnce(),
    ).resolves.toBeGreaterThanOrEqual(1);

    const repaired = await admin.query<{ projection_state: string; documents: string }>(
      `SELECT projection.state AS projection_state,
              (SELECT count(*) FROM botmem.hosted_document_revision
                WHERE revision_id = $1::uuid) AS documents
         FROM botmem.projection_state projection
        WHERE projection.revision_id = $1::uuid`,
      [fixture.revisionId],
    );
    expect(repaired.rows[0]).toEqual({ projection_state: 'applied', documents: '1' });
  });

  function projectionWorker(embeddings: QueryEmbeddingPort): ProjectionOutboxWorker {
    const materializer = new HostedProjectionMaterializer(
      new PostgresHostedProjectionInputReader(workerPool),
      embeddings,
      store,
      new PostgresSearchReadinessProbe(workerPool, 5_000),
    );
    return new ProjectionOutboxWorker(
      dispatcher,
      materializer,
      store,
      { event: vi.fn(), metric: vi.fn() },
      {
        workerId: `projection.integration.${randomUUID()}`,
        batchSize: 16,
        concurrency: 4,
        leaseMs: 60_000,
        taskTimeoutMs: 45_000,
        maxAttempts: 3,
        backoffBaseMs: 100,
        backoffMaxMs: 1_000,
      },
    );
  }
});

function fixedEmbeddings(model: () => string): QueryEmbeddingPort {
  return {
    embed: vi.fn(async () => ({
      profileId: 'hosted-multilingual-v1' as const,
      modelRevision: model(),
      values: Object.freeze(Array.from({ length: 768 }, (_, index) => (index + 1) / 768)),
    })),
  };
}

async function insertFixture(
  admin: Pool,
  label: string,
  outboxState: 'pending' | 'dead' = 'pending',
) {
  const workspaceId = randomUUID();
  const accountId = randomUUID();
  const syncId = randomUUID();
  const revisionId = randomUUID();
  const outboxId = randomUUID();
  const sourceEventId = `${label}-${randomUUID()}`;
  const sentinel = `${label} searchable sentinel ${randomUUID()}`;
  await admin.query('BEGIN');
  try {
    await admin.query(
      `
      INSERT INTO botmem.connector_account (
        id, tenant_id, connector, auth_kind, provider_subject_hash,
        credential_ref, status, aggregate_version
      ) VALUES ($1::uuid, $2::uuid, 'gmail', 'oauth2', $3, $4, 'ready', 1)
    `,
      [
        accountId,
        workspaceId,
        createHash('sha256').update(accountId).digest('hex'),
        `vault://${accountId}`,
      ],
    );
    await admin.query(
      `
      INSERT INTO botmem.connector_sync (
        id, tenant_id, account_id, state, aggregate_version_at_claim,
        started_at, lease_expires_at, closed_at
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, 'completed', 0,
        '2026-07-13T09:00:00Z', '2026-07-13T09:30:00Z', '2026-07-13T09:05:00Z'
      )
    `,
      [syncId, workspaceId, accountId],
    );
    await admin.query(
      `
      INSERT INTO botmem.connector_checkpoint (
        tenant_id, account_id, cursor_version, cursor, last_sync_id, last_committed_at
      ) VALUES ($1::uuid, $2::uuid, 1, '{}'::jsonb, $3::uuid, '2026-07-13T09:05:00Z')
    `,
      [workspaceId, accountId, syncId],
    );
    const payload = {
      schema: 'gmail.message.v1',
      normalized: {
        sourceId: sourceEventId,
        title: `${label} subject`,
        text: sentinel,
        participants: [],
        media: [],
      },
    };
    await admin.query(
      `
      INSERT INTO botmem.ingest_event_revision (
        id, tenant_id, account_id, source_event_id, source_revision, kind,
        occurred_at, observed_at, content_hash, payload, tombstone
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4, 'revision-1', 'email',
        '2026-07-13T09:04:00Z', '2026-07-13T09:05:00Z', $5, $6::jsonb, false
      )
    `,
      [
        revisionId,
        workspaceId,
        accountId,
        sourceEventId,
        createHash('sha256').update(sentinel).digest('hex'),
        JSON.stringify(payload),
      ],
    );
    await admin.query(
      `
      INSERT INTO botmem.ingest_event_head (
        tenant_id, account_id, source_event_id, head_revision_id, updated_at
      ) VALUES ($1::uuid, $2::uuid, $3, $4::uuid, '2026-07-13T09:05:00Z')
    `,
      [workspaceId, accountId, sourceEventId, revisionId],
    );
    await admin.query(
      `
      INSERT INTO botmem.transactional_outbox (
        id, tenant_id, account_id, revision_id, payload, state
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4::uuid,
        jsonb_build_object('revisionId', $4::text, 'accountId', $3::text), $5
      )
    `,
      [outboxId, workspaceId, accountId, revisionId, outboxState],
    );
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK');
    throw error;
  }
  return { workspaceId, accountId, revisionId, outboxId, sourceEventId, sentinel };
}
