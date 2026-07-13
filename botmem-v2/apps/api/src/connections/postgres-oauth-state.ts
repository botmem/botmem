import type {
  GmailOAuthStateRepository,
  PendingGmailOAuthState,
} from '../connectors/gmail/index.js';
import type {
  OutlookOAuthStateRepository,
  PendingOutlookOAuthState,
} from '../connectors/outlook/index.js';
import type { SqlClientPort, SqlPoolPort } from '../search/postgres-ports.js';

type PendingState = PendingGmailOAuthState | PendingOutlookOAuthState;

interface StateRow {
  readonly tenant_id: string;
  readonly account_id: string;
  readonly connector: 'gmail' | 'outlook';
  readonly sealed_pkce_verifier: string;
  readonly redirect_uri: string;
  readonly authority: string | null;
  readonly scope: string;
  readonly created_at: Date | string;
  readonly expires_at: Date | string;
}

export class PostgresConnectorOAuthStateStore {
  constructor(private readonly pool: SqlPoolPort) {}

  async save(connector: 'gmail' | 'outlook', state: PendingState): Promise<void> {
    await this.transaction(async (client) => {
      await client.query({ text: 'SET LOCAL ROLE botmem_api' });
      await client.query({
        text: "SELECT set_config('botmem.tenant_id', $1, true)",
        values: [state.tenantId],
      });
      await client.query({
        text: `INSERT INTO botmem.connector_oauth_state (
                 state_digest, tenant_id, account_id, connector,
                 sealed_pkce_verifier, redirect_uri, authority, scope,
                 created_at, expires_at
               ) VALUES (
                 decode($1, 'hex'), $2::uuid, $3::uuid, $4,
                 $5, $6, $7, $8, $9::timestamptz, $10::timestamptz
               )`,
        values: [
          state.stateDigest,
          state.tenantId,
          state.accountId,
          connector,
          state.sealedPkceVerifier,
          state.redirectUri,
          connector === 'outlook' ? (state as PendingOutlookOAuthState).authority : null,
          state.scope,
          state.createdAt,
          state.expiresAt,
        ],
      });
    });
  }

  async consume(connector: 'gmail' | 'outlook', stateDigest: string, now: string) {
    return this.transaction(async (client) => {
      await client.query({ text: 'SET LOCAL ROLE botmem_api' });
      const result = await client.query<StateRow>({
        text: `SELECT tenant_id, account_id, connector, sealed_pkce_verifier,
                      redirect_uri, authority, scope, created_at, expires_at
                 FROM botmem.consume_connector_oauth_state($1, $2, $3::timestamptz)`,
        values: [connector, stateDigest, now],
      });
      return result.rows[0] ?? null;
    });
  }

  private async transaction<Result>(
    operation: (client: SqlClientPort) => Promise<Result>,
  ): Promise<Result> {
    const client = await this.pool.connect();
    let open = false;
    try {
      await client.query({ text: 'BEGIN' });
      open = true;
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

export class PostgresGmailOAuthStateRepository implements GmailOAuthStateRepository {
  constructor(private readonly store: PostgresConnectorOAuthStateStore) {}

  save(state: PendingGmailOAuthState): Promise<void> {
    return this.store.save('gmail', state);
  }

  async consume(stateDigest: string, now: string): Promise<PendingGmailOAuthState | null> {
    const row = await this.store.consume('gmail', stateDigest, now);
    if (!row || row.connector !== 'gmail' || row.authority !== null) return null;
    return Object.freeze({
      stateDigest,
      tenantId: row.tenant_id as PendingGmailOAuthState['tenantId'],
      accountId: row.account_id as PendingGmailOAuthState['accountId'],
      sealedPkceVerifier: row.sealed_pkce_verifier,
      redirectUri: row.redirect_uri,
      scope: row.scope,
      createdAt: iso(row.created_at),
      expiresAt: iso(row.expires_at),
    });
  }
}

export class PostgresOutlookOAuthStateRepository implements OutlookOAuthStateRepository {
  constructor(private readonly store: PostgresConnectorOAuthStateStore) {}

  save(state: PendingOutlookOAuthState): Promise<void> {
    return this.store.save('outlook', state);
  }

  async consume(stateDigest: string, now: string): Promise<PendingOutlookOAuthState | null> {
    const row = await this.store.consume('outlook', stateDigest, now);
    if (!row || row.connector !== 'outlook' || row.authority !== 'common') return null;
    return Object.freeze({
      stateDigest,
      tenantId: row.tenant_id as PendingOutlookOAuthState['tenantId'],
      accountId: row.account_id as PendingOutlookOAuthState['accountId'],
      sealedPkceVerifier: row.sealed_pkce_verifier,
      redirectUri: row.redirect_uri,
      authority: 'common',
      scope: row.scope,
      createdAt: iso(row.created_at),
      expiresAt: iso(row.expires_at),
    });
  }
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
