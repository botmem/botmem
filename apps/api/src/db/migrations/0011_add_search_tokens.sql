-- Add search_tokens tsvector column to memories for FTS on encrypted text.
-- The column is populated from plaintext BEFORE encryption happens,
-- so full-text search works even though memories.text is AES-256-GCM ciphertext.
ALTER TABLE memories ADD COLUMN IF NOT EXISTS search_tokens tsvector;

-- GIN index for fast full-text search on pre-computed tsvector
CREATE INDEX IF NOT EXISTS idx_memories_search_tokens ON memories USING GIN (search_tokens);
