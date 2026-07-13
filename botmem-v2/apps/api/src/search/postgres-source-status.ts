import { SourceStatusSchema, type SourceStatus } from '@botmem-v2/contracts';
import { throwIfAborted } from './errors.js';
import type { SqlPoolPort } from './postgres-ports.js';

interface SourceStatusRow {
  readonly connector: 'gmail' | 'outlook' | 'owntracks';
  readonly readiness: 'disconnected' | 'connected' | 'indexing' | 'ready' | 'degraded' | 'error';
  readonly searchable: boolean;
  readonly indexed_count: string | number;
  readonly checkpoint_at: Date | string | null;
  readonly last_probe_at: Date | string | null;
  readonly reason_code: string | null;
}

export interface SourceStatusReaderPort {
  list(workspaceId: string, signal: AbortSignal): Promise<readonly SourceStatus[]>;
}

/** Authenticated tenant read model. It reports one aggregate row per connector. */
export class PostgresHostedSourceStatusReader implements SourceStatusReaderPort {
  constructor(
    private readonly pool: SqlPoolPort,
    private readonly statementTimeoutMs = 250,
  ) {
    if (statementTimeoutMs < 1 || statementTimeoutMs > 30_000) {
      throw new RangeError('statementTimeoutMs must be between 1 and 30000');
    }
  }

  async list(workspaceId: string, signal: AbortSignal): Promise<readonly SourceStatus[]> {
    throwIfAborted(signal);
    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query({ text: 'BEGIN', signal });
      transactionOpen = true;
      await client.query({ text: 'SET LOCAL ROLE botmem_api', signal });
      await client.query({
        text: "SELECT set_config('botmem.tenant_id', $1, true)",
        values: [workspaceId],
        signal,
      });
      await client.query({
        text: "SELECT set_config('statement_timeout', $1, true)",
        values: [`${this.statementTimeoutMs}ms`],
        signal,
      });
      const result = await client.query<SourceStatusRow>({
        text: HOSTED_SOURCE_STATUS_SQL,
        values: [workspaceId],
        signal,
      });
      throwIfAborted(signal);
      await client.query({ text: 'COMMIT', signal });
      transactionOpen = false;
      return Object.freeze(result.rows.map(mapSourceStatus));
    } catch (error) {
      if (transactionOpen) {
        await client.query({ text: 'ROLLBACK' }).catch(() => undefined);
      }
      throw error;
    } finally {
      client.release();
    }
  }
}

function mapSourceStatus(row: SourceStatusRow): SourceStatus {
  return SourceStatusSchema.parse({
    connector: row.connector,
    readiness: row.readiness,
    searchable: row.searchable,
    indexedCount: Number(row.indexed_count),
    ...(row.checkpoint_at ? { checkpointAt: iso(row.checkpoint_at) } : {}),
    ...(row.last_probe_at ? { lastProbeAt: iso(row.last_probe_at) } : {}),
    ...(row.reason_code ? { reasonCode: row.reason_code } : {}),
  });
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export const HOSTED_SOURCE_STATUS_SQL = `
WITH profile AS (
  SELECT status
    FROM botmem.embedding_profile
   WHERE id = 'hosted-multilingual-v1'
),
account_status AS (
  SELECT a.connector,
         a.status AS account_status,
         checkpoint.last_committed_at,
         health.searchable AS probe_searchable,
         health.last_probe_at,
         health.reason_code AS health_reason,
         coalesce(documents.indexed_count, 0) AS indexed_count,
         coalesce(documents.embedding_debt, 0) AS embedding_debt,
         coalesce(debt.projection_debt, 0) AS projection_debt,
         profile.status AS profile_status
    FROM botmem.connector_account a
    CROSS JOIN profile
    LEFT JOIN botmem.connector_checkpoint checkpoint
      ON checkpoint.tenant_id = a.tenant_id
     AND checkpoint.account_id = a.id
    LEFT JOIN botmem.hosted_source_health health
      ON health.tenant_id = a.tenant_id
     AND health.account_id = a.id
    LEFT JOIN LATERAL (
      SELECT count(*) AS indexed_count,
             count(*) FILTER (
               WHERE document.embedding IS NULL OR
                     document.embedding_profile_id IS DISTINCT FROM 'hosted-multilingual-v1'
             ) AS embedding_debt
        FROM botmem.hosted_document_head head
        JOIN botmem.hosted_document_revision document
          ON document.tenant_id = head.tenant_id
         AND document.account_id = head.account_id
         AND document.source_event_id = head.source_event_id
         AND document.revision_id = head.revision_id
       WHERE head.tenant_id = a.tenant_id
         AND head.account_id = a.id
    ) documents ON true
    LEFT JOIN LATERAL (
      SELECT count(*) AS projection_debt
        FROM botmem.ingest_event_head ingest_head
        LEFT JOIN botmem.hosted_document_head document_head
          ON document_head.tenant_id = ingest_head.tenant_id
         AND document_head.account_id = ingest_head.account_id
         AND document_head.source_event_id = ingest_head.source_event_id
         AND document_head.revision_id = ingest_head.head_revision_id
       WHERE ingest_head.tenant_id = a.tenant_id
         AND ingest_head.account_id = a.id
         AND document_head.revision_id IS NULL
    ) debt ON true
   WHERE a.tenant_id = $1::uuid
     AND a.connector IN ('gmail', 'outlook', 'owntracks')
),
aggregate_status AS (
  SELECT connector,
         bool_and(
           account_status = 'ready' AND
           last_committed_at IS NOT NULL AND
           coalesce(probe_searchable, false) AND
           last_probe_at IS NOT NULL AND
           projection_debt = 0 AND
           embedding_debt = 0 AND
           profile_status = 'ready'
         ) AS all_ready,
         bool_or(account_status = 'degraded') AS any_degraded,
         bool_or(account_status IN ('disconnected', 'revoked')) AS any_unavailable,
         bool_and(account_status IN ('disconnected', 'revoked')) AS all_disconnected,
         bool_or(profile_status = 'error') AS profile_error,
         sum(indexed_count) AS indexed_count,
         min(last_committed_at) AS checkpoint_at,
         min(last_probe_at) AS last_probe_at,
         bool_and(coalesce(probe_searchable, false)) AS probe_searchable,
         bool_or(projection_debt > 0) AS has_projection_debt,
         bool_or(embedding_debt > 0) AS has_embedding_debt,
         bool_or(profile_status = 'indexing') AS profile_indexing,
         max(health_reason) FILTER (WHERE health_reason IS NOT NULL) AS health_reason
    FROM account_status
   GROUP BY connector
)
SELECT connector,
       CASE
         WHEN all_disconnected THEN 'disconnected'
         WHEN profile_error THEN 'error'
         WHEN any_degraded OR any_unavailable THEN 'degraded'
         WHEN all_ready THEN 'ready'
         WHEN checkpoint_at IS NULL THEN 'connected'
         ELSE 'indexing'
       END AS readiness,
       all_ready AS searchable,
       indexed_count,
       checkpoint_at,
       last_probe_at,
       CASE
         WHEN profile_error THEN 'embedding_profile_error'
         WHEN any_unavailable THEN 'some_accounts_unavailable'
         WHEN profile_indexing THEN 'embedding_profile_indexing'
         WHEN has_embedding_debt THEN 'embedding_projection_incomplete'
         WHEN has_projection_debt THEN 'projection_debt'
         WHEN NOT probe_searchable THEN coalesce(health_reason, 'search_probe_pending')
         ELSE health_reason
       END AS reason_code
  FROM aggregate_status
 ORDER BY connector
`;
