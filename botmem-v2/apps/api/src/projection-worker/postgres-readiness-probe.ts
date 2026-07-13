import type { SqlPoolPort } from '../search/postgres-ports.js';
import type { SearchReadinessProbePort } from './ports.js';

interface DebtRow {
  readonly projection_debt: string | number;
  readonly embedding_debt: string | number;
  readonly profile_ready: boolean;
}

/** Executes lexical + vector operators only after projection and embedding debt is zero. */
export class PostgresSearchReadinessProbe implements SearchReadinessProbePort {
  constructor(
    private readonly pool: SqlPoolPort,
    private readonly statementTimeoutMs = 1_000,
  ) {
    if (statementTimeoutMs < 100 || statementTimeoutMs > 30_000) {
      throw new RangeError('probe statement timeout must be between 100 and 30000ms');
    }
  }

  async probe(input: {
    readonly workspaceId: string;
    readonly accountId: string;
    readonly signal: AbortSignal;
  }): Promise<'ready' | 'deferred'> {
    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query({ text: 'BEGIN', signal: input.signal });
      transactionOpen = true;
      await client.query({ text: 'SET LOCAL ROLE botmem_worker', signal: input.signal });
      await client.query({
        text: "SELECT set_config('botmem.tenant_id', $1, true)",
        values: [input.workspaceId],
        signal: input.signal,
      });
      await client.query({
        text: "SELECT set_config('statement_timeout', $1, true)",
        values: [`${this.statementTimeoutMs}ms`],
        signal: input.signal,
      });
      const debt = (
        await client.query<DebtRow>({
          text: DEBT_SQL,
          values: [input.workspaceId, input.accountId],
          signal: input.signal,
        })
      ).rows[0];
      if (
        !debt ||
        Number(debt.projection_debt) !== 0 ||
        Number(debt.embedding_debt) !== 0 ||
        !debt.profile_ready
      ) {
        await client.query({ text: 'COMMIT', signal: input.signal });
        transactionOpen = false;
        return 'deferred';
      }
      const probe = await client.query<{ ok: boolean }>({
        text: SEARCH_PROBE_SQL,
        values: [input.workspaceId, input.accountId],
        signal: input.signal,
      });
      if (probe.rows[0]?.ok !== true) throw new SearchReadinessProbeError();
      await client.query({ text: 'COMMIT', signal: input.signal });
      transactionOpen = false;
      return 'ready';
    } catch (error) {
      if (transactionOpen) await client.query({ text: 'ROLLBACK' }).catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

const DEBT_SQL = `
SELECT
  (
    SELECT count(*)
      FROM botmem.ingest_event_head ingest_head
      LEFT JOIN botmem.projection_state state
        ON state.tenant_id = ingest_head.tenant_id
       AND state.account_id = ingest_head.account_id
       AND state.revision_id = ingest_head.head_revision_id
       AND state.projection_name = 'hosted_search_v1'
     WHERE ingest_head.tenant_id = $1::uuid
       AND ingest_head.account_id = $2::uuid
       AND state.state IS DISTINCT FROM 'applied'
  ) AS projection_debt,
  (
    SELECT count(*)
      FROM botmem.hosted_document_head head
      JOIN botmem.hosted_document_revision document
        ON document.tenant_id = head.tenant_id
       AND document.account_id = head.account_id
       AND document.source_event_id = head.source_event_id
       AND document.revision_id = head.revision_id
     WHERE head.tenant_id = $1::uuid
       AND head.account_id = $2::uuid
       AND (
         document.embedding IS NULL OR
         document.embedding_profile_id IS DISTINCT FROM 'hosted-multilingual-v1'
       )
  ) AS embedding_debt,
  EXISTS (
    SELECT 1 FROM botmem.embedding_profile
     WHERE id = 'hosted-multilingual-v1' AND status = 'ready'
  ) AS profile_ready
`;

const SEARCH_PROBE_SQL = `
WITH sample AS MATERIALIZED (
  SELECT document.revision_id, document.embedding, document.search_vector,
         left(btrim(coalesce(document.title, '') || ' ' || document.body), 512) AS probe_text
    FROM botmem.hosted_document_head head
    JOIN botmem.hosted_document_revision document
      ON document.tenant_id = head.tenant_id
     AND document.account_id = head.account_id
     AND document.source_event_id = head.source_event_id
     AND document.revision_id = head.revision_id
   WHERE head.tenant_id = $1::uuid AND head.account_id = $2::uuid
   ORDER BY document.projected_at DESC, document.revision_id
   LIMIT 1
), lexical_probe AS (
  SELECT EXISTS (
    SELECT 1
      FROM sample
      JOIN botmem.hosted_document_revision document
        ON document.revision_id = sample.revision_id
     WHERE sample.search_vector = ''::tsvector OR
           document.search_vector @@ plainto_tsquery(
             'simple', botmem.normalize_search_text(sample.probe_text)
           )
  ) AS ok
), semantic_probe AS (
  SELECT coalesce(min(document.embedding <=> sample.embedding) <= 0.00000001, false) AS ok
    FROM sample
    JOIN botmem.hosted_document_revision document
      ON document.tenant_id = $1::uuid
     AND document.account_id = $2::uuid
     AND document.embedding_profile_id = 'hosted-multilingual-v1'
)
SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM sample) THEN true
            ELSE coalesce((SELECT ok FROM lexical_probe), false) AND
                 coalesce((SELECT ok FROM semantic_probe), false)
       END AS ok
`;

export class SearchReadinessProbeError extends Error {}
