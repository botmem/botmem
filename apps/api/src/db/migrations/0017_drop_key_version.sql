-- Remove key_version columns — all data now uses per-user DEK encryption only.
-- The keyVersion 0 (APP_SECRET) path is dead code since the DB wipe of 2026-03-09.
ALTER TABLE memories DROP COLUMN IF EXISTS key_version;
ALTER TABLE users DROP COLUMN IF EXISTS key_version;
