ALTER TABLE raw_events ADD COLUMN IF NOT EXISTS processing_state text NOT NULL DEFAULT 'pending';

CREATE INDEX IF NOT EXISTS idx_raw_events_processing_state ON raw_events (processing_state);

