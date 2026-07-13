import { connectorAccountId, type JsonValue, type TenantId } from '@botmem-v2/connector-domain';
import type { HostedConnector } from '@botmem-v2/contracts';
import { randomUUID } from 'node:crypto';
import type { SqlClientPort, SqlPoolPort } from '../search/postgres-ports.js';
import { credentialIdFromReference } from './key-ring.js';
import {
  HostedConnectionNotFoundError,
  HostedConnectionPersistenceError,
  type CompleteConnectionCommand,
  type ConnectionAccountRecord,
  type ConnectionAccountRepository,
} from './ports.js';

interface AccountRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly connector: HostedConnector;
  readonly auth_kind: 'oauth2' | 'basic';
  readonly provider_subject_hash: string;
  readonly credential_ref: string;
  readonly status: 'disconnected' | 'ready' | 'degraded' | 'revoked';
  readonly display_label: string;
  readonly connection_config: JsonValue;
  readonly active_sync: boolean;
  readonly last_sync_at: Date | string | null;
  readonly failure_code: string | null;
}

export class PostgresConnectionAccountRepository implements ConnectionAccountRepository {
  constructor(private readonly pool: SqlPoolPort) {}

  async reserveAccountId(tenant: TenantId, connector: HostedConnector) {
    return this.transaction(tenant, async (client) => {
      const existing = await client.query<{ readonly id: string }>({
        text: `SELECT id FROM botmem.connector_account
                WHERE tenant_id = $1::uuid AND connector = $2`,
        values: [tenant, connector],
      });
      return connectorAccountId(existing.rows[0]?.id ?? randomUUID());
    });
  }

  async completeConnection(command: CompleteConnectionCommand): Promise<ConnectionAccountRecord> {
    return this.transaction(
      command.tenantId,
      async (client) => {
        await setAccountContext(client, command.accountId);
        const credentialId = credentialIdFromReference(command.credentialRef);
        const credential = await client.query({
          text: `SELECT 1 FROM botmem.connector_credential
                WHERE tenant_id = $1::uuid AND account_id = $2::uuid
                  AND id = $3::uuid AND connector = $4 AND revoked_at IS NULL`,
          values: [command.tenantId, command.accountId, credentialId, command.connector],
        });
        if (credential.rowCount !== 1) throw new HostedConnectionPersistenceError();

        // Reconnect cutover is one transaction: once the account points at the
        // newly verified secret, no older secret for that account remains live.
        await client.query({
          text: `UPDATE botmem.connector_credential
                  SET revoked_at = $4::timestamptz, updated_at = $4::timestamptz
                WHERE tenant_id = $1::uuid AND account_id = $2::uuid
                  AND id <> $3::uuid AND revoked_at IS NULL`,
          values: [command.tenantId, command.accountId, credentialId, command.connectedAt],
        });

        await closeActiveSyncs(
          client,
          command.tenantId,
          command.accountId,
          command.connectedAt,
          'RECONNECTED',
        );
        const account = await client.query({
          text: `INSERT INTO botmem.connector_account (
                 id, tenant_id, connector, auth_kind, provider_subject_hash,
                 credential_ref, status, aggregate_version, display_label,
                 connection_config, created_at, updated_at
               ) VALUES (
                 $1::uuid, $2::uuid, $3, $4, $5, $6, 'ready', 0, $7,
                 $8::jsonb, $9::timestamptz, $9::timestamptz
               )
               ON CONFLICT (tenant_id, connector) DO UPDATE
                  SET provider_subject_hash = EXCLUDED.provider_subject_hash,
                      credential_ref = EXCLUDED.credential_ref,
                      status = 'ready',
                      aggregate_version = botmem.connector_account.aggregate_version + 1,
                      display_label = EXCLUDED.display_label,
                      connection_config = EXCLUDED.connection_config,
                      updated_at = EXCLUDED.updated_at
                WHERE botmem.connector_account.id = EXCLUDED.id
               RETURNING id`,
          values: [
            command.accountId,
            command.tenantId,
            command.connector,
            command.authKind,
            command.providerSubjectHash,
            command.credentialRef,
            command.displayLabel,
            JSON.stringify(command.connectionConfig),
            command.connectedAt,
          ],
        });
        if (account.rowCount !== 1) throw new HostedConnectionPersistenceError();
        await client.query({
          text: `INSERT INTO botmem.connector_checkpoint (
                 tenant_id, account_id, cursor_version, cursor,
                 last_sync_id, last_committed_at
               ) VALUES ($1::uuid, $2::uuid, 0, $3::jsonb, NULL, NULL)
               ON CONFLICT (account_id) DO UPDATE
                  SET cursor_version = botmem.connector_checkpoint.cursor_version + 1,
                      cursor = EXCLUDED.cursor,
                      last_sync_id = NULL,
                      last_committed_at = NULL`,
          values: [command.tenantId, command.accountId, JSON.stringify(command.initialCursor)],
        });
        return this.required(client, command.tenantId, command.accountId);
      },
      true,
    );
  }

  async list(tenant: TenantId): Promise<readonly ConnectionAccountRecord[]> {
    return this.transaction(tenant, async (client) => {
      const result = await client.query<AccountRow>({
        text: `${ACCOUNT_SELECT}
                WHERE account.tenant_id = $1::uuid
                ORDER BY account.connector, account.id`,
        values: [tenant],
      });
      return Object.freeze(result.rows.map(mapAccount));
    });
  }

  async get(
    tenant: TenantId,
    accountId: ReturnType<typeof connectorAccountId>,
  ): Promise<ConnectionAccountRecord | null> {
    return this.transaction(tenant, async (client) => {
      const result = await client.query<AccountRow>({
        text: `${ACCOUNT_SELECT}
                WHERE account.tenant_id = $1::uuid AND account.id = $2::uuid`,
        values: [tenant, accountId],
      });
      return result.rows[0] ? mapAccount(result.rows[0]) : null;
    });
  }

  async disconnect(
    tenant: TenantId,
    accountId: ReturnType<typeof connectorAccountId>,
    disconnectedAt: string,
  ): Promise<ConnectionAccountRecord> {
    return this.transaction(
      tenant,
      async (client) => {
        await closeActiveSyncs(client, tenant, accountId, disconnectedAt, 'DISCONNECTED');
        const result = await client.query({
          text: `UPDATE botmem.connector_account
                  SET status = 'disconnected',
                      aggregate_version = aggregate_version + 1,
                      updated_at = $3::timestamptz
                WHERE tenant_id = $1::uuid AND id = $2::uuid
                  AND status <> 'disconnected'`,
          values: [tenant, accountId, disconnectedAt],
        });
        if (result.rowCount !== 1) throw new HostedConnectionNotFoundError();
        return this.required(client, tenant, accountId);
      },
      true,
    );
  }

  private async required(
    client: SqlClientPort,
    tenant: TenantId,
    accountId: ReturnType<typeof connectorAccountId>,
  ): Promise<ConnectionAccountRecord> {
    const result = await client.query<AccountRow>({
      text: `${ACCOUNT_SELECT}
              WHERE account.tenant_id = $1::uuid AND account.id = $2::uuid`,
      values: [tenant, accountId],
    });
    if (!result.rows[0]) throw new HostedConnectionNotFoundError();
    return mapAccount(result.rows[0]);
  }

  private async transaction<Result>(
    tenant: TenantId,
    operation: (client: SqlClientPort) => Promise<Result>,
    serializable = false,
  ): Promise<Result> {
    const client = await this.pool.connect();
    let open = false;
    try {
      await client.query({
        text: serializable ? 'BEGIN ISOLATION LEVEL SERIALIZABLE' : 'BEGIN',
      });
      open = true;
      await client.query({ text: 'SET LOCAL ROLE botmem_api' });
      await client.query({
        text: "SELECT set_config('botmem.tenant_id', $1, true)",
        values: [tenant],
      });
      const result = await operation(client);
      await client.query({ text: 'COMMIT' });
      open = false;
      return result;
    } catch (error) {
      if (open) await client.query({ text: 'ROLLBACK' }).catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

const ACCOUNT_SELECT = `
  SELECT account.id, account.tenant_id, account.connector, account.auth_kind,
         account.provider_subject_hash, account.credential_ref, account.status,
         account.display_label, account.connection_config,
         (EXISTS (
           SELECT 1 FROM botmem.connector_sync active
            WHERE active.tenant_id = account.tenant_id
              AND active.account_id = account.id AND active.state = 'active'
         ) OR EXISTS (
           SELECT 1 FROM botmem.hosted_sync_job queued
            WHERE queued.tenant_id = account.tenant_id
              AND queued.account_id = account.id
              AND queued.state IN ('pending', 'running', 'retry_wait')
         )) AS active_sync,
         checkpoint.last_committed_at AS last_sync_at,
         failure.failure_code
    FROM botmem.connector_account account
    LEFT JOIN botmem.connector_checkpoint checkpoint
      ON checkpoint.tenant_id = account.tenant_id AND checkpoint.account_id = account.id
    LEFT JOIN LATERAL (
      SELECT sync.failure_code
        FROM botmem.connector_sync sync
       WHERE sync.tenant_id = account.tenant_id AND sync.account_id = account.id
         AND sync.state IN ('failed', 'abandoned')
       ORDER BY sync.closed_at DESC NULLS LAST, sync.id DESC
       LIMIT 1
    ) failure ON true`;

async function setAccountContext(client: SqlClientPort, accountId: string): Promise<void> {
  await client.query({
    text: "SELECT set_config('botmem.connector_account_id', $1, true)",
    values: [accountId],
  });
}

async function closeActiveSyncs(
  client: SqlClientPort,
  tenant: TenantId,
  accountId: string,
  at: string,
  failureCode: 'RECONNECTED' | 'DISCONNECTED',
): Promise<void> {
  await client.query({
    text: `UPDATE botmem.connector_sync
              SET state = 'failed', closed_at = $3::timestamptz, failure_code = $4
            WHERE tenant_id = $1::uuid AND account_id = $2::uuid AND state = 'active'`,
    values: [tenant, accountId, at, failureCode],
  });
}

function mapAccount(row: AccountRow): ConnectionAccountRecord {
  return Object.freeze({
    tenantId: row.tenant_id as ConnectionAccountRecord['tenantId'],
    accountId: connectorAccountId(row.id),
    connector: row.connector,
    authKind: row.auth_kind,
    providerSubjectHash: row.provider_subject_hash,
    credentialRef: row.credential_ref,
    status: row.status,
    displayLabel: row.display_label,
    connectionConfig: row.connection_config,
    activeSync: row.active_sync,
    lastSyncAt: row.last_sync_at ? iso(row.last_sync_at) : null,
    failureCode: row.failure_code,
  });
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
