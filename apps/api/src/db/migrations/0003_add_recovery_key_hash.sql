-- Add recovery_key_hash column for E2EE recovery key verification
ALTER TABLE "users" ADD COLUMN "recovery_key_hash" text;

-- Remove old DEK wrapping columns (no longer needed with recovery key approach)
ALTER TABLE "users" DROP COLUMN IF EXISTS "wrapped_dek";
ALTER TABLE "users" DROP COLUMN IF EXISTS "wrapped_dek_app";
