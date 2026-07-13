import { SearchCandidateSchema, type SearchCandidate } from '@botmem-v2/contracts';
import { randomUUID } from 'node:crypto';
import { HostedSearchFailure, throwIfAborted } from './errors.js';
import type { SqlClientPort, SqlPoolPort } from './postgres-ports.js';

const PROJECTION_NAME = 'hosted_search_v1';
const PROFILE_ID = 'hosted-multilingual-v1';
const DIMENSIONS = 768;

interface IngestRow {
  readonly account_id: string;
  readonly connector: 'gmail' | 'outlook' | 'owntracks';
  readonly source_event_id: string;
  readonly source_revision: string;
  readonly kind: 'email' | 'location';
  readonly occurred_at: Date | string | null;
  readonly content_hash: string;
  readonly tombstone: boolean;
}

interface ProjectionStateRow {
  readonly state: 'processing' | 'applied';
  readonly output_hash: string | null;
}

export interface HostedProjectionCommand {
  readonly workspaceId: string;
  readonly accountId: string;
  readonly revisionId: string;
  readonly workerId: string;
  readonly leaseExpiresAt: string;
  readonly projectedAt: string;
  readonly outputHash: string;
  readonly candidate: SearchCandidate | null;
  readonly embedding: {
    readonly profileId: 'hosted-multilingual-v1';
    readonly modelRevision: string;
    readonly values: readonly number[];
  } | null;
  readonly signal: AbortSignal;
}

export interface RepairableProjection {
  readonly accountId: string;
  readonly revisionId: string;
}

/**
 * Transactional projection adapter. Document revision, active head, projection
 * checkpoint, and readiness invalidation commit or roll back together.
 */
export class PostgresHostedProjectionStore {
  constructor(
    private readonly pool: SqlPoolPort,
    private readonly statementTimeoutMs = 5_000,
  ) {
    if (statementTimeoutMs < 1 || statementTimeoutMs > 30_000) {
      throw new RangeError('statementTimeoutMs must be between 1 and 30000');
    }
  }

  async project(command: HostedProjectionCommand): Promise<'applied' | 'already_applied'> {
    validateDigest(command.outputHash);
    if (command.embedding) validateEmbedding(command.embedding);
    throwIfAborted(command.signal);

    const client = await this.begin(command.workspaceId, command.signal);
    let transactionOpen = true;
    try {
      const leaseToken = randomUUID();
      const ingest = await this.loadIngest(client, command);
      this.validateCandidate(ingest, command);
      const claim = await client.query<ProjectionStateRow>({
        text: CLAIM_PROJECTION_SQL,
        values: [
          command.workspaceId,
          command.accountId,
          command.revisionId,
          PROJECTION_NAME,
          command.workerId,
          leaseToken,
          command.leaseExpiresAt,
        ],
        signal: command.signal,
      });
      const claimed = claim.rows[0];
      if (!claimed) {
        const existing = await client.query<ProjectionStateRow>({
          text: `SELECT state, output_hash
                   FROM botmem.projection_state
                  WHERE projection_name = $1 AND revision_id = $2::uuid`,
          values: [PROJECTION_NAME, command.revisionId],
          signal: command.signal,
        });
        const state = existing.rows[0];
        if (state?.state === 'applied' && state.output_hash === command.outputHash) {
          await client.query({ text: 'COMMIT', signal: command.signal });
          transactionOpen = false;
          return 'already_applied';
        }
        if (state?.state === 'applied') {
          throw new HostedSearchFailure('projection_idempotency_conflict');
        }
        throw new HostedSearchFailure('projection_lease_conflict');
      }

      if (ingest.tombstone) {
        await client.query({
          text: DELETE_ACTIVE_HEAD_SQL,
          values: [
            command.workspaceId,
            command.accountId,
            ingest.source_event_id,
            command.revisionId,
          ],
          signal: command.signal,
        });
      } else {
        if (!command.embedding) throw new HostedSearchFailure('embedding_invalid');
        await this.ensureEmbeddingProfile(
          client,
          command.embedding,
          command.projectedAt,
          command.signal,
        );
        await this.insertDocument(client, command, ingest);
        await client.query({
          text: UPSERT_ACTIVE_HEAD_SQL,
          values: [
            command.workspaceId,
            command.accountId,
            ingest.source_event_id,
            command.revisionId,
            command.projectedAt,
          ],
          signal: command.signal,
        });
      }

      const applied = await client.query({
        text: `UPDATE botmem.projection_state
                  SET state = 'applied', lease_owner = NULL, lease_token = NULL,
                      lease_expires_at = NULL,
                      output_hash = $1, last_error_code = NULL,
                      applied_at = $2::timestamptz, updated_at = $2::timestamptz
                WHERE projection_name = $3 AND revision_id = $4::uuid
                  AND state = 'processing' AND lease_owner = $5
                  AND lease_token = $6::uuid
                  AND lease_expires_at > clock_timestamp()`,
        values: [
          command.outputHash,
          command.projectedAt,
          PROJECTION_NAME,
          command.revisionId,
          command.workerId,
          leaseToken,
        ],
        signal: command.signal,
      });
      if (applied.rowCount !== 1) {
        throw new HostedSearchFailure('projection_lease_conflict');
      }

      await client.query({
        text: `INSERT INTO botmem.hosted_source_health (
                 tenant_id, account_id, searchable, last_probe_at, reason_code, updated_at
               ) VALUES ($1::uuid, $2::uuid, false, NULL, 'projection_changed', $3::timestamptz)
               ON CONFLICT (account_id) DO UPDATE
                 SET searchable = false, reason_code = 'projection_changed',
                     updated_at = EXCLUDED.updated_at`,
        values: [command.workspaceId, command.accountId, command.projectedAt],
        signal: command.signal,
      });

      throwIfAborted(command.signal);
      await client.query({ text: 'COMMIT', signal: command.signal });
      transactionOpen = false;
      return 'applied';
    } catch (error) {
      if (transactionOpen) await client.query({ text: 'ROLLBACK' }).catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async markSearchProbeReady(input: {
    readonly workspaceId: string;
    readonly accountId: string;
    readonly probedAt: string;
    readonly signal: AbortSignal;
  }): Promise<void> {
    const client = await this.begin(input.workspaceId, input.signal);
    let transactionOpen = true;
    try {
      const result = await client.query({
        text: MARK_PROBE_READY_SQL,
        values: [input.workspaceId, input.accountId, input.probedAt, PROJECTION_NAME],
        signal: input.signal,
      });
      if (result.rowCount !== 1) {
        throw new HostedSearchFailure('search_probe_rejected');
      }
      await client.query({ text: 'COMMIT', signal: input.signal });
      transactionOpen = false;
    } catch (error) {
      if (transactionOpen) await client.query({ text: 'ROLLBACK' }).catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listRepairable(input: {
    readonly workspaceId: string;
    readonly limit: number;
    readonly signal: AbortSignal;
  }): Promise<readonly RepairableProjection[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500) {
      throw new RangeError('repair limit must be between 1 and 500');
    }
    const client = await this.begin(input.workspaceId, input.signal);
    let transactionOpen = true;
    try {
      const result = await client.query<{ account_id: string; revision_id: string }>({
        text: LIST_REPAIRABLE_SQL,
        values: [input.workspaceId, PROJECTION_NAME, input.limit],
        signal: input.signal,
      });
      await client.query({ text: 'COMMIT', signal: input.signal });
      transactionOpen = false;
      return Object.freeze(
        result.rows.map((row) => ({ accountId: row.account_id, revisionId: row.revision_id })),
      );
    } catch (error) {
      if (transactionOpen) await client.query({ text: 'ROLLBACK' }).catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async begin(workspaceId: string, signal: AbortSignal): Promise<SqlClientPort> {
    throwIfAborted(signal);
    const client = await this.pool.connect();
    try {
      await client.query({ text: 'BEGIN', signal });
      await client.query({ text: 'SET LOCAL ROLE botmem_worker', signal });
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
      return client;
    } catch (error) {
      await client.query({ text: 'ROLLBACK' }).catch(() => undefined);
      client.release();
      throw error;
    }
  }

  private async loadIngest(
    client: SqlClientPort,
    command: HostedProjectionCommand,
  ): Promise<IngestRow> {
    const result = await client.query<IngestRow>({
      text: `SELECT revision.account_id, account.connector,
                    revision.source_event_id, revision.source_revision,
                    revision.kind, revision.occurred_at,
                    revision.content_hash, revision.tombstone
               FROM botmem.ingest_event_revision revision
               JOIN botmem.connector_account account
                 ON account.tenant_id = revision.tenant_id
                AND account.id = revision.account_id
              WHERE revision.tenant_id = $1::uuid
                AND revision.account_id = $2::uuid
                AND revision.id = $3::uuid`,
      values: [command.workspaceId, command.accountId, command.revisionId],
      signal: command.signal,
    });
    const ingest = result.rows[0];
    if (!ingest) throw new HostedSearchFailure('projection_input_mismatch');
    return ingest;
  }

  private validateCandidate(ingest: IngestRow, command: HostedProjectionCommand): void {
    if (ingest.tombstone) {
      if (command.candidate !== null || command.embedding !== null) {
        throw new HostedSearchFailure('projection_input_mismatch');
      }
      return;
    }
    if (!command.candidate) throw new HostedSearchFailure('projection_input_mismatch');
    const candidate = SearchCandidateSchema.parse(command.candidate);
    if (
      candidate.origin.placement !== 'hosted' ||
      candidate.origin.accountId !== command.accountId ||
      candidate.origin.connector !== ingest.connector ||
      candidate.sourceId !== ingest.source_event_id ||
      candidate.revision !== ingest.source_revision ||
      candidate.kind !== ingest.kind
    ) {
      throw new HostedSearchFailure('projection_input_mismatch');
    }
  }

  private async insertDocument(
    client: SqlClientPort,
    command: HostedProjectionCommand,
    ingest: IngestRow,
  ): Promise<void> {
    const candidate = SearchCandidateSchema.parse(command.candidate);
    const durableParticipantIds = [
      ...new Set(candidate.participants.map((participant) => participant.durableId)),
    ].sort();
    const embedding = command.embedding ? vectorLiteral(command.embedding.values) : null;
    const inserted = await client.query<{ content_hash: string; projection_hash: string }>({
      text: INSERT_DOCUMENT_SQL,
      values: [
        command.revisionId,
        command.workspaceId,
        command.accountId,
        ingest.connector,
        ingest.source_event_id,
        ingest.source_revision,
        ingest.kind,
        ingest.occurred_at,
        candidate.title ?? null,
        candidate.text,
        candidate.thread?.durableId ?? null,
        candidate.thread?.title ?? null,
        candidate.authoredByMe ?? null,
        candidate.citation,
        JSON.stringify(candidate.participants),
        durableParticipantIds,
        JSON.stringify(candidate.media),
        ingest.content_hash,
        command.outputHash,
        command.embedding?.profileId ?? null,
        embedding,
        command.projectedAt,
      ],
      signal: command.signal,
    });
    const stored =
      inserted.rows[0] ??
      (
        await client.query<{ content_hash: string; projection_hash: string }>({
          text: `SELECT content_hash, projection_hash
                   FROM botmem.hosted_document_revision
                  WHERE revision_id = $1::uuid`,
          values: [command.revisionId],
          signal: command.signal,
        })
      ).rows[0];
    if (
      !stored ||
      stored.content_hash !== ingest.content_hash ||
      stored.projection_hash !== command.outputHash
    ) {
      throw new HostedSearchFailure('projection_idempotency_conflict');
    }
  }

  private async ensureEmbeddingProfile(
    client: SqlClientPort,
    embedding: NonNullable<HostedProjectionCommand['embedding']>,
    now: string,
    signal: AbortSignal,
  ): Promise<void> {
    const selected = await client.query<{ status: string; model_revision: string }>({
      text: `SELECT status, model_revision
               FROM botmem.embedding_profile
              WHERE id = $1
              FOR UPDATE`,
      values: [embedding.profileId],
      signal,
    });
    const profile = selected.rows[0];
    if (!profile || profile.status === 'error') {
      throw new HostedSearchFailure('embedding_profile_error');
    }
    if (profile.model_revision === 'unconfigured' && profile.status === 'indexing') {
      const updated = await client.query({
        text: `UPDATE botmem.embedding_profile
                  SET status = 'ready', model_revision = $1,
                      failure_code = NULL, updated_at = $2::timestamptz
                WHERE id = $3 AND status = 'indexing'
                  AND model_revision = 'unconfigured'`,
        values: [embedding.modelRevision, now, embedding.profileId],
        signal,
      });
      if (updated.rowCount !== 1) {
        throw new HostedSearchFailure('embedding_profile_mismatch');
      }
      return;
    }
    if (profile.status !== 'ready' || profile.model_revision !== embedding.modelRevision) {
      throw new HostedSearchFailure('embedding_profile_mismatch');
    }
  }
}

function validateDigest(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new HostedSearchFailure('projection_input_mismatch');
  }
}

function validateEmbedding(embedding: NonNullable<HostedProjectionCommand['embedding']>): void {
  if (
    embedding.profileId !== PROFILE_ID ||
    !embedding.modelRevision.trim() ||
    embedding.modelRevision.length > 256 ||
    embedding.values.length !== DIMENSIONS ||
    embedding.values.some((value) => !Number.isFinite(value))
  ) {
    throw new HostedSearchFailure('embedding_invalid');
  }
}

function vectorLiteral(values: readonly number[]): string {
  return `[${values.join(',')}]`;
}

const CLAIM_PROJECTION_SQL = `
INSERT INTO botmem.projection_state (
  tenant_id, account_id, projection_name, revision_id, state, attempts,
  lease_owner, lease_token, lease_expires_at, updated_at
) VALUES ($1::uuid, $2::uuid, $4, $3::uuid, 'processing', 1,
          $5, $6::uuid, $7::timestamptz, statement_timestamp())
ON CONFLICT (projection_name, revision_id) DO UPDATE
  SET state = 'processing', attempts = botmem.projection_state.attempts + 1,
      lease_owner = EXCLUDED.lease_owner, lease_token = EXCLUDED.lease_token,
      lease_expires_at = EXCLUDED.lease_expires_at,
      output_hash = NULL, last_error_code = NULL, applied_at = NULL,
      updated_at = statement_timestamp()
  WHERE botmem.projection_state.state IN ('pending', 'failed')
     OR (
       botmem.projection_state.state = 'processing' AND
       botmem.projection_state.lease_expires_at <= clock_timestamp()
     )
RETURNING state, output_hash
`;

const INSERT_DOCUMENT_SQL = `
INSERT INTO botmem.hosted_document_revision (
  revision_id, tenant_id, account_id, connector, source_event_id,
  source_revision, kind, occurred_at, title, body, thread_durable_id,
  thread_title, authored_by_me, citation, participants,
  participant_durable_ids, media, content_hash, projection_hash, embedding_profile_id,
  embedding, projected_at
) VALUES (
  $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::timestamptz,
  $9, $10, $11, $12, $13::boolean, $14, $15::jsonb, $16::text[],
  $17::jsonb, $18, $19, $20, $21::public.halfvec(768), $22::timestamptz
)
ON CONFLICT (revision_id) DO NOTHING
RETURNING content_hash, projection_hash
`;

const UPSERT_ACTIVE_HEAD_SQL = `
INSERT INTO botmem.hosted_document_head (
  tenant_id, account_id, source_event_id, revision_id, updated_at
)
SELECT $1::uuid, $2::uuid, $3, $4::uuid, $5::timestamptz
  FROM botmem.ingest_event_head ingest_head
 WHERE ingest_head.tenant_id = $1::uuid
   AND ingest_head.account_id = $2::uuid
   AND ingest_head.source_event_id = $3
   AND ingest_head.head_revision_id = $4::uuid
ON CONFLICT (account_id, source_event_id) DO UPDATE
  SET revision_id = EXCLUDED.revision_id, updated_at = EXCLUDED.updated_at
`;

const DELETE_ACTIVE_HEAD_SQL = `
DELETE FROM botmem.hosted_document_head document_head
 WHERE document_head.tenant_id = $1::uuid
   AND document_head.account_id = $2::uuid
   AND document_head.source_event_id = $3
   AND EXISTS (
     SELECT 1 FROM botmem.ingest_event_head ingest_head
      WHERE ingest_head.tenant_id = $1::uuid
        AND ingest_head.account_id = $2::uuid
        AND ingest_head.source_event_id = $3
        AND ingest_head.head_revision_id = $4::uuid
   )
`;

const MARK_PROBE_READY_SQL = `
INSERT INTO botmem.hosted_source_health (
  tenant_id, account_id, searchable, last_probe_at, reason_code, updated_at
)
SELECT $1::uuid, $2::uuid, true, $3::timestamptz, NULL, $3::timestamptz
 WHERE EXISTS (
   SELECT 1 FROM botmem.connector_checkpoint checkpoint
    WHERE checkpoint.tenant_id = $1::uuid
      AND checkpoint.account_id = $2::uuid
      AND checkpoint.last_committed_at IS NOT NULL
 )
   AND NOT EXISTS (
     SELECT 1
       FROM botmem.ingest_event_head ingest_head
       LEFT JOIN botmem.projection_state state
         ON state.tenant_id = ingest_head.tenant_id
        AND state.account_id = ingest_head.account_id
        AND state.revision_id = ingest_head.head_revision_id
        AND state.projection_name = $4
      WHERE ingest_head.tenant_id = $1::uuid
        AND ingest_head.account_id = $2::uuid
        AND state.state IS DISTINCT FROM 'applied'
   )
   AND NOT EXISTS (
     SELECT 1
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
   )
ON CONFLICT (account_id) DO UPDATE
  SET searchable = true, last_probe_at = EXCLUDED.last_probe_at,
      reason_code = NULL, updated_at = EXCLUDED.updated_at
`;

const LIST_REPAIRABLE_SQL = `
SELECT ingest_head.account_id, ingest_head.head_revision_id AS revision_id
  FROM botmem.ingest_event_head ingest_head
  LEFT JOIN botmem.projection_state state
    ON state.tenant_id = ingest_head.tenant_id
   AND state.account_id = ingest_head.account_id
   AND state.revision_id = ingest_head.head_revision_id
   AND state.projection_name = $2
 WHERE ingest_head.tenant_id = $1::uuid
   AND (
     state.revision_id IS NULL OR state.state IN ('pending', 'failed') OR
     (state.state = 'processing' AND state.lease_expires_at <= clock_timestamp())
   )
 ORDER BY ingest_head.updated_at, ingest_head.head_revision_id
 LIMIT $3::integer
`;
