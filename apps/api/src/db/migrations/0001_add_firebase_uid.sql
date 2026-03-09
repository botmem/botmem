ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "firebase_uid" text;
ALTER TABLE "users" ADD CONSTRAINT "users_firebase_uid_unique" UNIQUE("firebase_uid");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_firebase_uid" ON "users" USING btree ("firebase_uid");
