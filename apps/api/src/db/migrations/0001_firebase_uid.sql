ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "firebase_uid" text UNIQUE;
CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_firebase_uid" ON "users" ("firebase_uid");
