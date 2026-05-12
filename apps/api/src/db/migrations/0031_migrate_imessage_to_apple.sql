UPDATE accounts
SET connector_type = 'apple', updated_at = NOW()
WHERE connector_type = 'imessage';

UPDATE jobs
SET connector_type = 'apple'
WHERE connector_type = 'imessage';

UPDATE raw_events
SET connector_type = 'apple'
WHERE connector_type = 'imessage';

UPDATE memories
SET connector_type = 'apple'
WHERE connector_type = 'imessage';

UPDATE memory_search_index
SET connector_type = 'apple', updated_at = NOW()
WHERE connector_type = 'imessage';
