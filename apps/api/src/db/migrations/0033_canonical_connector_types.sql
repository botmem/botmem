UPDATE accounts
SET connector_type = 'apple', updated_at = NOW()
WHERE connector_type = 'imessage';

UPDATE accounts
SET connector_type = 'photos', updated_at = NOW()
WHERE connector_type = 'photos-immich';

UPDATE jobs
SET connector_type = 'apple'
WHERE connector_type = 'imessage';

UPDATE jobs
SET connector_type = 'photos'
WHERE connector_type = 'photos-immich';

UPDATE raw_events
SET connector_type = 'apple'
WHERE connector_type = 'imessage';

UPDATE raw_events
SET connector_type = 'photos'
WHERE connector_type = 'photos-immich';

UPDATE memories
SET connector_type = 'apple'
WHERE connector_type = 'imessage';

UPDATE memories
SET connector_type = 'photos'
WHERE connector_type = 'photos-immich';

UPDATE memory_search_index
SET connector_type = 'apple', updated_at = NOW()
WHERE connector_type = 'imessage';

UPDATE memory_search_index
SET connector_type = 'photos', updated_at = NOW()
WHERE connector_type = 'photos-immich';
