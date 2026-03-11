ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "pipeline_complete" boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS "idx_memories_pipeline_complete" ON "memories" ("pipeline_complete");
