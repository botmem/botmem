import { parseSearchRequest } from '@botmem-v2/contracts';
import { describe, expect, it, vi } from 'vitest';
import { PostgresHostedSearch } from './postgres-hosted-search.js';
import type {
  QueryEmbeddingPort,
  SqlClientPort,
  SqlPoolPort,
  SqlQueryConfig,
  SqlQueryResult,
} from './postgres-ports.js';

const WORKSPACE_ID = '10000000-0000-4000-8000-000000000001';
const ACCOUNT_ID = '20000000-0000-4000-8000-000000000001';
const REVISION_ID = '40000000-0000-4000-8000-000000000001';

class RecordingClient implements SqlClientPort {
  readonly queries: SqlQueryConfig[] = [];
  released = false;

  constructor(private readonly response: (query: SqlQueryConfig) => SqlQueryResult<unknown>) {}

  async query<Row>(query: SqlQueryConfig): Promise<SqlQueryResult<Row>> {
    this.queries.push(query);
    return this.response(query) as SqlQueryResult<Row>;
  }

  release(): void {
    this.released = true;
  }
}

function pool(client: RecordingClient): SqlPoolPort {
  return { connect: vi.fn(async () => client) };
}

function embeddings(): QueryEmbeddingPort {
  return {
    embed: vi.fn(async () => ({
      profileId: 'hosted-multilingual-v1' as const,
      modelRevision: 'model-1',
      values: Array.from({ length: 768 }, () => 0.01),
    })),
  };
}

describe('PostgresHostedSearch', () => {
  it('search_withReadyProfile_mapsCanonicalCandidateAndBindsEveryFilter', async () => {
    const client = new RecordingClient((query) => {
      if (query.text.includes('FROM botmem.embedding_profile')) {
        return {
          rows: [{ status: 'ready', dimensions: 768, model_revision: 'model-1' }],
          rowCount: 1,
        };
      }
      if (query.text.includes('WITH eligible')) {
        return {
          rows: [
            {
              revision_id: REVISION_ID,
              account_id: ACCOUNT_ID,
              connector: 'gmail',
              source_event_id: 'message-1',
              source_revision: 'history:1',
              kind: 'email',
              occurred_at: new Date('2026-07-13T09:00:00Z'),
              title: 'Launch',
              body: 'release planning',
              thread_durable_id: 'thread-1',
              thread_title: 'Planning',
              authored_by_me: true,
              citation: 'gmail://message-1',
              participants: [],
              media: [],
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: null };
    });
    const service = new PostgresHostedSearch(pool(client), embeddings());
    const signal = new AbortController().signal;
    const result = await service.search(
      WORKSPACE_ID,
      parseSearchRequest({
        version: 2,
        query: 'release planning',
        connectors: ['gmail'],
        kinds: ['email'],
        from: '2026-01-01T00:00:00Z',
        to: '2026-12-31T23:59:59Z',
        participantId: 'owner@example.com',
        authoredByMe: true,
        accountIds: [ACCOUNT_ID],
        limit: 10,
      }),
      { queryId: '30000000-0000-4000-8000-000000000001', signal },
    );

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      ref: `hosted:${REVISION_ID}`,
      sourceId: 'message-1',
      origin: { placement: 'hosted', connector: 'gmail', accountId: ACCOUNT_ID },
    });
    const search = client.queries.find((query) => query.text.includes('WITH eligible'));
    expect(search?.values?.slice(4, 13)).toEqual([
      ['gmail'],
      ['email'],
      '2026-01-01T00:00:00Z',
      '2026-12-31T23:59:59Z',
      'owner@example.com',
      true,
      [ACCOUNT_ID],
      40,
      10,
    ]);
    expect(search?.text).not.toContain('release planning');
    expect(search?.text).toContain('(SELECT count(*) FROM lexical) < $12::integer');
    expect(search?.text).toContain("strpos(btrim(botmem.normalize_search_text($2::text)), ' ') = 0");
    expect(client.queries).toContainEqual(
      expect.objectContaining({
        text: expect.stringContaining("set_config('hnsw.ef_search'"),
        values: ['500'],
      }),
    );
    expect(client.queries).toContainEqual(
      expect.objectContaining({
        text: expect.stringContaining("set_config('random_page_cost', '1.1'"),
      }),
    );
    expect(
      client.queries.every((query) => query.signal === signal || query.text === 'ROLLBACK'),
    ).toBe(true);
    expect(client.released).toBe(true);
  });

  it('search_whenProfileIsStillIndexing_returnsLexicalResultsAsDegraded', async () => {
    const client = new RecordingClient((query) => {
      if (query.text.includes('FROM botmem.embedding_profile')) {
        return {
          rows: [{ status: 'indexing', dimensions: 768, model_revision: 'unconfigured' }],
          rowCount: 1,
        };
      }
      if (query.text.includes('WITH eligible')) {
        return { rows: [searchRow()], rowCount: 1 };
      }
      return { rows: [], rowCount: null };
    });
    const service = new PostgresHostedSearch(pool(client), embeddings());

    const result = await service.search(
      WORKSPACE_ID,
      parseSearchRequest({ version: 2, query: 'launch' }),
      {
        queryId: '30000000-0000-4000-8000-000000000001',
        signal: new AbortController().signal,
      },
    );

    expect(result).toMatchObject({
      candidates: [expect.objectContaining({ ref: `hosted:${REVISION_ID}` })],
      degradation: { reasonCode: 'embedding_profile_indexing', retryable: true },
    });
    const search = client.queries.find((query) => query.text.includes('WITH eligible'));
    expect(search?.text).not.toContain('semantic_ann');
    expect(search?.values).toEqual([
      WORKSPACE_ID,
      'launch',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      80,
      20,
    ]);
  });

  it('search_whenEmbeddingProviderFails_doesNotSuppressLexicalMatches', async () => {
    const client = new RecordingClient((query) =>
      query.text.includes('WITH eligible')
        ? { rows: [searchRow()], rowCount: 1 }
        : { rows: [], rowCount: null },
    );
    const embeddingPort: QueryEmbeddingPort = {
      embed: vi.fn(async () => {
        throw Object.assign(new Error('provider details must not escape'), {
          code: 'embedding_timeout',
        });
      }),
    };
    const service = new PostgresHostedSearch(pool(client), embeddingPort);

    const result = await service.search(
      WORKSPACE_ID,
      parseSearchRequest({ version: 2, query: 'launch' }),
      {
        queryId: '30000000-0000-4000-8000-000000000001',
        signal: new AbortController().signal,
      },
    );

    expect(result.degradation).toEqual({
      reasonCode: 'embedding_timeout',
      retryable: true,
    });
    expect(result.candidates).toHaveLength(1);
    expect(client.queries.some((query) => query.text.includes('embedding_profile'))).toBe(false);
    expect(client.queries.some((query) => query.text.includes('hnsw.ef_search'))).toBe(false);
    const search = client.queries.find((query) => query.text.includes('WITH eligible'));
    expect(search?.text).toContain('(SELECT count(*) FROM lexical) < $10::integer');
    expect(search?.text).not.toContain(
      "strpos(btrim(botmem.normalize_search_text($2::text)), ' ') = 0",
    );
  });

  it('search_whenAlreadyAborted_doesNotEmbedOrConnect', async () => {
    const embeddingPort = embeddings();
    const connect = vi.fn<SqlPoolPort['connect']>();
    const controller = new AbortController();
    controller.abort();
    const service = new PostgresHostedSearch({ connect }, embeddingPort);

    await expect(
      service.search(WORKSPACE_ID, parseSearchRequest({ version: 2, query: 'launch' }), {
        queryId: '30000000-0000-4000-8000-000000000001',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'search_aborted' });
    expect(embeddingPort.embed).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it('constructor_rejectsUnsafeAnnBreadth', () => {
    expect(
      () =>
        new PostgresHostedSearch(
          pool(new RecordingClient(() => ({ rows: [], rowCount: 0 }))),
          embeddings(),
          {
            hnswEfSearch: 39,
          },
        ),
    ).toThrow(/hnswEfSearch/);
  });
});

function searchRow() {
  return {
    revision_id: REVISION_ID,
    account_id: ACCOUNT_ID,
    connector: 'gmail',
    source_event_id: 'message-1',
    source_revision: 'history:1',
    kind: 'email',
    occurred_at: new Date('2026-07-13T09:00:00Z'),
    title: 'Launch',
    body: 'release planning',
    thread_durable_id: 'thread-1',
    thread_title: 'Planning',
    authored_by_me: true,
    citation: 'gmail://message-1',
    participants: [],
    media: [],
  } as const;
}
