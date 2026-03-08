import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { createCipheriv, randomBytes, scryptSync } from 'crypto';
import { ConfigService } from '../config/config.service';
import * as schema from './schema';

@Injectable()
export class DbService implements OnModuleInit {
  private readonly logger = new Logger(DbService.name);
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

      CREATE TABLE IF NOT EXISTS memory_banks (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        name TEXT NOT NULL,
        key_hash TEXT NOT NULL,
        last_four TEXT NOT NULL,
        memory_bank_ids TEXT,
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

    // Phase 19: Add userId to accounts
    try {
      this.sqlite.exec(`ALTER TABLE accounts ADD COLUMN user_id TEXT`);
    } catch { /* Column already exists */ }

    // Phase 19: Add userId to contacts
    try {
      this.sqlite.exec(`ALTER TABLE contacts ADD COLUMN user_id TEXT`);
    } catch { /* Column already exists */ }

    // Phase 19: Add memoryBankId to memories
    try {
      this.sqlite.exec(`ALTER TABLE memories ADD COLUMN memory_bank_id TEXT`);
    } catch { /* Column already exists */ }
    // Migration: rename bank_id to memory_bank_id if old column exists
    try {
      this.sqlite.exec(`ALTER TABLE memories RENAME COLUMN bank_id TO memory_bank_id`);
    } catch { /* Column already renamed or doesn't exist */ }

    // Migration: rename old 'banks' table to 'memory_banks' if it exists
    try {
      this.sqlite.exec(`ALTER TABLE banks RENAME TO memory_banks`);
    } catch { /* Table already renamed or doesn't exist */ }

    // Migration: rename bank_ids to memory_bank_ids in api_keys if old column exists
    try {
      this.sqlite.exec(`ALTER TABLE api_keys RENAME COLUMN bank_ids TO memory_bank_ids`);
    } catch { /* Column already renamed or doesn't exist */ }

    // Phase 19: Migrate existing data — assign all to first user + create default memory bank
    this.migrateUserOwnership();

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
      CREATE INDEX IF NOT EXISTS idx_accounts_user_id ON accounts(user_id);
      CREATE INDEX IF NOT EXISTS idx_contacts_user_id ON contacts(user_id);
      CREATE INDEX IF NOT EXISTS idx_memories_memory_bank_id ON memories(memory_bank_id);
      CREATE INDEX IF NOT EXISTS idx_memory_banks_user_id ON memory_banks(user_id);
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

    // Unique index on memory_banks per user
    try {
      this.sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_banks_user_default ON memory_banks(user_id, is_default) WHERE is_default = 1`);
    } catch { /* Best-effort */ }

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

    // Phase 20: Encrypt existing plaintext authContext and connectorCredentials
    this.migrateEncryption();

    // Transparent encryption at rest: encrypt existing plaintext memory fields
    this.migrateMemoryEncryption();
  }

  /**
   * Phase 19 migration: assign all existing accounts/contacts/memories to the
   * first user found, and create a default memory bank if none exists.
   * Idempotent — skips if already migrated.
   */
  private migrateUserOwnership() {
    const firstUser = this.sqlite.prepare('SELECT id FROM users LIMIT 1').get() as { id: string } | undefined;
    if (!firstUser) return; // No users yet — nothing to migrate

    const userId = firstUser.id;

    // Assign unowned accounts to this user
    this.sqlite.prepare('UPDATE accounts SET user_id = ? WHERE user_id IS NULL').run(userId);

    // Assign unowned contacts to this user
    this.sqlite.prepare('UPDATE contacts SET user_id = ? WHERE user_id IS NULL').run(userId);

    // Create default memory bank if user doesn't have one
    const existingBank = this.sqlite.prepare('SELECT id FROM memory_banks WHERE user_id = ? AND is_default = 1').get(userId) as { id: string } | undefined;
    let defaultMemoryBankId: string;
    if (!existingBank) {
      defaultMemoryBankId = crypto.randomUUID();
      const now = new Date().toISOString();
      this.sqlite.prepare(
        'INSERT INTO memory_banks (id, user_id, name, is_default, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)',
      ).run(defaultMemoryBankId, userId, 'Default', now, now);
      this.logger.log(`[migration] Created default memory bank ${defaultMemoryBankId} for user ${userId}`);
    } else {
      defaultMemoryBankId = existingBank.id;
    }

    // Assign memories without a memory bank to the default
    const result = this.sqlite.prepare('UPDATE memories SET memory_bank_id = ? WHERE memory_bank_id IS NULL').run(defaultMemoryBankId);
    if ((result as any).changes > 0) {
      this.logger.log(`[migration] Assigned ${(result as any).changes} memories to default memory bank`);
    }
  }

  /**
   * Phase 20 migration: encrypt existing plaintext authContext on accounts
   * and credentials on connector_credentials using AES-256-GCM.
   * Idempotent — skips rows that are already encrypted (iv:data:tag format).
   */
  private migrateEncryption() {
    const ALGORITHM = 'aes-256-gcm';
    const IV_LENGTH = 12;
    const TAG_LENGTH = 16;
    const SALT = 'botmem-enc-v1';
    const secret = this.config.appSecret;
    const key = scryptSync(secret, SALT, 32);

    const encrypt = (plaintext: string): string => {
      const iv = randomBytes(IV_LENGTH);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `${iv.toString('base64')}:${encrypted.toString('base64')}:${tag.toString('base64')}`;
    };

    const isEncrypted = (value: string): boolean => {
      const parts = value.split(':');
      if (parts.length !== 3) return false;
      try {
        const iv = Buffer.from(parts[0], 'base64');
        const tag = Buffer.from(parts[2], 'base64');
        return iv.length === IV_LENGTH && tag.length === TAG_LENGTH;
      } catch {
        return false;
      }
    };

    // Encrypt authContext on accounts
    const accountRows = this.sqlite.prepare(
      "SELECT id, auth_context FROM accounts WHERE auth_context IS NOT NULL AND auth_context != ''",
    ).all() as Array<{ id: string; auth_context: string }>;

    let encAccounts = 0;
    const updateAccount = this.sqlite.prepare('UPDATE accounts SET auth_context = ? WHERE id = ?');
    for (const row of accountRows) {
      if (isEncrypted(row.auth_context)) continue;
      updateAccount.run(encrypt(row.auth_context), row.id);
      encAccounts++;
    }
    if (encAccounts > 0) {
      this.logger.log(`[migration] Encrypted authContext on ${encAccounts} accounts`);
    }

    // Encrypt credentials on connector_credentials
    const credRows = this.sqlite.prepare(
      "SELECT connector_type, credentials FROM connector_credentials WHERE credentials IS NOT NULL AND credentials != ''",
    ).all() as Array<{ connector_type: string; credentials: string }>;

    let encCreds = 0;
    const updateCred = this.sqlite.prepare('UPDATE connector_credentials SET credentials = ? WHERE connector_type = ?');
    for (const row of credRows) {
      if (isEncrypted(row.credentials)) continue;
      updateCred.run(encrypt(row.credentials), row.connector_type);
      encCreds++;
    }
    if (encCreds > 0) {
      this.logger.log(`[migration] Encrypted credentials on ${encCreds} connector_credentials rows`);
    }
  }

  /**
   * Encrypt existing plaintext memory fields (text, entities, claims, metadata)
   * with AES-256-GCM using APP_SECRET. Idempotent — skips already-encrypted rows.
   */
  private migrateMemoryEncryption() {
    const ALGORITHM = 'aes-256-gcm';
    const IV_LENGTH = 12;
    const TAG_LENGTH = 16;
    const SALT = 'botmem-enc-v1';
    const secret = this.config.appSecret;
    const key = scryptSync(secret, SALT, 32);

    const encrypt = (plaintext: string): string => {
      const iv = randomBytes(IV_LENGTH);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `${iv.toString('base64')}:${encrypted.toString('base64')}:${tag.toString('base64')}`;
    };

    const isEncrypted = (value: string): boolean => {
      if (!value) return false;
      // Old e2ee: prefix format — treat as needing re-encryption
      if (value.startsWith('e2ee:')) return false;
      const parts = value.split(':');
      if (parts.length !== 3) return false;
      try {
        const iv = Buffer.from(parts[0], 'base64');
        const tag = Buffer.from(parts[2], 'base64');
        return iv.length === IV_LENGTH && tag.length === TAG_LENGTH;
      } catch {
        return false;
      }
    };

    const BATCH = 500;
    let total = 0;
    const update = this.sqlite.prepare(
      'UPDATE memories SET text = ?, entities = ?, claims = ?, metadata = ? WHERE id = ?',
    );

    while (true) {
      // Find memories where text is not yet encrypted
      const batch = this.sqlite.prepare(
        "SELECT id, text, entities, claims, metadata FROM memories WHERE embedding_status = 'done' LIMIT ?",
      ).all(BATCH) as Array<{ id: string; text: string; entities: string; claims: string; metadata: string }>;

      if (!batch.length) break;

      // Filter to only unencrypted rows
      const unencrypted = batch.filter((row) => !isEncrypted(row.text));
      if (!unencrypted.length) break;

      for (const row of unencrypted) {
        update.run(
          encrypt(row.text),
          encrypt(row.entities),
          encrypt(row.claims),
          encrypt(row.metadata),
          row.id,
        );
      }
      total += unencrypted.length;

      // If all rows in this batch were already encrypted, we're done
      if (unencrypted.length < batch.length) break;
    }

    if (total > 0) {
      this.logger.log(`[migration] Encrypted ${total} memory fields at rest`);
    }
  }
}
