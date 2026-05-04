CREATE INDEX IF NOT EXISTS idx_jobs_account_id ON jobs (account_id);

CREATE INDEX IF NOT EXISTS idx_raw_events_account_id ON raw_events (account_id);

CREATE INDEX IF NOT EXISTS idx_raw_events_account_timestamp ON raw_events (account_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_memories_account_id ON memories (account_id);

CREATE INDEX IF NOT EXISTS idx_memories_done_account_connector
  ON memories (account_id, connector_type)
  WHERE pipeline_complete = true;

CREATE INDEX IF NOT EXISTS idx_memories_done_account_source
  ON memories (account_id, source_type)
  WHERE pipeline_complete = true;

CREATE INDEX IF NOT EXISTS idx_memories_done_account_factuality
  ON memories (account_id, factuality_label)
  WHERE pipeline_complete = true;

CREATE INDEX IF NOT EXISTS idx_memories_done_account_event_time
  ON memories (account_id, event_time DESC)
  WHERE pipeline_complete = true;
