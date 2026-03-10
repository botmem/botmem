CREATE TABLE IF NOT EXISTS "llm_cache" (
  "id" text PRIMARY KEY NOT NULL,
  "input_hash" text NOT NULL,
  "model" text NOT NULL,
  "backend" text NOT NULL,
  "operation" text NOT NULL,
  "input" text NOT NULL,
  "output" text NOT NULL,
  "input_tokens" integer,
  "output_tokens" integer,
  "latency_ms" integer,
  "created_at" timestamp with time zone DEFAULT now()
);
