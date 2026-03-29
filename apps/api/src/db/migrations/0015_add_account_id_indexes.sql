-- Add missing accountId indexes for fast cascading deletes
CREATE INDEX IF NOT EXISTS idx_jobs_account_id ON jobs (account_id);
CREATE INDEX IF NOT EXISTS idx_raw_events_account_id ON raw_events (account_id);
CREATE INDEX IF NOT EXISTS idx_memories_account_id ON memories (account_id);
