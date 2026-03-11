ALTER TABLE "memories" ADD COLUMN "pipeline_complete" boolean NOT NULL DEFAULT false;
CREATE INDEX "idx_memories_pipeline_complete" ON "memories" ("pipeline_complete");
