import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../../db/schema';

export function createTestDb(): BetterSQLite3Database<typeof schema> {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');

  sqlite.exec(`
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
  `);

  return drizzle(sqlite, { schema });
}
