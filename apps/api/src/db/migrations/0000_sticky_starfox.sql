CREATE TABLE IF NOT EXISTS "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"connector_type" text NOT NULL,
	"identifier" text NOT NULL,
	"status" text DEFAULT 'disconnected' NOT NULL,
	"schedule" text DEFAULT 'manual' NOT NULL,
	"auth_context" text,
	"last_cursor" text,
	"last_sync_at" timestamp with time zone,
	"items_synced" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"last_four" text NOT NULL,
	"memory_bank_ids" text,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "connector_credentials" (
	"connector_type" text PRIMARY KEY NOT NULL,
	"credentials" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contact_identifiers" (
	"id" text PRIMARY KEY NOT NULL,
	"contact_id" text NOT NULL,
	"identifier_type" text NOT NULL,
	"identifier_value" text NOT NULL,
	"connector_type" text,
	"confidence" double precision DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contacts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"display_name" text NOT NULL,
	"entity_type" text DEFAULT 'person' NOT NULL,
	"avatars" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"connector_type" text NOT NULL,
	"account_identifier" text,
	"memory_bank_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "memories" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text,
	"memory_bank_id" text,
	"connector_type" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"text" text NOT NULL,
	"event_time" timestamp with time zone NOT NULL,
	"ingest_time" timestamp with time zone NOT NULL,
	"factuality" jsonb DEFAULT '{"label":"UNVERIFIED","confidence":0.5,"rationale":"Pending evaluation"}'::jsonb NOT NULL,
	"weights" jsonb DEFAULT '{"semantic":0,"rerank":0,"recency":0,"importance":0.5,"trust":0.5,"final":0}'::jsonb NOT NULL,
	"entities" text DEFAULT '[]' NOT NULL,
	"claims" text DEFAULT '[]' NOT NULL,
	"metadata" text DEFAULT '{}' NOT NULL,
	"embedding_status" text DEFAULT 'pending' NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"recall_count" integer DEFAULT 0 NOT NULL,
	"key_version" integer DEFAULT 0 NOT NULL,
	"enriched_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "memory_banks" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "memory_contacts" (
	"id" text PRIMARY KEY NOT NULL,
	"memory_id" text NOT NULL,
	"contact_id" text NOT NULL,
	"role" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "memory_links" (
	"id" text PRIMARY KEY NOT NULL,
	"src_memory_id" text NOT NULL,
	"dst_memory_id" text NOT NULL,
	"link_type" text DEFAULT 'related' NOT NULL,
	"strength" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "merge_dismissals" (
	"id" text PRIMARY KEY NOT NULL,
	"contact_id_1" text NOT NULL,
	"contact_id_2" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "password_resets" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "raw_events" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"connector_type" text NOT NULL,
	"source_id" text NOT NULL,
	"source_type" text NOT NULL,
	"payload" text NOT NULL,
	"cleaned_text" text,
	"timestamp" timestamp with time zone NOT NULL,
	"job_id" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "refresh_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"family" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"name" text NOT NULL,
	"onboarded" boolean DEFAULT false NOT NULL,
	"encryption_salt" text,
	"key_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "contact_identifiers" ADD CONSTRAINT "contact_identifiers_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "jobs" ADD CONSTRAINT "jobs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "memories" ADD CONSTRAINT "memories_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "memory_contacts" ADD CONSTRAINT "memory_contacts_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "memory_contacts" ADD CONSTRAINT "memory_contacts_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "memory_links" ADD CONSTRAINT "memory_links_src_memory_id_memories_id_fk" FOREIGN KEY ("src_memory_id") REFERENCES "public"."memories"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "memory_links" ADD CONSTRAINT "memory_links_dst_memory_id_memories_id_fk" FOREIGN KEY ("dst_memory_id") REFERENCES "public"."memories"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "merge_dismissals" ADD CONSTRAINT "merge_dismissals_contact_id_1_contacts_id_fk" FOREIGN KEY ("contact_id_1") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "merge_dismissals" ADD CONSTRAINT "merge_dismissals_contact_id_2_contacts_id_fk" FOREIGN KEY ("contact_id_2") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "raw_events" ADD CONSTRAINT "raw_events_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_accounts_user_id" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_api_keys_user_id" ON "api_keys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_api_keys_hash" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_contact_identifiers_contact_id" ON "contact_identifiers" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_contact_identifiers_value" ON "contact_identifiers" USING btree ("identifier_type","identifier_value");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_contacts_display_name" ON "contacts" USING btree ("display_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_contacts_user_id" ON "contacts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_memories_embedding_status" ON "memories" USING btree ("embedding_status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_memories_event_time" ON "memories" USING btree ("event_time");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_memories_connector_type" ON "memories" USING btree ("connector_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_memories_memory_bank_id" ON "memories" USING btree ("memory_bank_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_memories_source_dedup" ON "memories" USING btree ("source_id","connector_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_memory_banks_user_id" ON "memory_banks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_memory_contacts_contact_id" ON "memory_contacts" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_memory_contacts_memory_id" ON "memory_contacts" USING btree ("memory_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_merge_dismissals_pair" ON "merge_dismissals" USING btree ("contact_id_1","contact_id_2");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_raw_events_source_id" ON "raw_events" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_raw_events_job_id" ON "raw_events" USING btree ("job_id");--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_memories_fts" ON "memories" USING gin (to_tsvector('english', "text"));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_memories_trgm" ON "memories" USING gin ("text" gin_trgm_ops);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_memory_banks_user_default" ON "memory_banks" USING btree ("user_id") WHERE "is_default" = true;

--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "encryption_salt" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "key_version" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "key_version" integer DEFAULT 0 NOT NULL;
