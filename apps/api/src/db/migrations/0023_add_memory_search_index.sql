CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS memory_search_index (
  memory_id text PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  account_id text,
  memory_bank_id text,
  connector_type text NOT NULL,
  source_type text NOT NULL,
  event_time timestamptz NOT NULL,
  factuality_label text,
  pinned boolean NOT NULL DEFAULT false,
  importance double precision NOT NULL DEFAULT 0.5,
  recall_count integer NOT NULL DEFAULT 0,
  text text NOT NULL DEFAULT '',
  entities_text text NOT NULL DEFAULT '',
  people jsonb NOT NULL DEFAULT '[]'::jsonb,
  person_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  person_aliases jsonb NOT NULL DEFAULT '[]'::jsonb,
  locations jsonb NOT NULL DEFAULT '[]'::jsonb,
  location_text text NOT NULL DEFAULT '',
  organizations jsonb NOT NULL DEFAULT '[]'::jsonb,
  thread_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  transaction_tokens jsonb NOT NULL DEFAULT '[]'::jsonb,
  search_tokens tsvector NOT NULL,
  embedding vector,
  embedding_dimension integer,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_memory_search_user_id ON memory_search_index (user_id);
CREATE INDEX IF NOT EXISTS idx_memory_search_account_id ON memory_search_index (account_id);
CREATE INDEX IF NOT EXISTS idx_memory_search_memory_bank_id ON memory_search_index (memory_bank_id);
CREATE INDEX IF NOT EXISTS idx_memory_search_event_time ON memory_search_index (event_time);
CREATE INDEX IF NOT EXISTS idx_memory_search_connector_type ON memory_search_index (connector_type);
CREATE INDEX IF NOT EXISTS idx_memory_search_source_type ON memory_search_index (source_type);
CREATE INDEX IF NOT EXISTS idx_memory_search_factuality_label ON memory_search_index (factuality_label);
CREATE INDEX IF NOT EXISTS idx_memory_search_tokens ON memory_search_index USING GIN (search_tokens);
