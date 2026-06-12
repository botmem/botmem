ALTER TABLE settings ADD COLUMN IF NOT EXISTS user_id text;

UPDATE settings
SET user_id = '__system__'
WHERE user_id IS NULL;

ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_pkey;

UPDATE settings
SET user_id = split_part(key, ':', 2),
    key = split_part(key, ':', 1)
WHERE user_id = '__system__'
  AND (key LIKE 'selfContactId:%' OR key LIKE 'selfPersonId:%');

ALTER TABLE settings ALTER COLUMN user_id SET NOT NULL;

ALTER TABLE settings ADD CONSTRAINT settings_pkey PRIMARY KEY (user_id, key);
