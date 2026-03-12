ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "tunnel_mode" boolean NOT NULL DEFAULT true;
