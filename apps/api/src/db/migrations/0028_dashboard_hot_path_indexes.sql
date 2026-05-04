CREATE INDEX IF NOT EXISTS idx_jobs_account_status_created
  ON jobs (account_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_people_person_memory
  ON memory_people (person_id, memory_id);
