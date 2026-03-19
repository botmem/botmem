-- Catch-up migration: adds columns and tables that were added to 0000 after
-- initial apply, plus anything from 0007/0011 that drizzle skipped due to
-- timestamp ordering in the journal.
-- All statements are idempotent (IF NOT EXISTS / IF NOT EXISTS).

-- users: encryption_salt (replaces old encrypted_dek/dek_salt approach)
ALTER TABLE users ADD COLUMN IF NOT EXISTS encryption_salt text;

-- jobs: memory_bank_id
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS memory_bank_id text;

-- memories: memory_bank_id + search_tokens
ALTER TABLE memories ADD COLUMN IF NOT EXISTS memory_bank_id text;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS search_tokens tsvector;
CREATE INDEX IF NOT EXISTS idx_memories_search_tokens ON memories USING GIN (search_tokens);

-- oauth tables (from 0007)
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_secret TEXT,
  client_name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  grant_types TEXT NOT NULL,
  token_endpoint_auth_method TEXT DEFAULT 'none',
  scope TEXT DEFAULT 'read write',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  scope TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT DEFAULT 'S256',
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  used_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT UNIQUE NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  client_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  revoked_at TIMESTAMP WITH TIME ZONE
);
