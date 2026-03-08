import { Injectable, OnModuleInit } from '@nestjs/common';
import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { ConfigService } from '../config/config.service';
import * as schema from './schema';

@Injectable()
export class DbService implements OnModuleInit {
  public db!: BetterSQLite3Database<typeof schema>;
  public sqlite!: Database.Database;

  constructor(private config: ConfigService) {}

  onModuleInit() {
    const dbPath = this.config.dbPath;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.sqlite = new Database(dbPath);
    this.sqlite.pragma('journal_mode = WAL');
    this.db = drizzle(this.sqlite, { schema });
    this.createTables();
  }

  private createTables() {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        connector_type TEXT NOT NULL,
        identifier TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'disconnected',
        schedule TEXT NOT NULL DEFAULT 'manual',
        auth_context TEXT,
        last_cursor TEXT,
        last_sync_at TEXT,
        items_synced INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
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
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS logs (
        id TEXT PRIMARY KEY,
        job_id TEXT,
        connector_type TEXT NOT NULL,
        account_id TEXT,
        stage TEXT,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        timestamp TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS connector_credentials (
        connector_type TEXT PRIMARY KEY,
        credentials TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS raw_events (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        connector_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        job_id TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        account_id TEXT REFERENCES accounts(id),
        connector_type TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        text TEXT NOT NULL,
        event_time TEXT NOT NULL,
        ingest_time TEXT NOT NULL,
        factuality TEXT NOT NULL DEFAULT '{"label":"UNVERIFIED","confidence":0.5,"rationale":"Pending evaluation"}',
        weights TEXT NOT NULL DEFAULT '{"semantic":0,"rerank":0,"recency":0,"importance":0.5,"trust":0.5,"final":0}',
        entities TEXT NOT NULL DEFAULT '[]',
        claims TEXT NOT NULL DEFAULT '[]',
        metadata TEXT NOT NULL DEFAULT '{}',
        embedding_status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_links (
        id TEXT PRIMARY KEY,
        src_memory_id TEXT NOT NULL REFERENCES memories(id),
        dst_memory_id TEXT NOT NULL REFERENCES memories(id),
        link_type TEXT NOT NULL DEFAULT 'related',
        strength REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        avatars TEXT NOT NULL DEFAULT '[]',
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS contact_identifiers (
        id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL REFERENCES contacts(id),
        identifier_type TEXT NOT NULL,
        identifier_value TEXT NOT NULL,
        connector_type TEXT,
        confidence REAL NOT NULL DEFAULT 1.0,
        created_at TEXT NOT NULL
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
        created_at TEXT NOT NULL
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
        onboarded INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        token_hash TEXT NOT NULL,
        family TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS password_resets (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        token_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        name TEXT NOT NULL,
        key_hash TEXT NOT NULL,
        last_four TEXT NOT NULL,
        bank_ids TEXT,
        expires_at TEXT,
        revoked_at TEXT,
        created_at TEXT NOT NULL
      );
    `);

    // Migrations for existing databases
    try {
      this.sqlite.exec(`ALTER TABLE logs ADD COLUMN stage TEXT`);
    } catch {
      // Column already exists
    }
    try {
      this.sqlite.exec(`ALTER TABLE contacts ADD COLUMN avatars TEXT NOT NULL DEFAULT '[]'`);
    } catch {
      // Column already exists
    }
    try {
      this.sqlite.exec(`
        UPDATE contacts SET avatars = json_array(json_object('url', avatar_url, 'source', 'unknown'))
        WHERE avatar_url IS NOT NULL AND avatar_url != '' AND (avatars = '[]' OR avatars IS NULL)
      `);
    } catch {
      // Migration already applied or avatar_url doesn't exist
    }

    try {
      this.sqlite.exec(`ALTER TABLE raw_events ADD COLUMN cleaned_text TEXT`);
    } catch {
      // Column already exists
    }

    // Indexes for performance
    this.sqlite.exec(`
      CREATE INDEX IF NOT EXISTS idx_contact_identifiers_contact_id ON contact_identifiers(contact_id);
      CREATE INDEX IF NOT EXISTS idx_contact_identifiers_value ON contact_identifiers(identifier_type, identifier_value);
      CREATE INDEX IF NOT EXISTS idx_memory_contacts_contact_id ON memory_contacts(contact_id);
      CREATE INDEX IF NOT EXISTS idx_memory_contacts_memory_id ON memory_contacts(memory_id);
      CREATE INDEX IF NOT EXISTS idx_merge_dismissals_pair ON merge_dismissals(contact_id_1, contact_id_2);
      CREATE INDEX IF NOT EXISTS idx_contacts_display_name ON contacts(display_name);
      CREATE INDEX IF NOT EXISTS idx_memories_embedding_status ON memories(embedding_status);
      CREATE INDEX IF NOT EXISTS idx_memories_event_time ON memories(event_time);
      CREATE INDEX IF NOT EXISTS idx_memories_connector_type ON memories(connector_type);
      CREATE INDEX IF NOT EXISTS idx_raw_events_source_id ON raw_events(source_id);
      CREATE INDEX IF NOT EXISTS idx_raw_events_job_id ON raw_events(job_id);
      CREATE INDEX IF NOT EXISTS idx_logs_job_id ON logs(job_id);
      CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);
      CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
    `);

    // FTS5 full-text search index on memories.text (standalone, not content-sync)
    // Drop old content-sync FTS table if it exists (migration from content='memories' to standalone)
    try {
      const ftsSchema = this.sqlite.prepare("SELECT sql FROM sqlite_master WHERE name = 'memories_fts'").get() as any;
      if (ftsSchema?.sql?.includes("content='memories'")) {
        this.sqlite.exec('DROP TABLE IF EXISTS memories_fts');
      }
    } catch { /* ignore */ }
    this.sqlite.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        id UNINDEXED,
        text,
        tokenize='unicode61 remove_diacritics 2'
      );
    `);
    // Populate FTS if empty or significantly behind (first run or rebuild)
    try {
      const ftsCount = this.sqlite.prepare('SELECT COUNT(*) as c FROM memories_fts').get() as any;
      const memCount = this.sqlite.prepare('SELECT COUNT(*) as c FROM memories WHERE embedding_status = ?').get('done') as any;
      if ((ftsCount?.c ?? 0) < (memCount?.c ?? 0) * 0.8) {
        this.sqlite.exec(`DELETE FROM memories_fts`);
        this.sqlite.exec(`
          INSERT INTO memories_fts(id, text)
            SELECT id, text FROM memories WHERE embedding_status = 'done'
        `);
      }
    } catch { /* FTS rebuild is best-effort */ }

    // Triggers to keep FTS in sync
    try {
      this.sqlite.exec(`DROP TRIGGER IF EXISTS memories_fts_insert`);
      this.sqlite.exec(`DROP TRIGGER IF EXISTS memories_fts_update`);
      this.sqlite.exec(`DROP TRIGGER IF EXISTS memories_fts_delete`);
      this.sqlite.exec(`
        CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories
          WHEN NEW.embedding_status = 'done'
        BEGIN
          INSERT INTO memories_fts(id, text) VALUES (NEW.id, NEW.text);
        END
      `);
      this.sqlite.exec(`
        CREATE TRIGGER memories_fts_update AFTER UPDATE OF embedding_status ON memories
          WHEN NEW.embedding_status = 'done' AND OLD.embedding_status != 'done'
        BEGIN
          INSERT INTO memories_fts(id, text) VALUES (NEW.id, NEW.text);
        END
      `);
      this.sqlite.exec(`
        CREATE TRIGGER memories_fts_delete AFTER DELETE ON memories
        BEGIN
          DELETE FROM memories_fts WHERE id = OLD.id;
        END
      `);
    } catch { /* Triggers are best-effort */ }

    // Unique index on memories(source_id, connector_type) for dedup enforcement
    try {
      this.sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_source_dedup ON memories(source_id, connector_type)`);
    } catch {
      // Index may conflict with existing duplicates — clean up first
      try {
        this.sqlite.exec(`
          DELETE FROM memories WHERE rowid NOT IN (
            SELECT MIN(rowid) FROM memories GROUP BY source_id, connector_type
          )
        `);
        this.sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_source_dedup ON memories(source_id, connector_type)`);
      } catch {
        // Best-effort — app-level dedup will still work
      }
    }
  }
}
