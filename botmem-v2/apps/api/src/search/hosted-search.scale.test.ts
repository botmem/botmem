import { parseSearchRequest } from '@botmem-v2/contracts';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NodePostgresPoolAdapter } from './node-postgres.js';
import { PostgresHostedSearch } from './postgres-hosted-search.js';
import type { QueryEmbeddingPort } from './postgres-ports.js';

const RUN = process.env['BOTMEM_RUN_SCALE_BENCHMARK'] === '1';
const ADMIN_DATABASE_URL = process.env['BOTMEM_BENCH_ADMIN_DATABASE_URL'];
const API_DATABASE_URL = process.env['BOTMEM_BENCH_API_DATABASE_URL'];
const ENABLED = RUN && Boolean(ADMIN_DATABASE_URL && API_DATABASE_URL);
const EXPECTED_DATABASE = 'botmem_v2_bench';
const DOCUMENT_COUNT = 100_000;
const WORKSPACE_ID = 'b0000000-0000-4000-8000-000000000001';
const ACCOUNT_ID = 'b0000000-0000-4000-8000-000000000002';
const MODEL_REVISION = 'botmem-scale-benchmark-v2';

/**
 * Destructive manual release gate. Both URLs must point to a disposable
 * database named exactly `botmem_v2_bench`; the test refuses every other name.
 * Migrations V1 and V2 and an exact botmem_api login must already exist.
 */
describe.skipIf(!ENABLED)('hosted search 100k release benchmark', () => {
  const admin = new Pool({ connectionString: ADMIN_DATABASE_URL! });
  const api = new NodePostgresPoolAdapter({
    connectionString: API_DATABASE_URL!,
    max: 8,
  });

  beforeAll(async () => {
    const database = await admin.query<{ current_database: string }>('SELECT current_database()');
    expect(database.rows[0]?.current_database).toBe(EXPECTED_DATABASE);
    await seedCorpus(admin);
  }, 600_000);

  afterAll(async () => {
    await Promise.all([admin.end(), api.close()]);
  });

  it('keeps a mixed English, Arabic, typo and semantic workload below the hosted p95 gate', async () => {
    const embeddings: QueryEmbeddingPort = {
      embed: async (query) => ({
        profileId: 'hosted-multilingual-v1',
        modelRevision: MODEL_REVISION,
        values: vectorForQuery(query),
      }),
    };
    const search = new PostgresHostedSearch(api, embeddings, {
      // The production outer lane budget is 750ms. The measured release gate
      // remains stricter and fails if PostgreSQL needs this backstop.
      statementTimeoutMs: 700,
      laneOversampling: 4,
    });
    const typoLane = await admin.query<{ matched: boolean }>(
      `SELECT word_similarity(botmem.normalize_search_text($1), search_text) >= 0.3 AS matched
         FROM botmem.hosted_document_revision
        WHERE source_event_id = 'message:100000'`,
      ['launhc'],
    );
    expect(typoLane.rows[0]?.matched).toBe(true);
    await expect(runSearch(search, 'launch sentinel')).resolves.toContain('message:100000');
    await expect(runSearch(search, 'مرحبا')).resolves.toContain('message:099001');
    await expect(runSearch(search, 'launhc')).resolves.toContain('message:100000');
    await expect(runSearch(search, 'conceptual recollection')).resolves.toContain('message:000002');
    const workload = Array.from({ length: 100 }, (_, index) => {
      switch (index % 10) {
        case 0:
          return 'ordinary record';
        case 1:
        case 2:
          return 'مرحبا';
        case 3:
          return 'launhc';
        case 4:
          return 'conceptual recollection';
        default:
          return 'launch sentinel';
      }
    });

    for (const query of workload.slice(0, 10)) {
      await runSearch(search, query);
    }

    const samplesMs: number[] = [];
    for (const query of workload) {
      const started = performance.now();
      const result = await runSearch(search, query);
      samplesMs.push(performance.now() - started);
      expect(result.length).toBeGreaterThan(0);
    }
    samplesMs.sort((left, right) => left - right);
    const evidence = {
      documents: DOCUMENT_COUNT,
      samples: samplesMs.length,
      p50Ms: percentile(samplesMs, 50),
      p95Ms: percentile(samplesMs, 95),
      p99Ms: percentile(samplesMs, 99),
      maxMs: samplesMs.at(-1) ?? 0,
    };
    process.stderr.write(`BOTMEM_HOSTED_SEARCH_BENCHMARK ${JSON.stringify(evidence)}\n`);
    expect(evidence.p95Ms).toBeLessThanOrEqual(500);

    const degradedSearch = new PostgresHostedSearch(
      api,
      {
        embed: async () => {
          throw Object.assign(new Error('synthetic provider outage'), {
            code: 'embedding_timeout',
          });
        },
      },
      {
        statementTimeoutMs: 700,
        laneOversampling: 4,
      },
    );
    const degradedWorkload = Array.from({ length: 30 }, (_, index) =>
      index % 3 === 0 ? 'مرحبا' : index % 3 === 1 ? 'launhc' : 'launch sentinel',
    );
    const degradedSamplesMs: number[] = [];
    for (const query of degradedWorkload) {
      const started = performance.now();
      const result = await degradedSearch.search(
        WORKSPACE_ID,
        parseSearchRequest({ version: 2, query, limit: 20 }),
        { queryId: randomUUID(), signal: AbortSignal.timeout(2_000) },
      );
      degradedSamplesMs.push(performance.now() - started);
      expect(result.candidates.length).toBeGreaterThan(0);
      expect(result.degradation).toEqual({
        reasonCode: 'embedding_timeout',
        retryable: true,
      });
    }
    degradedSamplesMs.sort((left, right) => left - right);
    const degradedEvidence = {
      documents: DOCUMENT_COUNT,
      samples: degradedSamplesMs.length,
      mode: 'lexical-fallback',
      p50Ms: percentile(degradedSamplesMs, 50),
      p95Ms: percentile(degradedSamplesMs, 95),
      p99Ms: percentile(degradedSamplesMs, 99),
      maxMs: degradedSamplesMs.at(-1) ?? 0,
    };
    process.stderr.write(
      `BOTMEM_HOSTED_SEARCH_DEGRADED_BENCHMARK ${JSON.stringify(degradedEvidence)}\n`,
    );
    expect(degradedEvidence.p95Ms).toBeLessThanOrEqual(500);
  }, 180_000);
});

async function runSearch(search: PostgresHostedSearch, query: string): Promise<readonly string[]> {
  const result = await search.search(
    WORKSPACE_ID,
    parseSearchRequest({ version: 2, query, limit: 20 }),
    { queryId: randomUUID(), signal: AbortSignal.timeout(2_000) },
  );
  return result.candidates.map((candidate) => candidate.sourceId);
}

function percentile(sorted: readonly number[], value: number): number {
  const index = Math.max(0, Math.ceil((value / 100) * sorted.length) - 1);
  return Number((sorted[index] ?? 0).toFixed(3));
}

function semanticNeedleVector(): readonly number[] {
  return Object.freeze([1, ...Array.from({ length: 767 }, () => 0)]);
}

function vectorForQuery(query: string): readonly number[] {
  if (query === 'conceptual recollection') return semanticNeedleVector();
  const item = query === 'مرحبا' ? 99_001 : query === 'ordinary record' ? 99_999 : 100_000;
  return Object.freeze([
    Math.sin(item),
    Math.cos(item),
    Math.sin(item * 0.17),
    Math.cos(item * 0.17),
    Math.sin(item * 0.31),
    Math.cos(item * 0.31),
    Math.sin(item * 0.47),
    Math.cos(item * 0.47),
    ...Array.from({ length: 760 }, () => 0),
  ]);
}

async function seedCorpus(admin: Pool): Promise<void> {
  const existing = await admin.query<{
    readonly documents: string;
    readonly model_revision: string;
    readonly semantic_distance: number | null;
  }>(
    `SELECT (SELECT count(*)::text FROM botmem.hosted_document_revision) AS documents,
            (SELECT model_revision FROM botmem.embedding_profile
              WHERE id = 'hosted-multilingual-v1') AS model_revision,
            (SELECT embedding <=> ('[1,' || repeat('0,', 766) || '0]')::public.vector
               FROM botmem.hosted_document_revision
              WHERE source_event_id = 'message:000002') AS semantic_distance`,
  );
  const snapshot = existing.rows[0];
  if (
    snapshot?.documents === String(DOCUMENT_COUNT) &&
    snapshot.model_revision === MODEL_REVISION &&
    snapshot.semantic_distance === 0
  ) {
    return;
  }
  await admin.query('BEGIN');
  try {
    await admin.query(
      'TRUNCATE botmem.hosted_document_head, botmem.hosted_document_revision, botmem.ingest_event_head, botmem.ingest_event_revision, botmem.connector_account CASCADE',
    );
    await admin.query(
      `UPDATE botmem.embedding_profile
          SET status = 'ready', model_revision = $1, failure_code = NULL,
              updated_at = statement_timestamp()
        WHERE id = 'hosted-multilingual-v1'`,
      [MODEL_REVISION],
    );
    await admin.query(
      `INSERT INTO botmem.connector_account (
         id, tenant_id, connector, auth_kind, provider_subject_hash,
         credential_ref, status, aggregate_version
       ) VALUES ($1::uuid, $2::uuid, 'gmail', 'oauth2', repeat('a', 64),
                 'benchmark://credential', 'ready', 1)`,
      [ACCOUNT_ID, WORKSPACE_ID],
    );
    await admin.query(
      `INSERT INTO botmem.ingest_event_revision (
         id, tenant_id, account_id, source_event_id, source_revision, kind,
         occurred_at, observed_at, content_hash, payload, tombstone
       )
       SELECT md5('revision:' || item)::uuid, $1::uuid, $2::uuid,
              'message:' || lpad(item::text, 6, '0'), '1', 'email',
              timestamptz '2026-01-01T00:00:00Z' + item * interval '1 second',
              timestamptz '2026-01-02T00:00:00Z', repeat('b', 64), '{}'::jsonb, false
         FROM generate_series(1, $3::integer) AS item`,
      [WORKSPACE_ID, ACCOUNT_ID, DOCUMENT_COUNT],
    );
    await admin.query(
      `INSERT INTO botmem.hosted_document_revision (
         revision_id, tenant_id, account_id, connector, source_event_id,
         source_revision, kind, occurred_at, title, body, authored_by_me,
         citation, participants, participant_durable_ids, media, content_hash,
         projection_hash, embedding_profile_id, embedding, projected_at
       )
       SELECT md5('revision:' || item)::uuid, $1::uuid, $2::uuid, 'gmail',
              'message:' || lpad(item::text, 6, '0'), '1', 'email',
              timestamptz '2026-01-01T00:00:00Z' + item * interval '1 second',
              CASE WHEN item % 1000 = 0 THEN 'Launch sentinel' ELSE 'Memory record' END,
              CASE
                WHEN item % 1000 = 0 THEN 'launch sentinel release evidence'
                WHEN item % 1000 = 1 THEN 'مَرْحَبًا بالفريق دليل البحث'
                WHEN item = 2 THEN 'A memory about the launch idea without the requested terms'
                ELSE 'ordinary record from the hosted archive'
              END,
              false, 'botmem://benchmark/' || item, '[]'::jsonb, '{}'::text[],
              '[]'::jsonb, repeat('b', 64), repeat('c', 64),
              'hosted-multilingual-v1',
              CASE WHEN item = 2
                THEN ('[1,' || repeat('0,', 766) || '0]')::public.vector
                ELSE (
                  '[' || array_to_string(
                    ARRAY[
                      sin(item::double precision), cos(item::double precision),
                      sin(item * 0.17), cos(item * 0.17),
                      sin(item * 0.31), cos(item * 0.31),
                      sin(item * 0.47), cos(item * 0.47)
                    ] || array_fill(0.0::double precision, ARRAY[760]),
                    ','
                  ) || ']'
                )::public.vector
              END,
              timestamptz '2026-01-02T00:00:00Z'
         FROM generate_series(1, $3::integer) AS item`,
      [WORKSPACE_ID, ACCOUNT_ID, DOCUMENT_COUNT],
    );
    await admin.query(
      `INSERT INTO botmem.hosted_document_head (
         tenant_id, account_id, source_event_id, revision_id, updated_at
       )
       SELECT $1::uuid, $2::uuid, 'message:' || lpad(item::text, 6, '0'),
              md5('revision:' || item)::uuid, timestamptz '2026-01-02T00:00:00Z'
         FROM generate_series(1, $3::integer) AS item`,
      [WORKSPACE_ID, ACCOUNT_ID, DOCUMENT_COUNT],
    );
    await admin.query('ANALYZE botmem.hosted_document_revision');
    await admin.query('ANALYZE botmem.hosted_document_head');
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK');
    throw error;
  }
}
