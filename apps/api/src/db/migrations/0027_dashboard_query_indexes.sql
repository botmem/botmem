CREATE INDEX IF NOT EXISTS idx_memory_search_user_connector
  ON memory_search_index (user_id, connector_type);

CREATE INDEX IF NOT EXISTS idx_memory_search_user_source
  ON memory_search_index (user_id, source_type);

CREATE INDEX IF NOT EXISTS idx_memory_search_user_factuality
  ON memory_search_index (user_id, factuality_label);

CREATE INDEX IF NOT EXISTS idx_memory_search_user_bank
  ON memory_search_index (user_id, memory_bank_id);

CREATE INDEX IF NOT EXISTS idx_memory_search_user_event_time
  ON memory_search_index (user_id, event_time);

CREATE INDEX IF NOT EXISTS idx_memory_search_account_people
  ON memory_search_index (account_id, memory_id);
