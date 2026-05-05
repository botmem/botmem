DROP INDEX IF EXISTS idx_memories_source_dedup;

CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_source_dedup
  ON memories (account_id, source_id, connector_type);
