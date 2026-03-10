import { Injectable, OnModuleInit, OnModuleDestroy, Logger, Optional } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { resolve } from 'path';
import { ConfigService } from '../config/config.service';
import * as schema from './schema';
import { RlsContext } from './rls.context';

// All tables and their required columns derived from schema.ts.
// App refuses to start if any are missing after migrations run.
const REQUIRED_SCHEMA: Record<string, string[]> = {
  users: [
    'id',
    'email',
    'password_hash',
    'name',
    'onboarded',
    'encryption_salt',
    'key_version',
    'stripe_customer_id',
    'subscription_status',
    'subscription_id',
    'subscription_current_period_end',
    'created_at',
    'updated_at',
  ],
  refresh_tokens: [
    'id',
    'user_id',
    'token_hash',
    'family',
    'expires_at',
    'revoked_at',
    'created_at',
  ],
  password_resets: ['id', 'user_id', 'token_hash', 'expires_at', 'used_at', 'created_at'],
  accounts: [
    'id',
    'user_id',
    'connector_type',
    'identifier',
    'status',
    'schedule',
    'auth_context',
    'last_cursor',
    'last_sync_at',
    'items_synced',
    'last_error',
    'created_at',
    'updated_at',
  ],
  connector_credentials: ['connector_type', 'credentials', 'updated_at'],
  jobs: [
    'id',
    'account_id',
    'connector_type',
    'account_identifier',
    'memory_bank_id',
    'status',
    'priority',
    'progress',
    'total',
    'error',
    'started_at',
    'completed_at',
    'created_at',
  ],
  raw_events: [
    'id',
    'account_id',
    'connector_type',
    'source_id',
    'source_type',
    'payload',
    'cleaned_text',
    'timestamp',
    'job_id',
    'created_at',
  ],
  memories: [
    'id',
    'account_id',
    'memory_bank_id',
    'connector_type',
    'source_type',
    'source_id',
    'text',
    'event_time',
    'ingest_time',
    'factuality',
    'weights',
    'entities',
    'claims',
    'metadata',
    'embedding_status',
    'pinned',
    'recall_count',
    'key_version',
    'enriched_at',
    'created_at',
  ],
  memory_links: ['id', 'src_memory_id', 'dst_memory_id', 'link_type', 'strength', 'created_at'],
  contacts: [
    'id',
    'user_id',
    'display_name',
    'entity_type',
    'avatars',
    'metadata',
    'created_at',
    'updated_at',
  ],
  contact_identifiers: [
    'id',
    'contact_id',
    'identifier_type',
    'identifier_value',
    'connector_type',
    'confidence',
    'created_at',
  ],
  memory_contacts: ['id', 'memory_id', 'contact_id', 'role'],
  merge_dismissals: ['id', 'contact_id_1', 'contact_id_2', 'created_at'],
  memory_banks: ['id', 'user_id', 'name', 'is_default', 'created_at', 'updated_at'],
  api_keys: [
    'id',
    'user_id',
    'name',
    'key_hash',
    'last_four',
    'memory_bank_ids',
    'expires_at',
    'revoked_at',
    'created_at',
  ],
  settings: ['key', 'value'],
  oauth_clients: [
    'client_id',
    'client_secret',
    'client_name',
    'redirect_uris',
    'grant_types',
    'token_endpoint_auth_method',
    'scope',
    'created_at',
  ],
  oauth_codes: [
    'code',
    'user_id',
    'client_id',
    'redirect_uri',
    'scope',
    'code_challenge',
    'code_challenge_method',
    'expires_at',
    'used_at',
  ],
  oauth_refresh_tokens: [
    'id',
    'token_hash',
    'user_id',
    'client_id',
    'scope',
    'expires_at',
    'revoked_at',
  ],
};

@Injectable()
export class DbService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DbService.name);
  public db!: NodePgDatabase<typeof schema>;
  private pool!: Pool;

  constructor(
    private config: ConfigService,
    @Optional() private readonly rlsContext?: RlsContext,
  ) {}

  async onModuleInit() {
    this.pool = new Pool({
      connectionString: this.config.databaseUrl,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 30000,
    });

    this.db = drizzle(this.pool, { schema });

    await migrate(this.db, { migrationsFolder: resolve(__dirname, 'migrations') });
    this.logger.log('Migrations applied');

    await this.validateSchema();
    await this.createRlsPolicies();
    this.logger.log('PostgreSQL connected and tables ensured');
  }

  async onModuleDestroy() {
    await this.pool.end();
  }

  /** Expose pool for interceptor usage */
  get connectionPool(): Pool {
    return this.pool;
  }

  /**
   * Run fn inside a transaction with SET LOCAL app.current_user_id.
   * Used by BullMQ processors and any caller with an explicit userId.
   * SET LOCAL means the variable is scoped to the transaction only —
   * it resets on COMMIT/ROLLBACK, preventing bleed between pooled connections.
   */
  async withUserId<T>(
    userId: string,
    fn: (db: NodePgDatabase<typeof schema>) => Promise<T>,
  ): Promise<T> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.current_user_id = '${userId.replace(/'/g, "''")}'`);
      const txDb = drizzle(client, { schema });
      const result = await fn(txDb);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Run fn with the userId from the current HTTP request's RLS context.
   * Reads from AsyncLocalStorage set by RlsInterceptor.
   * Falls back to running without RLS if not in an HTTP context
   * (BullMQ processors must use withUserId() explicitly instead).
   */
  async withCurrentUser<T>(fn: (db: NodePgDatabase<typeof schema>) => Promise<T>): Promise<T> {
    const userId = this.rlsContext?.getCurrentUserId();
    if (!userId) {
      // Outside request context (e.g. BullMQ without explicit withUserId call) — run without RLS
      // scope. The DB role must have BYPASSRLS or queries will return empty results.
      // BullMQ processors must always use withUserId() explicitly instead.
      return fn(this.db);
    }
    return this.withUserId(userId, fn);
  }

  async healthCheck(): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT 1');
      return true;
    } catch {
      return false;
    } finally {
      client.release();
    }
  }

  /**
   * Verifies every expected table and column exists in the DB.
   * Throws if anything is missing — prevents startup with a broken schema.
   */
  private async validateSchema() {
    const client = await this.pool.connect();
    try {
      const { rows } = await client.query<{ table_name: string; column_name: string }>(`
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
      `);

      const actual = new Map<string, Set<string>>();
      for (const row of rows) {
        if (!actual.has(row.table_name)) actual.set(row.table_name, new Set());
        actual.get(row.table_name)!.add(row.column_name);
      }

      const missing: string[] = [];
      for (const [table, columns] of Object.entries(REQUIRED_SCHEMA)) {
        if (!actual.has(table)) {
          missing.push(`table "${table}"`);
          continue;
        }
        for (const col of columns) {
          if (!actual.get(table)!.has(col)) {
            missing.push(`"${table}.${col}"`);
          }
        }
      }

      if (missing.length > 0) {
        throw new Error(
          `Schema validation failed — missing: ${missing.join(', ')}. ` +
            'Check migration files or run drizzle-kit generate.',
        );
      }
    } finally {
      client.release();
    }
  }

  /**
   * Enables Row-Level Security on all user-owned tables and creates idempotent
   * per-user policies using the session variable app.current_user_id.
   *
   * Tables excluded (no per-user ownership): users, settings, connector_credentials.
   */
  private async createRlsPolicies() {
    const client = await this.pool.connect();
    try {
      await client.query(`
        -- =====================================================================
        -- TABLES WITH DIRECT user_id COLUMN
        -- accounts, contacts, memory_banks, api_keys, refresh_tokens, password_resets
        -- =====================================================================

        ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
        ALTER TABLE accounts FORCE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS rls_accounts_select ON accounts;
        DROP POLICY IF EXISTS rls_accounts_insert ON accounts;
        DROP POLICY IF EXISTS rls_accounts_update ON accounts;
        DROP POLICY IF EXISTS rls_accounts_delete ON accounts;
        CREATE POLICY rls_accounts_select ON accounts FOR SELECT USING (user_id = current_setting('app.current_user_id', true));
        CREATE POLICY rls_accounts_insert ON accounts FOR INSERT WITH CHECK (user_id = current_setting('app.current_user_id', true));
        CREATE POLICY rls_accounts_update ON accounts FOR UPDATE USING (user_id = current_setting('app.current_user_id', true));
        CREATE POLICY rls_accounts_delete ON accounts FOR DELETE USING (user_id = current_setting('app.current_user_id', true));

        ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
        ALTER TABLE contacts FORCE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS rls_contacts_select ON contacts;
        DROP POLICY IF EXISTS rls_contacts_insert ON contacts;
        DROP POLICY IF EXISTS rls_contacts_update ON contacts;
        DROP POLICY IF EXISTS rls_contacts_delete ON contacts;
        CREATE POLICY rls_contacts_select ON contacts FOR SELECT USING (user_id = current_setting('app.current_user_id', true));
        CREATE POLICY rls_contacts_insert ON contacts FOR INSERT WITH CHECK (user_id = current_setting('app.current_user_id', true));
        CREATE POLICY rls_contacts_update ON contacts FOR UPDATE USING (user_id = current_setting('app.current_user_id', true));
        CREATE POLICY rls_contacts_delete ON contacts FOR DELETE USING (user_id = current_setting('app.current_user_id', true));

        ALTER TABLE memory_banks ENABLE ROW LEVEL SECURITY;
        ALTER TABLE memory_banks FORCE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS rls_memory_banks_select ON memory_banks;
        DROP POLICY IF EXISTS rls_memory_banks_insert ON memory_banks;
        DROP POLICY IF EXISTS rls_memory_banks_update ON memory_banks;
        DROP POLICY IF EXISTS rls_memory_banks_delete ON memory_banks;
        CREATE POLICY rls_memory_banks_select ON memory_banks FOR SELECT USING (user_id = current_setting('app.current_user_id', true));
        CREATE POLICY rls_memory_banks_insert ON memory_banks FOR INSERT WITH CHECK (user_id = current_setting('app.current_user_id', true));
        CREATE POLICY rls_memory_banks_update ON memory_banks FOR UPDATE USING (user_id = current_setting('app.current_user_id', true));
        CREATE POLICY rls_memory_banks_delete ON memory_banks FOR DELETE USING (user_id = current_setting('app.current_user_id', true));

        ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
        ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS rls_api_keys_select ON api_keys;
        DROP POLICY IF EXISTS rls_api_keys_insert ON api_keys;
        DROP POLICY IF EXISTS rls_api_keys_update ON api_keys;
        DROP POLICY IF EXISTS rls_api_keys_delete ON api_keys;
        CREATE POLICY rls_api_keys_select ON api_keys FOR SELECT USING (user_id = current_setting('app.current_user_id', true));
        CREATE POLICY rls_api_keys_insert ON api_keys FOR INSERT WITH CHECK (user_id = current_setting('app.current_user_id', true));
        CREATE POLICY rls_api_keys_update ON api_keys FOR UPDATE USING (user_id = current_setting('app.current_user_id', true));
        CREATE POLICY rls_api_keys_delete ON api_keys FOR DELETE USING (user_id = current_setting('app.current_user_id', true));

        ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
        ALTER TABLE refresh_tokens FORCE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS rls_refresh_tokens_select ON refresh_tokens;
        DROP POLICY IF EXISTS rls_refresh_tokens_insert ON refresh_tokens;
        DROP POLICY IF EXISTS rls_refresh_tokens_update ON refresh_tokens;
        DROP POLICY IF EXISTS rls_refresh_tokens_delete ON refresh_tokens;
        CREATE POLICY rls_refresh_tokens_select ON refresh_tokens FOR SELECT USING (user_id = current_setting('app.current_user_id', true));
        CREATE POLICY rls_refresh_tokens_insert ON refresh_tokens FOR INSERT WITH CHECK (user_id = current_setting('app.current_user_id', true));
        CREATE POLICY rls_refresh_tokens_update ON refresh_tokens FOR UPDATE USING (user_id = current_setting('app.current_user_id', true));
        CREATE POLICY rls_refresh_tokens_delete ON refresh_tokens FOR DELETE USING (user_id = current_setting('app.current_user_id', true));

        ALTER TABLE password_resets ENABLE ROW LEVEL SECURITY;
        ALTER TABLE password_resets FORCE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS rls_password_resets_select ON password_resets;
        DROP POLICY IF EXISTS rls_password_resets_insert ON password_resets;
        DROP POLICY IF EXISTS rls_password_resets_update ON password_resets;
        DROP POLICY IF EXISTS rls_password_resets_delete ON password_resets;
        CREATE POLICY rls_password_resets_select ON password_resets FOR SELECT USING (user_id = current_setting('app.current_user_id', true));
        CREATE POLICY rls_password_resets_insert ON password_resets FOR INSERT WITH CHECK (user_id = current_setting('app.current_user_id', true));
        CREATE POLICY rls_password_resets_update ON password_resets FOR UPDATE USING (user_id = current_setting('app.current_user_id', true));
        CREATE POLICY rls_password_resets_delete ON password_resets FOR DELETE USING (user_id = current_setting('app.current_user_id', true));

        -- =====================================================================
        -- TABLES WITH account_id → accounts.user_id
        -- jobs, raw_events, memories
        -- =====================================================================

        ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
        ALTER TABLE jobs FORCE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS rls_jobs_select ON jobs;
        DROP POLICY IF EXISTS rls_jobs_insert ON jobs;
        DROP POLICY IF EXISTS rls_jobs_update ON jobs;
        DROP POLICY IF EXISTS rls_jobs_delete ON jobs;
        CREATE POLICY rls_jobs_select ON jobs FOR SELECT USING (EXISTS (SELECT 1 FROM accounts a WHERE a.id = jobs.account_id AND a.user_id = current_setting('app.current_user_id', true)));
        CREATE POLICY rls_jobs_insert ON jobs FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM accounts a WHERE a.id = jobs.account_id AND a.user_id = current_setting('app.current_user_id', true)));
        CREATE POLICY rls_jobs_update ON jobs FOR UPDATE USING (EXISTS (SELECT 1 FROM accounts a WHERE a.id = jobs.account_id AND a.user_id = current_setting('app.current_user_id', true)));
        CREATE POLICY rls_jobs_delete ON jobs FOR DELETE USING (EXISTS (SELECT 1 FROM accounts a WHERE a.id = jobs.account_id AND a.user_id = current_setting('app.current_user_id', true)));

        ALTER TABLE raw_events ENABLE ROW LEVEL SECURITY;
        ALTER TABLE raw_events FORCE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS rls_raw_events_select ON raw_events;
        DROP POLICY IF EXISTS rls_raw_events_insert ON raw_events;
        DROP POLICY IF EXISTS rls_raw_events_update ON raw_events;
        DROP POLICY IF EXISTS rls_raw_events_delete ON raw_events;
        CREATE POLICY rls_raw_events_select ON raw_events FOR SELECT USING (EXISTS (SELECT 1 FROM accounts a WHERE a.id = raw_events.account_id AND a.user_id = current_setting('app.current_user_id', true)));
        CREATE POLICY rls_raw_events_insert ON raw_events FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM accounts a WHERE a.id = raw_events.account_id AND a.user_id = current_setting('app.current_user_id', true)));
        CREATE POLICY rls_raw_events_update ON raw_events FOR UPDATE USING (EXISTS (SELECT 1 FROM accounts a WHERE a.id = raw_events.account_id AND a.user_id = current_setting('app.current_user_id', true)));
        CREATE POLICY rls_raw_events_delete ON raw_events FOR DELETE USING (EXISTS (SELECT 1 FROM accounts a WHERE a.id = raw_events.account_id AND a.user_id = current_setting('app.current_user_id', true)));

        ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
        ALTER TABLE memories FORCE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS rls_memories_select ON memories;
        DROP POLICY IF EXISTS rls_memories_insert ON memories;
        DROP POLICY IF EXISTS rls_memories_update ON memories;
        DROP POLICY IF EXISTS rls_memories_delete ON memories;
        CREATE POLICY rls_memories_select ON memories FOR SELECT USING (EXISTS (SELECT 1 FROM accounts a WHERE a.id = memories.account_id AND a.user_id = current_setting('app.current_user_id', true)));
        CREATE POLICY rls_memories_insert ON memories FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM accounts a WHERE a.id = memories.account_id AND a.user_id = current_setting('app.current_user_id', true)));
        CREATE POLICY rls_memories_update ON memories FOR UPDATE USING (EXISTS (SELECT 1 FROM accounts a WHERE a.id = memories.account_id AND a.user_id = current_setting('app.current_user_id', true)));
        CREATE POLICY rls_memories_delete ON memories FOR DELETE USING (EXISTS (SELECT 1 FROM accounts a WHERE a.id = memories.account_id AND a.user_id = current_setting('app.current_user_id', true)));

        -- =====================================================================
        -- TABLES VIA memories (two-hop via accounts)
        -- memory_links, memory_contacts
        -- =====================================================================

        ALTER TABLE memory_links ENABLE ROW LEVEL SECURITY;
        ALTER TABLE memory_links FORCE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS rls_memory_links_select ON memory_links;
        DROP POLICY IF EXISTS rls_memory_links_insert ON memory_links;
        DROP POLICY IF EXISTS rls_memory_links_update ON memory_links;
        DROP POLICY IF EXISTS rls_memory_links_delete ON memory_links;
        CREATE POLICY rls_memory_links_select ON memory_links FOR SELECT USING (EXISTS (SELECT 1 FROM memories m WHERE m.id = memory_links.src_memory_id AND EXISTS (SELECT 1 FROM accounts a WHERE a.id = m.account_id AND a.user_id = current_setting('app.current_user_id', true))));
        CREATE POLICY rls_memory_links_insert ON memory_links FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM memories m WHERE m.id = memory_links.src_memory_id AND EXISTS (SELECT 1 FROM accounts a WHERE a.id = m.account_id AND a.user_id = current_setting('app.current_user_id', true))));
        CREATE POLICY rls_memory_links_update ON memory_links FOR UPDATE USING (EXISTS (SELECT 1 FROM memories m WHERE m.id = memory_links.src_memory_id AND EXISTS (SELECT 1 FROM accounts a WHERE a.id = m.account_id AND a.user_id = current_setting('app.current_user_id', true))));
        CREATE POLICY rls_memory_links_delete ON memory_links FOR DELETE USING (EXISTS (SELECT 1 FROM memories m WHERE m.id = memory_links.src_memory_id AND EXISTS (SELECT 1 FROM accounts a WHERE a.id = m.account_id AND a.user_id = current_setting('app.current_user_id', true))));

        ALTER TABLE memory_contacts ENABLE ROW LEVEL SECURITY;
        ALTER TABLE memory_contacts FORCE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS rls_memory_contacts_select ON memory_contacts;
        DROP POLICY IF EXISTS rls_memory_contacts_insert ON memory_contacts;
        DROP POLICY IF EXISTS rls_memory_contacts_update ON memory_contacts;
        DROP POLICY IF EXISTS rls_memory_contacts_delete ON memory_contacts;
        CREATE POLICY rls_memory_contacts_select ON memory_contacts FOR SELECT USING (EXISTS (SELECT 1 FROM memories m WHERE m.id = memory_contacts.memory_id AND EXISTS (SELECT 1 FROM accounts a WHERE a.id = m.account_id AND a.user_id = current_setting('app.current_user_id', true))));
        CREATE POLICY rls_memory_contacts_insert ON memory_contacts FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM memories m WHERE m.id = memory_contacts.memory_id AND EXISTS (SELECT 1 FROM accounts a WHERE a.id = m.account_id AND a.user_id = current_setting('app.current_user_id', true))));
        CREATE POLICY rls_memory_contacts_update ON memory_contacts FOR UPDATE USING (EXISTS (SELECT 1 FROM memories m WHERE m.id = memory_contacts.memory_id AND EXISTS (SELECT 1 FROM accounts a WHERE a.id = m.account_id AND a.user_id = current_setting('app.current_user_id', true))));
        CREATE POLICY rls_memory_contacts_delete ON memory_contacts FOR DELETE USING (EXISTS (SELECT 1 FROM memories m WHERE m.id = memory_contacts.memory_id AND EXISTS (SELECT 1 FROM accounts a WHERE a.id = m.account_id AND a.user_id = current_setting('app.current_user_id', true))));

        -- =====================================================================
        -- TABLES VIA contacts
        -- contact_identifiers, merge_dismissals
        -- =====================================================================

        ALTER TABLE contact_identifiers ENABLE ROW LEVEL SECURITY;
        ALTER TABLE contact_identifiers FORCE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS rls_contact_identifiers_select ON contact_identifiers;
        DROP POLICY IF EXISTS rls_contact_identifiers_insert ON contact_identifiers;
        DROP POLICY IF EXISTS rls_contact_identifiers_update ON contact_identifiers;
        DROP POLICY IF EXISTS rls_contact_identifiers_delete ON contact_identifiers;
        CREATE POLICY rls_contact_identifiers_select ON contact_identifiers FOR SELECT USING (EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_identifiers.contact_id AND c.user_id = current_setting('app.current_user_id', true)));
        CREATE POLICY rls_contact_identifiers_insert ON contact_identifiers FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_identifiers.contact_id AND c.user_id = current_setting('app.current_user_id', true)));
        CREATE POLICY rls_contact_identifiers_update ON contact_identifiers FOR UPDATE USING (EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_identifiers.contact_id AND c.user_id = current_setting('app.current_user_id', true)));
        CREATE POLICY rls_contact_identifiers_delete ON contact_identifiers FOR DELETE USING (EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_identifiers.contact_id AND c.user_id = current_setting('app.current_user_id', true)));

        ALTER TABLE merge_dismissals ENABLE ROW LEVEL SECURITY;
        ALTER TABLE merge_dismissals FORCE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS rls_merge_dismissals_select ON merge_dismissals;
        DROP POLICY IF EXISTS rls_merge_dismissals_insert ON merge_dismissals;
        DROP POLICY IF EXISTS rls_merge_dismissals_update ON merge_dismissals;
        DROP POLICY IF EXISTS rls_merge_dismissals_delete ON merge_dismissals;
        CREATE POLICY rls_merge_dismissals_select ON merge_dismissals FOR SELECT USING (EXISTS (SELECT 1 FROM contacts c WHERE c.id = merge_dismissals.contact_id_1 AND c.user_id = current_setting('app.current_user_id', true)));
        CREATE POLICY rls_merge_dismissals_insert ON merge_dismissals FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM contacts c WHERE c.id = merge_dismissals.contact_id_1 AND c.user_id = current_setting('app.current_user_id', true)));
        CREATE POLICY rls_merge_dismissals_update ON merge_dismissals FOR UPDATE USING (EXISTS (SELECT 1 FROM contacts c WHERE c.id = merge_dismissals.contact_id_1 AND c.user_id = current_setting('app.current_user_id', true)));
        CREATE POLICY rls_merge_dismissals_delete ON merge_dismissals FOR DELETE USING (EXISTS (SELECT 1 FROM contacts c WHERE c.id = merge_dismissals.contact_id_1 AND c.user_id = current_setting('app.current_user_id', true)));
      `);
      this.logger.log('RLS policies applied on all user-owned tables');
    } finally {
      client.release();
    }
  }
}
