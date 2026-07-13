import { SearchCandidateSchema } from '@botmem-v2/contracts';
import { describe, expect, it } from 'vitest';
import { PostgresHostedProjectionStore } from './postgres-hosted-projection.js';
import type {
  SqlClientPort,
  SqlPoolPort,
  SqlQueryConfig,
  SqlQueryResult,
} from './postgres-ports.js';

const WORKSPACE_ID = '10000000-0000-4000-8000-000000000001';
const ACCOUNT_ID = '20000000-0000-4000-8000-000000000001';
const REVISION_ID = '40000000-0000-4000-8000-000000000001';

class ProjectionClient implements SqlClientPort {
  readonly queries: SqlQueryConfig[] = [];

  async query<Row>(query: SqlQueryConfig): Promise<SqlQueryResult<Row>> {
    this.queries.push(query);
    if (query.text.includes('FROM botmem.ingest_event_revision revision')) {
      return result({
        account_id: ACCOUNT_ID,
        connector: 'gmail',
        source_event_id: 'message-1',
        source_revision: 'history:1',
        kind: 'email',
        occurred_at: '2026-07-13T09:00:00Z',
        content_hash: 'a'.repeat(64),
        tombstone: false,
      }) as SqlQueryResult<Row>;
    }
    if (query.text.includes('INSERT INTO botmem.projection_state')) {
      return result({ state: 'processing', output_hash: null }) as SqlQueryResult<Row>;
    }
    if (query.text.includes('FROM botmem.embedding_profile')) {
      return result({
        status: 'ready',
        model_revision: 'text-embedding-3-small',
      }) as SqlQueryResult<Row>;
    }
    if (query.text.includes('INSERT INTO botmem.hosted_document_revision')) {
      return result({
        content_hash: 'a'.repeat(64),
        projection_hash: 'b'.repeat(64),
      }) as SqlQueryResult<Row>;
    }
    if (query.text.includes('UPDATE botmem.projection_state')) {
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: query.text === 'BEGIN' || query.text === 'COMMIT' ? null : 1 };
  }

  release(): void {}
}

function result<Row>(row: Row): SqlQueryResult<Row> {
  return { rows: [row], rowCount: 1 };
}

describe('PostgresHostedProjectionStore', () => {
  it('project_withParticipants_derivesFiltersOnlyFromDurableIdentifiers', async () => {
    const client = new ProjectionClient();
    const pool: SqlPoolPort = { connect: async () => client };
    const store = new PostgresHostedProjectionStore(pool);
    const candidate = SearchCandidateSchema.parse({
      ref: `hosted:${REVISION_ID}`,
      sourceId: 'message-1',
      revision: 'history:1',
      origin: { placement: 'hosted', connector: 'gmail', accountId: ACCOUNT_ID },
      kind: 'email',
      occurredAt: '2026-07-13T09:00:00Z',
      text: 'release planning',
      participants: [
        {
          durableId: 'email:owner@example.com',
          displayName: 'Owner Name',
          identifiers: [{ kind: 'email', value: 'owner@example.com' }],
        },
      ],
      media: [],
      citation: 'gmail://message-1',
    });

    await expect(
      store.project({
        workspaceId: WORKSPACE_ID,
        accountId: ACCOUNT_ID,
        revisionId: REVISION_ID,
        workerId: 'worker-1',
        leaseExpiresAt: '2026-07-13T10:10:00Z',
        projectedAt: '2026-07-13T10:00:00Z',
        outputHash: 'b'.repeat(64),
        candidate,
        embedding: {
          profileId: 'hosted-multilingual-v1',
          modelRevision: 'text-embedding-3-small',
          values: Array.from({ length: 768 }, () => 0.01),
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toBe('applied');

    const insert = client.queries.find((query) =>
      query.text.includes('INSERT INTO botmem.hosted_document_revision'),
    );
    expect(insert?.values?.[15]).toEqual(['email:owner@example.com']);
    expect(insert?.values?.[15]).not.toContain('Owner Name');
    const claim = client.queries.find((query) =>
      query.text.includes('INSERT INTO botmem.projection_state'),
    );
    const settlement = client.queries.find((query) =>
      query.text.includes('UPDATE botmem.projection_state'),
    );
    expect(claim?.values?.[5]).toMatch(/^[0-9a-f-]{36}$/u);
    expect(settlement?.values?.[5]).toBe(claim?.values?.[5]);
    expect(settlement?.text).toContain('lease_token = $6::uuid');
  });
});
