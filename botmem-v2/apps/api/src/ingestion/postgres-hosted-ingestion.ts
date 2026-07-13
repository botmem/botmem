import {
  AccountNotFoundError,
  ConcurrentSyncError,
  ConnectorAccount,
  IdempotencyConflictError,
  OptimisticConcurrencyError,
  SyncOwnershipError,
  connectorAccountId,
  ingestRevisionId,
  outboxMessageId,
  syncId,
  tenantId,
  type ConnectorAccountSnapshot,
  type HostedIngestionUnitOfWork,
  type IngestionIdFactory,
  type JsonValue,
  type SyncClaim,
  type SyncClose,
  type SyncPageCommit,
  type TenantId,
} from '@botmem-v2/connector-domain';
import { randomUUID } from 'node:crypto';
import type { SqlClientPort, SqlPoolPort } from '../search/postgres-ports.js';

interface AccountRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly connector: 'gmail' | 'outlook' | 'owntracks';
  readonly auth_kind: 'oauth2' | 'basic';
  readonly provider_subject_hash: string;
  readonly credential_ref: string;
  readonly status: 'disconnected' | 'ready' | 'degraded' | 'revoked';
  readonly aggregate_version: string | number;
  readonly cursor_version: string | number;
  readonly cursor: JsonValue;
  readonly active_sync_id: string | null;
  readonly active_sync_started_at: Date | string | null;
  readonly active_sync_lease_expires_at: Date | string | null;
}

interface InsertedRevisionRow {
  readonly id: string;
}

interface ExistingRevisionRow {
  readonly id: string;
  readonly content_hash: string;
}

/**
 * PostgreSQL adapter for the connector-domain transaction boundary.
 *
 * Every public mutation executes at SERIALIZABLE isolation after setting the
 * tenant locally. The connector account row is the aggregate mutex; revisions,
 * heads, outbox messages, and cursor movement therefore either commit together
 * or remain entirely unchanged.
 */
export class PostgresHostedIngestionUnitOfWork implements HostedIngestionUnitOfWork {
  public constructor(private readonly pool: SqlPoolPort) {}

  public loadAccount(
    workspaceId: TenantId,
    accountId: ReturnType<typeof connectorAccountId>,
  ): Promise<ConnectorAccountSnapshot | null> {
    return this.inTenantTransaction(workspaceId, (client) =>
      this.loadSnapshot(client, workspaceId, accountId, false),
    );
  }

  public claimSync(claim: SyncClaim): Promise<ConnectorAccountSnapshot> {
    const leaseDurationMs =
      Date.parse(claim.sync.leaseExpiresAt) - Date.parse(claim.sync.startedAt);
    if (
      !Number.isSafeInteger(leaseDurationMs) ||
      leaseDurationMs < 1 ||
      leaseDurationMs > 3_600_000
    ) {
      throw new RangeError('sync lease duration must be between one millisecond and one hour');
    }
    return this.inTenantTransaction(claim.tenantId, async (client) => {
      const current = await this.requiredSnapshot(client, claim.tenantId, claim.accountId);
      if (current.aggregateVersion !== claim.expectedAggregateVersion) {
        throw new OptimisticConcurrencyError();
      }

      if (current.activeSync) {
        if (current.activeSync.id !== claim.replacesExpiredSyncId) {
          throw new ConcurrentSyncError();
        }
        const abandoned = await client.query({
          text: `
            UPDATE botmem.connector_sync
               SET state = 'abandoned',
                   closed_at = clock_timestamp(),
                   failure_code = 'LEASE_EXPIRED'
             WHERE tenant_id = $1::uuid
               AND account_id = $2::uuid
               AND id = $3::uuid
               AND state = 'active'
               AND lease_expires_at <= clock_timestamp()
          `,
          values: [claim.tenantId, claim.accountId, current.activeSync.id],
        });
        if (abandoned.rowCount !== 1) throw new ConcurrentSyncError();
      } else if (claim.replacesExpiredSyncId !== null) {
        throw new OptimisticConcurrencyError();
      }

      try {
        await client.query({
          text: `
            INSERT INTO botmem.connector_sync (
              id, tenant_id, account_id, state, aggregate_version_at_claim,
              started_at, lease_expires_at
            )
            VALUES ($1::uuid, $2::uuid, $3::uuid, 'active', $4::bigint,
                    clock_timestamp(),
                    clock_timestamp() + $5::bigint * interval '1 millisecond')
          `,
          values: [
            claim.sync.id,
            claim.tenantId,
            claim.accountId,
            claim.expectedAggregateVersion,
            leaseDurationMs,
          ],
        });
      } catch (error) {
        if (postgresCode(error) === '23505') throw new ConcurrentSyncError();
        throw error;
      }

      await this.bumpAggregate(
        client,
        claim.tenantId,
        claim.accountId,
        claim.expectedAggregateVersion,
      );
      return this.requiredSnapshot(client, claim.tenantId, claim.accountId);
    });
  }

  public commitPage(commit: SyncPageCommit) {
    return this.inTenantTransaction(commit.tenantId, async (client) => {
      const current = await this.requiredSnapshot(client, commit.tenantId, commit.accountId);
      if (current.activeSync?.id !== commit.syncId) throw new SyncOwnershipError();
      await this.assertActiveSyncLease(client, commit.tenantId, commit.accountId, commit.syncId);
      if (
        current.aggregateVersion !== commit.expectedAggregateVersion ||
        current.cursorVersion !== commit.expectedCursorVersion
      ) {
        throw new OptimisticConcurrencyError();
      }

      const insertedRevisionIds: ReturnType<typeof ingestRevisionId>[] = [];
      let duplicateRevisionCount = 0;
      for (const revision of commit.revisions) {
        const inserted = await client.query<InsertedRevisionRow>({
          text: `
            INSERT INTO botmem.ingest_event_revision (
              id, tenant_id, account_id, source_event_id, source_revision,
              kind, occurred_at, observed_at, content_hash, payload, tombstone
            )
            VALUES (
              $1::uuid, $2::uuid, $3::uuid, $4, $5, $6,
              $7::timestamptz, $8::timestamptz, $9, $10::jsonb, $11
            )
            ON CONFLICT (account_id, source_event_id, source_revision) DO NOTHING
            RETURNING id
          `,
          values: [
            revision.id,
            commit.tenantId,
            commit.accountId,
            revision.sourceEventId,
            revision.sourceRevision,
            revision.kind,
            revision.occurredAt,
            revision.observedAt,
            revision.contentHash,
            JSON.stringify(revision.payload),
            revision.tombstone,
          ],
        });
        if (inserted.rowCount !== 1) {
          const existing = await client.query<ExistingRevisionRow>({
            text: `
              SELECT id, content_hash
                FROM botmem.ingest_event_revision
               WHERE tenant_id = $1::uuid
                 AND account_id = $2::uuid
                 AND source_event_id = $3
                 AND source_revision = $4
            `,
            values: [
              commit.tenantId,
              commit.accountId,
              revision.sourceEventId,
              revision.sourceRevision,
            ],
          });
          if (existing.rows[0]?.content_hash !== revision.contentHash) {
            throw new IdempotencyConflictError();
          }
          duplicateRevisionCount += 1;
          continue;
        }

        insertedRevisionIds.push(ingestRevisionId(inserted.rows[0]!.id));
        await client.query({
          text: `
            INSERT INTO botmem.ingest_event_head (
              tenant_id, account_id, source_event_id, head_revision_id, updated_at
            )
            VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5::timestamptz)
            ON CONFLICT (account_id, source_event_id) DO UPDATE
               SET head_revision_id = EXCLUDED.head_revision_id,
                   updated_at = EXCLUDED.updated_at
             WHERE botmem.ingest_event_head.updated_at <= EXCLUDED.updated_at
          `,
          values: [
            commit.tenantId,
            commit.accountId,
            revision.sourceEventId,
            revision.id,
            revision.observedAt,
          ],
        });
        await client.query({
          text: `
            INSERT INTO botmem.transactional_outbox (
              id, tenant_id, account_id, revision_id, payload
            )
            VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::jsonb)
          `,
          values: [
            revision.outboxId,
            commit.tenantId,
            commit.accountId,
            revision.id,
            JSON.stringify({
              version: 1,
              tenantId: commit.tenantId,
              accountId: commit.accountId,
              revisionId: revision.id,
            }),
          ],
        });
      }

      const checkpoint = await client.query({
        text: `
          INSERT INTO botmem.connector_checkpoint (
            tenant_id, account_id, cursor_version, cursor, last_sync_id, last_committed_at
          )
          VALUES ($1::uuid, $2::uuid, 1, $3::jsonb, $4::uuid, $5::timestamptz)
          ON CONFLICT (account_id) DO UPDATE
             SET cursor_version = botmem.connector_checkpoint.cursor_version + 1,
                 cursor = EXCLUDED.cursor,
                 last_sync_id = EXCLUDED.last_sync_id,
                 last_committed_at = EXCLUDED.last_committed_at
           WHERE botmem.connector_checkpoint.cursor_version = $6::bigint
          RETURNING cursor_version
        `,
        values: [
          commit.tenantId,
          commit.accountId,
          JSON.stringify(commit.nextCursor),
          commit.syncId,
          commit.committedAt,
          commit.expectedCursorVersion,
        ],
      });
      if (checkpoint.rowCount !== 1) throw new OptimisticConcurrencyError();
      await this.assertActiveSyncLease(client, commit.tenantId, commit.accountId, commit.syncId);
      await this.bumpAggregate(
        client,
        commit.tenantId,
        commit.accountId,
        commit.expectedAggregateVersion,
      );
      const account = await this.requiredSnapshot(client, commit.tenantId, commit.accountId);
      return Object.freeze({
        account,
        insertedRevisionIds: Object.freeze(insertedRevisionIds),
        duplicateRevisionCount,
      });
    });
  }

  public closeSync(close: SyncClose): Promise<ConnectorAccountSnapshot> {
    return this.inTenantTransaction(close.tenantId, async (client) => {
      const current = await this.requiredSnapshot(client, close.tenantId, close.accountId);
      if (current.activeSync?.id !== close.syncId) throw new SyncOwnershipError();
      if (current.aggregateVersion !== close.expectedAggregateVersion) {
        throw new OptimisticConcurrencyError();
      }
      const closed = await client.query({
        text: `
          UPDATE botmem.connector_sync
             SET state = $4,
                 closed_at = $5::timestamptz,
                 failure_code = $6
           WHERE tenant_id = $1::uuid
             AND account_id = $2::uuid
             AND id = $3::uuid
             AND state = 'active'
             AND lease_expires_at > clock_timestamp()
        `,
        values: [
          close.tenantId,
          close.accountId,
          close.syncId,
          close.outcome === 'completed' ? 'completed' : 'failed',
          close.closedAt,
          close.outcome === 'completed' ? null : close.reasonCode,
        ],
      });
      if (closed.rowCount !== 1) throw new SyncOwnershipError();
      const account = await client.query({
        text: `
          UPDATE botmem.connector_account
             SET aggregate_version = aggregate_version + 1,
                 status = $4,
                 updated_at = GREATEST($5::timestamptz, created_at)
           WHERE tenant_id = $1::uuid
             AND id = $2::uuid
             AND aggregate_version = $3::bigint
        `,
        values: [
          close.tenantId,
          close.accountId,
          close.expectedAggregateVersion,
          close.outcome === 'completed' ? 'ready' : 'degraded',
          close.closedAt,
        ],
      });
      if (account.rowCount !== 1) throw new OptimisticConcurrencyError();
      return this.requiredSnapshot(client, close.tenantId, close.accountId);
    });
  }

  private async requiredSnapshot(
    client: SqlClientPort,
    workspaceId: TenantId,
    accountId: ReturnType<typeof connectorAccountId>,
  ): Promise<ConnectorAccountSnapshot> {
    const snapshot = await this.loadSnapshot(client, workspaceId, accountId, true);
    if (!snapshot) throw new AccountNotFoundError();
    return snapshot;
  }

  private async assertActiveSyncLease(
    client: SqlClientPort,
    tenant: TenantId,
    account: ReturnType<typeof connectorAccountId>,
    sync: ReturnType<typeof syncId>,
  ): Promise<void> {
    const active = await client.query({
      text: `SELECT 1
               FROM botmem.connector_sync
              WHERE tenant_id = $1::uuid AND account_id = $2::uuid
                AND id = $3::uuid AND state = 'active'
                AND lease_expires_at > clock_timestamp()
              FOR UPDATE`,
      values: [tenant, account, sync],
    });
    if (active.rowCount !== 1) throw new SyncOwnershipError();
  }

  private async loadSnapshot(
    client: SqlClientPort,
    workspaceId: TenantId,
    accountId: ReturnType<typeof connectorAccountId>,
    lock: boolean,
  ): Promise<ConnectorAccountSnapshot | null> {
    const result = await client.query<AccountRow>({
      text: `
        SELECT ca.id,
               ca.tenant_id,
               ca.connector,
               ca.auth_kind,
               ca.provider_subject_hash,
               ca.credential_ref,
               ca.status,
               ca.aggregate_version,
               COALESCE(cp.cursor_version, 0) AS cursor_version,
               COALESCE(cp.cursor, '{}'::jsonb) AS cursor,
               active.id AS active_sync_id,
               active.started_at AS active_sync_started_at,
               active.lease_expires_at AS active_sync_lease_expires_at
          FROM botmem.connector_account ca
          LEFT JOIN botmem.connector_checkpoint cp
            ON cp.tenant_id = ca.tenant_id AND cp.account_id = ca.id
          LEFT JOIN LATERAL (
            SELECT cs.id, cs.started_at, cs.lease_expires_at
              FROM botmem.connector_sync cs
             WHERE cs.tenant_id = ca.tenant_id
               AND cs.account_id = ca.id
               AND cs.state = 'active'
             LIMIT 1
          ) active ON true
         WHERE ca.tenant_id = $1::uuid AND ca.id = $2::uuid
         ${lock ? 'FOR UPDATE OF ca' : ''}
      `,
      values: [workspaceId, accountId],
    });
    const row = result.rows[0];
    if (!row) return null;
    const activeSync = row.active_sync_id
      ? Object.freeze({
          id: syncId(row.active_sync_id),
          startedAt: iso(row.active_sync_started_at),
          leaseExpiresAt: iso(row.active_sync_lease_expires_at),
        })
      : null;
    return ConnectorAccount.rehydrate({
      id: connectorAccountId(row.id),
      tenantId: tenantId(row.tenant_id),
      connector: row.connector,
      authKind: row.auth_kind,
      providerSubjectHash: row.provider_subject_hash,
      credentialRef: row.credential_ref,
      status: row.status,
      aggregateVersion: integer(row.aggregate_version, 'aggregate_version'),
      cursorVersion: integer(row.cursor_version, 'cursor_version'),
      cursor: row.cursor,
      activeSync,
    }).snapshot();
  }

  private async bumpAggregate(
    client: SqlClientPort,
    workspaceId: TenantId,
    accountId: ReturnType<typeof connectorAccountId>,
    expectedVersion: number,
  ): Promise<void> {
    const result = await client.query({
      text: `
        UPDATE botmem.connector_account
           SET aggregate_version = aggregate_version + 1,
               updated_at = statement_timestamp()
         WHERE tenant_id = $1::uuid
           AND id = $2::uuid
           AND aggregate_version = $3::bigint
      `,
      values: [workspaceId, accountId, expectedVersion],
    });
    if (result.rowCount !== 1) throw new OptimisticConcurrencyError();
  }

  private async inTenantTransaction<T>(
    workspaceId: TenantId,
    work: (client: SqlClientPort) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    let completed = false;
    try {
      await client.query({ text: 'BEGIN ISOLATION LEVEL SERIALIZABLE' });
      await client.query({ text: 'SET LOCAL ROLE botmem_worker' });
      await client.query({
        text: `SELECT set_config('botmem.tenant_id', $1, true)`,
        values: [workspaceId],
      });
      const result = await work(client);
      await client.query({ text: 'COMMIT' });
      completed = true;
      return result;
    } catch (error) {
      if (!completed) {
        try {
          await client.query({ text: 'ROLLBACK' });
        } catch {
          // Preserve the domain/database failure. Never surface a rollback
          // error that could echo query values.
        }
      }
      if (postgresCode(error) === '40001') throw new OptimisticConcurrencyError();
      throw error;
    } finally {
      client.release();
    }
  }
}

export class NodeIngestionIdFactory implements IngestionIdFactory {
  public nextRevisionId() {
    return ingestRevisionId(randomUUID());
  }

  public nextOutboxMessageId() {
    return outboxMessageId(randomUUID());
  }
}

function integer(value: string | number, label: string): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} is outside the safe integer range`);
  }
  return parsed;
}

function iso(value: Date | string | null): string {
  if (value === null) throw new Error('active sync timestamp is missing');
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function postgresCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}
