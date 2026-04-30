CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE raw_events ADD COLUMN IF NOT EXISTS source_hash text;

WITH ranked AS (
  SELECT
    id,
    encode(digest(account_id || ':' || connector_type || ':' || source_id, 'sha256'), 'hex') AS hash,
    row_number() OVER (
      PARTITION BY account_id, connector_type, source_id
      ORDER BY
        CASE WHEN source_hash IS NOT NULL THEN 0 ELSE 1 END,
        created_at ASC,
        id ASC
    ) AS rn
  FROM raw_events
)
UPDATE raw_events re
SET source_hash = ranked.hash
FROM ranked
WHERE re.id = ranked.id
  AND ranked.rn = 1
  AND re.source_hash IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_events_source_hash
  ON raw_events (source_hash);
