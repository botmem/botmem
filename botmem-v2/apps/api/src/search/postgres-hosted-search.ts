import {
  SearchCandidateSchema,
  type SearchCandidate,
  type SearchRequest,
} from '@botmem-v2/contracts';
import type {
  HostedSearchPort,
  RankedLaneResult,
  SearchLaneContext,
} from '@botmem-v2/search-domain';
import { HostedSearchFailure, throwIfAborted } from './errors.js';
import type {
  QueryEmbedding,
  QueryEmbeddingPort,
  SqlClientPort,
  SqlPoolPort,
} from './postgres-ports.js';

const PROFILE_ID = 'hosted-multilingual-v1';
const EMBEDDING_DIMENSIONS = 768;
// The fused semantic lane asks for at most 200 rows. The deterministic 100k
// recall gate stops finding its semantic needle below 475, so 500 retains a
// measured safety margin while avoiding the latency cost of the previous 600.
// Filtered searches can continue through pgvector's iterative scan.
const DEFAULT_HNSW_EF_SEARCH = 500;

interface EmbeddingProfileRow {
  readonly status: 'indexing' | 'ready' | 'error';
  readonly dimensions: number;
  readonly model_revision: string;
}

interface SearchRow {
  readonly revision_id: string;
  readonly account_id: string;
  readonly connector: 'gmail' | 'outlook' | 'owntracks';
  readonly source_event_id: string;
  readonly source_revision: string;
  readonly kind: 'email' | 'location';
  readonly occurred_at: Date | string | null;
  readonly title: string | null;
  readonly body: string;
  readonly thread_durable_id: string | null;
  readonly thread_title: string | null;
  readonly authored_by_me: boolean | null;
  readonly citation: string;
  readonly participants: unknown;
  readonly media: unknown;
}

export interface PostgresHostedSearchOptions {
  /** Must remain lower than the outer hosted-lane deadline. */
  readonly statementTimeoutMs?: number;
  readonly laneOversampling?: number;
  /** ANN candidate breadth. The effective value is never below the lane limit. */
  readonly hnswEfSearch?: number;
}

/** PostgreSQL driven adapter for the framework-free HostedSearchPort. */
export class PostgresHostedSearch implements HostedSearchPort {
  private readonly statementTimeoutMs: number;
  private readonly laneOversampling: number;
  private readonly hnswEfSearch: number;

  constructor(
    private readonly pool: SqlPoolPort,
    private readonly embeddings: QueryEmbeddingPort,
    options: PostgresHostedSearchOptions = {},
  ) {
    this.statementTimeoutMs = options.statementTimeoutMs ?? 450;
    this.laneOversampling = options.laneOversampling ?? 4;
    this.hnswEfSearch = options.hnswEfSearch ?? DEFAULT_HNSW_EF_SEARCH;
    if (this.statementTimeoutMs < 1 || this.statementTimeoutMs > 30_000) {
      throw new RangeError('statementTimeoutMs must be between 1 and 30000');
    }
    if (this.laneOversampling < 1 || this.laneOversampling > 10) {
      throw new RangeError('laneOversampling must be between 1 and 10');
    }
    if (
      !Number.isInteger(this.hnswEfSearch) ||
      this.hnswEfSearch < 40 ||
      this.hnswEfSearch > 1_000
    ) {
      throw new RangeError('hnswEfSearch must be an integer between 40 and 1000');
    }
  }

  async search(
    workspaceId: string,
    request: SearchRequest,
    context: SearchLaneContext,
  ): Promise<RankedLaneResult> {
    throwIfAborted(context.signal);
    let embedding: QueryEmbedding | undefined;
    let degradationReason: string | undefined;
    let degradationRetryable = true;
    try {
      embedding = await this.embeddings.embed(request.query, context.signal);
      this.validateEmbedding(embedding);
    } catch (error) {
      throwIfAborted(context.signal);
      degradationReason = embeddingFailureReason(error);
      degradationRetryable = embeddingFailureRetryable(error);
    }
    const laneLimit = Math.min(200, request.limit * this.laneOversampling);

    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query({ text: 'BEGIN', signal: context.signal });
      transactionOpen = true;
      await client.query({ text: 'SET LOCAL ROLE botmem_api', signal: context.signal });
      await client.query({
        text: "SELECT set_config('botmem.tenant_id', $1, true)",
        values: [workspaceId],
        signal: context.signal,
      });
      await client.query({
        text: "SELECT set_config('statement_timeout', $1, true)",
        values: [`${this.statementTimeoutMs}ms`],
        signal: context.signal,
      });
      await client.query({
        text: "SELECT set_config('pg_trgm.word_similarity_threshold', '0.3', true)",
        signal: context.signal,
      });
      if (embedding) {
        try {
          await this.assertProfileReady(client, embedding, context.signal);
        } catch (error) {
          if (!isRecoverableProfileFailure(error)) throw error;
          degradationReason = error.code;
          degradationRetryable = true;
          embedding = undefined;
        }
      }
      if (embedding) {
        // pgvector defaults to a shallow approximate search and applies filters
        // after scanning the graph. Iterative strict-order scans preserve exact
        // distance ordering while continuing until enough tenant/filter matches
        // are found. Both settings are transaction-local.
        await client.query({
          text: "SELECT set_config('hnsw.ef_search', $1, true), set_config('hnsw.iterative_scan', 'strict_order', true)",
          values: [String(Math.max(this.hnswEfSearch, laneLimit))],
          signal: context.signal,
        });
      }
      throwIfAborted(context.signal);

      const result = await client.query<SearchRow>({
        text: embedding ? HOSTED_SEARCH_SQL : HOSTED_LEXICAL_SEARCH_SQL,
        values: embedding
          ? semanticSearchValues(workspaceId, request, embedding, laneLimit)
          : lexicalSearchValues(workspaceId, request, laneLimit),
        signal: context.signal,
      });
      throwIfAborted(context.signal);
      await client.query({ text: 'COMMIT', signal: context.signal });
      transactionOpen = false;
      return Object.freeze({
        candidates: Object.freeze(result.rows.map((row) => mapCandidate(row))),
        ...(degradationReason
          ? {
              degradation: Object.freeze({
                reasonCode: degradationReason,
                retryable: degradationRetryable,
              }),
            }
          : {}),
      });
    } catch (error) {
      if (transactionOpen) {
        await client.query({ text: 'ROLLBACK' }).catch(() => undefined);
      }
      if (context.signal.aborted) throw new HostedSearchFailure('search_aborted');
      throw error;
    } finally {
      client.release();
    }
  }

  private validateEmbedding(embedding: QueryEmbedding): void {
    if (
      embedding.profileId !== PROFILE_ID ||
      !embedding.modelRevision.trim() ||
      embedding.values.length !== EMBEDDING_DIMENSIONS ||
      embedding.values.some((value) => !Number.isFinite(value))
    ) {
      throw new HostedSearchFailure('embedding_invalid');
    }
  }

  private async assertProfileReady(
    client: SqlClientPort,
    embedding: QueryEmbedding,
    signal: AbortSignal,
  ): Promise<void> {
    const result = await client.query<EmbeddingProfileRow>({
      text: `SELECT status, dimensions, model_revision
               FROM botmem.embedding_profile
              WHERE id = $1`,
      values: [embedding.profileId],
      signal,
    });
    const profile = result.rows[0];
    if (!profile || profile.dimensions !== embedding.values.length) {
      throw new HostedSearchFailure('embedding_profile_mismatch');
    }
    if (profile.status === 'indexing') {
      throw new HostedSearchFailure('embedding_profile_indexing');
    }
    if (profile.status === 'error') {
      throw new HostedSearchFailure('embedding_profile_error');
    }
    if (profile.model_revision !== embedding.modelRevision) {
      throw new HostedSearchFailure('embedding_profile_mismatch');
    }
  }
}

function vectorLiteral(values: readonly number[]): string {
  return `[${values.join(',')}]`;
}

function embeddingFailureReason(error: unknown): string {
  if (error instanceof HostedSearchFailure) return error.code;
  const code = errorCode(error);
  return code && /^embedding_[a-z0-9_]+$/u.test(code) ? code : 'semantic_embedding_unavailable';
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function embeddingFailureRetryable(error: unknown): boolean {
  const status = errorStatus(error);
  if (status !== undefined && status >= 400 && status < 500 && status !== 429) {
    return false;
  }
  return true;
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('status' in error)) return undefined;
  const status = (error as { readonly status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

function isRecoverableProfileFailure(error: unknown): error is HostedSearchFailure {
  return error instanceof HostedSearchFailure && error.code.startsWith('embedding_');
}

function semanticSearchValues(
  workspaceId: string,
  request: SearchRequest,
  embedding: QueryEmbedding,
  laneLimit: number,
): readonly unknown[] {
  return [
    workspaceId,
    request.query,
    vectorLiteral(embedding.values),
    embedding.profileId,
    request.connectors ?? null,
    request.kinds ?? null,
    request.from ?? null,
    request.to ?? null,
    request.participantId ?? null,
    request.authoredByMe ?? null,
    request.accountIds ?? null,
    laneLimit,
    request.limit,
  ];
}

function lexicalSearchValues(
  workspaceId: string,
  request: SearchRequest,
  laneLimit: number,
): readonly unknown[] {
  return [
    workspaceId,
    request.query,
    request.connectors ?? null,
    request.kinds ?? null,
    request.from ?? null,
    request.to ?? null,
    request.participantId ?? null,
    request.authoredByMe ?? null,
    request.accountIds ?? null,
    laneLimit,
    request.limit,
  ];
}

function mapCandidate(row: SearchRow): SearchCandidate {
  const occurredAt =
    row.occurred_at instanceof Date ? row.occurred_at.toISOString() : row.occurred_at;
  return SearchCandidateSchema.parse({
    ref: `hosted:${row.revision_id}`,
    sourceId: row.source_event_id,
    revision: row.source_revision,
    origin: {
      placement: 'hosted',
      connector: row.connector,
      accountId: row.account_id,
    },
    kind: row.kind,
    occurredAt,
    ...(row.title ? { title: row.title } : {}),
    text: row.body,
    ...(row.thread_durable_id
      ? {
          thread: {
            durableId: row.thread_durable_id,
            ...(row.thread_title ? { title: row.thread_title } : {}),
          },
        }
      : {}),
    participants: row.participants,
    media: row.media,
    ...(row.authored_by_me === null ? {} : { authoredByMe: row.authored_by_me }),
    citation: row.citation,
  });
}

export const HOSTED_SEARCH_SQL = `
WITH eligible AS NOT MATERIALIZED (
  SELECT d.revision_id, d.tenant_id, d.account_id, d.connector,
         d.source_event_id, d.source_revision, d.kind, d.occurred_at,
         d.title, d.body, d.thread_durable_id, d.thread_title,
         d.authored_by_me, d.citation, d.participants,
         d.participant_durable_ids, d.media, d.embedding_profile_id,
         d.embedding, d.search_text, d.search_vector
    FROM botmem.hosted_document_revision d
    JOIN botmem.hosted_document_head h
      ON h.tenant_id = d.tenant_id
     AND h.account_id = d.account_id
     AND h.source_event_id = d.source_event_id
     AND h.revision_id = d.revision_id
   WHERE d.tenant_id = $1::uuid
     AND ($5::text[] IS NULL OR d.connector = ANY($5::text[]))
     AND ($6::text[] IS NULL OR d.kind = ANY($6::text[]))
     AND ($7::timestamptz IS NULL OR d.occurred_at >= $7::timestamptz)
     AND ($8::timestamptz IS NULL OR d.occurred_at <= $8::timestamptz)
     AND ($9::text IS NULL OR $9::text = ANY(d.participant_durable_ids))
     AND ($10::boolean IS NULL OR d.authored_by_me = $10::boolean)
     AND ($11::uuid[] IS NULL OR d.account_id = ANY($11::uuid[]))
),
lexical AS (
  SELECT d.revision_id,
         row_number() OVER (
           ORDER BY ts_rank_cd(
                      d.search_vector,
                      websearch_to_tsquery('simple', botmem.normalize_search_text($2::text)),
                      32
                    ) DESC,
                    d.occurred_at DESC NULLS LAST,
                    d.revision_id
         ) AS lane_rank
    FROM eligible d
   WHERE d.search_vector @@
         websearch_to_tsquery('simple', botmem.normalize_search_text($2::text))
   ORDER BY ts_rank_cd(
              d.search_vector,
              websearch_to_tsquery('simple', botmem.normalize_search_text($2::text)),
              32
            ) DESC,
            d.occurred_at DESC NULLS LAST,
            d.revision_id
   LIMIT $12::integer
),
trigram AS (
  SELECT d.revision_id,
         row_number() OVER (
           ORDER BY word_similarity(
                      botmem.normalize_search_text($2::text),
                      d.search_text
                    ) DESC,
                    d.occurred_at DESC NULLS LAST,
                    d.revision_id
         ) AS lane_rank
    FROM eligible d
   -- Typo recovery is a fill lane, not a second exact-search pass. When the
   -- indexed full-text lane already filled its bounded candidate budget,
   -- scoring every weak trigram match only duplicates those candidates and
   -- makes common queries scale with corpus size. PostgreSQL evaluates this
   -- as a one-time guard, so the trigram scan is skipped in that case.
   WHERE (SELECT count(*) FROM lexical) < $12::integer
     AND (
       botmem.normalize_search_text($2::text) <% d.search_text
       OR d.search_text LIKE
          ('%' || replace(replace(replace(botmem.normalize_search_text($2::text), E'\\\\', E'\\\\\\\\'), '%', E'\\\\%'), '_', E'\\\\_') || '%')
          ESCAPE E'\\\\'
     )
   ORDER BY word_similarity(botmem.normalize_search_text($2::text), d.search_text) DESC,
            d.occurred_at DESC NULLS LAST,
            d.revision_id
   LIMIT $12::integer
),
-- Materialize a bounded ANN shortlist before validating active heads. pgvector
-- applies joins after approximate graph traversal; putting the head join inside
-- the ANN scan can change graph recall and hide an exact nearest neighbour.
-- The 10x shortlist tolerates bounded revision history without scanning the
-- corpus or persisting any query state.
semantic_ann AS MATERIALIZED (
  SELECT d.revision_id,
         d.embedding <=> $3::public.vector(768) AS semantic_distance
    FROM botmem.hosted_document_revision d
   WHERE d.tenant_id = $1::uuid
     AND ($5::text[] IS NULL OR d.connector = ANY($5::text[]))
     AND ($6::text[] IS NULL OR d.kind = ANY($6::text[]))
     AND ($7::timestamptz IS NULL OR d.occurred_at >= $7::timestamptz)
     AND ($8::timestamptz IS NULL OR d.occurred_at <= $8::timestamptz)
     AND ($9::text IS NULL OR $9::text = ANY(d.participant_durable_ids))
     AND ($10::boolean IS NULL OR d.authored_by_me = $10::boolean)
     AND ($11::uuid[] IS NULL OR d.account_id = ANY($11::uuid[]))
     AND d.embedding_profile_id = 'hosted-multilingual-v1'
     AND $4::text = 'hosted-multilingual-v1'
     AND d.embedding IS NOT NULL
   ORDER BY d.embedding <=> $3::public.vector(768),
            d.occurred_at DESC NULLS LAST,
            d.revision_id
   LIMIT LEAST(1000, $12::integer * 10)
),
semantic AS (
  SELECT ann.revision_id,
         row_number() OVER (
           ORDER BY ann.semantic_distance,
                    d.occurred_at DESC NULLS LAST,
                    d.revision_id
         ) AS lane_rank
    FROM semantic_ann ann
    JOIN eligible d ON d.revision_id = ann.revision_id
   ORDER BY ann.semantic_distance,
            d.occurred_at DESC NULLS LAST,
            d.revision_id
   LIMIT $12::integer
),
ranked AS (
  SELECT revision_id, lane_rank, 1.0::double precision AS lane_weight FROM lexical
  UNION ALL
  -- Trigram is a typo-recovery lane and is intentionally weaker than exact
  -- lexical or semantic evidence. Otherwise a common weakly-similar phrase can
  -- displace a semantic nearest neighbour solely on recency.
  SELECT revision_id, lane_rank, 0.65::double precision AS lane_weight FROM trigram
  UNION ALL
  SELECT revision_id, lane_rank, 1.0::double precision AS lane_weight FROM semantic
),
fused AS (
  SELECT revision_id, sum(lane_weight / (60.0 + lane_rank)) AS fused_score
    FROM ranked
   GROUP BY revision_id
)
SELECT d.revision_id, d.account_id, d.connector, d.source_event_id,
       d.source_revision, d.kind, d.occurred_at, d.title, d.body,
       d.thread_durable_id, d.thread_title, d.authored_by_me, d.citation,
       d.participants, d.media
  FROM fused f
  JOIN eligible d ON d.revision_id = f.revision_id
 ORDER BY f.fused_score DESC,
          d.occurred_at DESC NULLS LAST,
          d.revision_id
 LIMIT $13::integer
`;

/**
 * Provider-independent recovery path. It intentionally excludes pgvector and
 * embedding-profile reads so an embedding outage cannot suppress exact,
 * phrase, Arabic-normalized, or typo-recovery matches already in PostgreSQL.
 */
export const HOSTED_LEXICAL_SEARCH_SQL = `
WITH eligible AS NOT MATERIALIZED (
  SELECT d.revision_id, d.tenant_id, d.account_id, d.connector,
         d.source_event_id, d.source_revision, d.kind, d.occurred_at,
         d.title, d.body, d.thread_durable_id, d.thread_title,
         d.authored_by_me, d.citation, d.participants,
         d.participant_durable_ids, d.media, d.search_text, d.search_vector
    FROM botmem.hosted_document_revision d
    JOIN botmem.hosted_document_head h
      ON h.tenant_id = d.tenant_id
     AND h.account_id = d.account_id
     AND h.source_event_id = d.source_event_id
     AND h.revision_id = d.revision_id
   WHERE d.tenant_id = $1::uuid
     AND ($3::text[] IS NULL OR d.connector = ANY($3::text[]))
     AND ($4::text[] IS NULL OR d.kind = ANY($4::text[]))
     AND ($5::timestamptz IS NULL OR d.occurred_at >= $5::timestamptz)
     AND ($6::timestamptz IS NULL OR d.occurred_at <= $6::timestamptz)
     AND ($7::text IS NULL OR $7::text = ANY(d.participant_durable_ids))
     AND ($8::boolean IS NULL OR d.authored_by_me = $8::boolean)
     AND ($9::uuid[] IS NULL OR d.account_id = ANY($9::uuid[]))
),
lexical AS (
  SELECT d.revision_id,
         row_number() OVER (
           ORDER BY ts_rank_cd(
                      d.search_vector,
                      websearch_to_tsquery('simple', botmem.normalize_search_text($2::text)),
                      32
                    ) DESC,
                    d.occurred_at DESC NULLS LAST,
                    d.revision_id
         ) AS lane_rank
    FROM eligible d
   WHERE d.search_vector @@
         websearch_to_tsquery('simple', botmem.normalize_search_text($2::text))
   ORDER BY ts_rank_cd(
              d.search_vector,
              websearch_to_tsquery('simple', botmem.normalize_search_text($2::text)),
              32
            ) DESC,
            d.occurred_at DESC NULLS LAST,
            d.revision_id
   LIMIT $10::integer
),
trigram AS (
  SELECT d.revision_id,
         row_number() OVER (
           ORDER BY word_similarity(
                      botmem.normalize_search_text($2::text),
                      d.search_text
                    ) DESC,
                    d.occurred_at DESC NULLS LAST,
                    d.revision_id
         ) AS lane_rank
    FROM eligible d
   WHERE (SELECT count(*) FROM lexical) < $10::integer
     AND (
       botmem.normalize_search_text($2::text) <% d.search_text
       OR d.search_text LIKE
          ('%' || replace(replace(replace(botmem.normalize_search_text($2::text), E'\\\\', E'\\\\\\\\'), '%', E'\\\\%'), '_', E'\\\\_') || '%')
          ESCAPE E'\\\\'
     )
   ORDER BY word_similarity(botmem.normalize_search_text($2::text), d.search_text) DESC,
            d.occurred_at DESC NULLS LAST,
            d.revision_id
   LIMIT $10::integer
),
ranked AS (
  SELECT revision_id, lane_rank, 1.0::double precision AS lane_weight FROM lexical
  UNION ALL
  SELECT revision_id, lane_rank, 0.65::double precision AS lane_weight FROM trigram
),
fused AS (
  SELECT revision_id, sum(lane_weight / (60.0 + lane_rank)) AS fused_score
    FROM ranked
   GROUP BY revision_id
)
SELECT d.revision_id, d.account_id, d.connector, d.source_event_id,
       d.source_revision, d.kind, d.occurred_at, d.title, d.body,
       d.thread_durable_id, d.thread_title, d.authored_by_me, d.citation,
       d.participants, d.media
  FROM fused f
  JOIN eligible d ON d.revision_id = f.revision_id
 ORDER BY f.fused_score DESC,
          d.occurred_at DESC NULLS LAST,
          d.revision_id
 LIMIT $11::integer
`;
