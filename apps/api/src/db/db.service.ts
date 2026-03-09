import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { ConfigService } from '../config/config.service';
import * as schema from './schema';

@Injectable()
export class DbService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DbService.name);
  public db!: NodePgDatabase<typeof schema>;
  private pool!: Pool;

  constructor(private config: ConfigService) {}

  async onModuleInit() {
    this.pool = new Pool({
      connectionString: this.config.databaseUrl,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 30000,
    });

    this.db = drizzle(this.pool, { schema });
    await this.createTables();
    await this.dropLegacyTables();
    this.logger.log('PostgreSQL connected and tables ensured');
  }

  async onModuleDestroy() {
    await this.pool.end();
  }

  /** Health check: acquire client, run SELECT 1, release */
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

  private async createTables() {
    const client = await this.pool.connect();
    try {
      await client.query(`
        CREATE EXTENSION IF NOT EXISTS pg_trgm;

        CREATE TABLE IF NOT EXISTS accounts (
          id TEXT PRIMARY KEY,
          user_id TEXT,
          connector_type TEXT NOT NULL,
          identifier TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'disconnected',
          schedule TEXT NOT NULL DEFAULT 'manual',
          auth_context TEXT,
          last_cursor TEXT,
          last_sync_at TIMESTAMPTZ,
          items_synced INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          created_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL
        );

        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id),
          connector_type TEXT NOT NULL,
          account_identifier TEXT,
          status TEXT NOT NULL DEFAULT 'queued',
          priority INTEGER NOT NULL DEFAULT 0,
          progress INTEGER NOT NULL DEFAULT 0,
          total INTEGER NOT NULL DEFAULT 0,
          error TEXT,
          started_at TIMESTAMPTZ,
          completed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL
        );

        CREATE TABLE IF NOT EXISTS connector_credentials (
          connector_type TEXT PRIMARY KEY,
          credentials TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL
        );

        CREATE TABLE IF NOT EXISTS raw_events (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id),
          connector_type TEXT NOT NULL,
          source_id TEXT NOT NULL,
          source_type TEXT NOT NULL,
          payload TEXT NOT NULL,
          cleaned_text TEXT,
          timestamp TIMESTAMPTZ NOT NULL,
          job_id TEXT,
          created_at TIMESTAMPTZ NOT NULL
        );

        CREATE TABLE IF NOT EXISTS memories (
          id TEXT PRIMARY KEY,
          account_id TEXT REFERENCES accounts(id),
          memory_bank_id TEXT,
          connector_type TEXT NOT NULL,
          source_type TEXT NOT NULL,
          source_id TEXT NOT NULL,
          text TEXT NOT NULL,
          event_time TIMESTAMPTZ NOT NULL,
          ingest_time TIMESTAMPTZ NOT NULL,
          factuality JSONB NOT NULL DEFAULT '{"label":"UNVERIFIED","confidence":0.5,"rationale":"Pending evaluation"}',
          weights JSONB NOT NULL DEFAULT '{"semantic":0,"rerank":0,"recency":0,"importance":0.5,"trust":0.5,"final":0}',
          entities TEXT NOT NULL DEFAULT '[]',
          claims TEXT NOT NULL DEFAULT '[]',
          metadata TEXT NOT NULL DEFAULT '{}',
          embedding_status TEXT NOT NULL DEFAULT 'pending',
          pinned BOOLEAN NOT NULL DEFAULT false,
          recall_count INTEGER NOT NULL DEFAULT 0,
          enriched_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL
        );

        CREATE TABLE IF NOT EXISTS memory_links (
          id TEXT PRIMARY KEY,
          src_memory_id TEXT NOT NULL REFERENCES memories(id),
          dst_memory_id TEXT NOT NULL REFERENCES memories(id),
          link_type TEXT NOT NULL DEFAULT 'related',
          strength DOUBLE PRECISION NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL
        );

        CREATE TABLE IF NOT EXISTS contacts (
          id TEXT PRIMARY KEY,
          user_id TEXT,
          display_name TEXT NOT NULL,
          entity_type TEXT NOT NULL DEFAULT 'person',
          avatars JSONB NOT NULL DEFAULT '[]',
          metadata JSONB NOT NULL DEFAULT '{}',
          created_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL
        );

        CREATE TABLE IF NOT EXISTS contact_identifiers (
          id TEXT PRIMARY KEY,
          contact_id TEXT NOT NULL REFERENCES contacts(id),
          identifier_type TEXT NOT NULL,
          identifier_value TEXT NOT NULL,
          connector_type TEXT,
          confidence DOUBLE PRECISION NOT NULL DEFAULT 1.0,
          created_at TIMESTAMPTZ NOT NULL
        );

        CREATE TABLE IF NOT EXISTS memory_contacts (
          id TEXT PRIMARY KEY,
          memory_id TEXT NOT NULL REFERENCES memories(id),
          contact_id TEXT NOT NULL REFERENCES contacts(id),
          role TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS merge_dismissals (
          id TEXT PRIMARY KEY,
          contact_id_1 TEXT NOT NULL REFERENCES contacts(id),
          contact_id_2 TEXT NOT NULL REFERENCES contacts(id),
          created_at TIMESTAMPTZ NOT NULL
        );

        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          name TEXT NOT NULL,
          onboarded BOOLEAN NOT NULL DEFAULT false,
          created_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL
        );

        CREATE TABLE IF NOT EXISTS refresh_tokens (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id),
          token_hash TEXT NOT NULL,
          family TEXT NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          revoked_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL
        );

        CREATE TABLE IF NOT EXISTS password_resets (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id),
          token_hash TEXT NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          used_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL
        );

        CREATE TABLE IF NOT EXISTS memory_banks (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          name TEXT NOT NULL,
          is_default BOOLEAN NOT NULL DEFAULT false,
          created_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL
        );

        CREATE TABLE IF NOT EXISTS api_keys (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id),
          name TEXT NOT NULL,
          key_hash TEXT NOT NULL,
          last_four TEXT NOT NULL,
          memory_bank_ids TEXT,
          expires_at TIMESTAMPTZ,
          revoked_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL
        );
      `);

      // Indexes
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_accounts_user_id ON accounts(user_id);
        CREATE INDEX IF NOT EXISTS idx_contact_identifiers_contact_id ON contact_identifiers(contact_id);
        CREATE INDEX IF NOT EXISTS idx_contact_identifiers_value ON contact_identifiers(identifier_type, identifier_value);
        CREATE INDEX IF NOT EXISTS idx_memory_contacts_contact_id ON memory_contacts(contact_id);
        CREATE INDEX IF NOT EXISTS idx_memory_contacts_memory_id ON memory_contacts(memory_id);
        CREATE INDEX IF NOT EXISTS idx_merge_dismissals_pair ON merge_dismissals(contact_id_1, contact_id_2);
        CREATE INDEX IF NOT EXISTS idx_contacts_display_name ON contacts(display_name);
        CREATE INDEX IF NOT EXISTS idx_contacts_user_id ON contacts(user_id);
        CREATE INDEX IF NOT EXISTS idx_memories_embedding_status ON memories(embedding_status);
        CREATE INDEX IF NOT EXISTS idx_memories_event_time ON memories(event_time);
        CREATE INDEX IF NOT EXISTS idx_memories_connector_type ON memories(connector_type);
        CREATE INDEX IF NOT EXISTS idx_memories_memory_bank_id ON memories(memory_bank_id);
        CREATE INDEX IF NOT EXISTS idx_raw_events_source_id ON raw_events(source_id);
        CREATE INDEX IF NOT EXISTS idx_raw_events_job_id ON raw_events(job_id);
        CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);
        CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
        CREATE INDEX IF NOT EXISTS idx_memory_banks_user_id ON memory_banks(user_id);
      `);

      // Unique indexes
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_source_dedup ON memories(source_id, connector_type);
      `);

      // Partial unique index: only one default memory bank per user
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_banks_user_default ON memory_banks(user_id) WHERE is_default = true;
      `);

      // GIN indexes for full-text search (replaces SQLite FTS5)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_memories_fts ON memories USING gin (to_tsvector('english', text));
      `);

      // Trigram index for fuzzy matching
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_memories_trgm ON memories USING gin (text gin_trgm_ops);
      `);
    } finally {
      client.release();
    }
  }

  private async dropLegacyTables() {
    const client = await this.pool.connect();
    try {
      await client.query('DROP TABLE IF EXISTS logs CASCADE');
      this.logger.log('Legacy logs table dropped (now file-based)');
    } catch (err) {
      this.logger.warn(
        'Could not drop legacy logs table:',
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      client.release();
    }
  }
}
