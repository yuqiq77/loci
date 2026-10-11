CREATE EXTENSION IF NOT EXISTS "pgcrypto";--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "vector";--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('pending', 'running', 'complete', 'failed');--> statement-breakpoint
CREATE TYPE "public"."message_role" AS ENUM('user', 'assistant', 'system', 'tool');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('pending', 'streaming', 'complete', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "job_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(1536),
	"importance" real DEFAULT 0.5 NOT NULL,
	"valence" real DEFAULT 0 NOT NULL,
	"arousal" real DEFAULT 0 NOT NULL,
	"resolved" boolean DEFAULT false NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"source_session_id" uuid,
	"source_message_id" uuid,
	"content_hash" text NOT NULL,
	"recall_count" integer DEFAULT 0 NOT NULL,
	"last_recalled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "memories_importance_check" CHECK ("memories"."importance" >= 0 AND "memories"."importance" <= 1),
	CONSTRAINT "memories_valence_check" CHECK ("memories"."valence" >= -1 AND "memories"."valence" <= 1),
	CONSTRAINT "memories_arousal_check" CHECK ("memories"."arousal" >= 0 AND "memories"."arousal" <= 1)
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"role" "message_role" NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"status" "message_status" NOT NULL,
	"model_id" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"error_code" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text DEFAULT 'New chat' NOT NULL,
	"model_id" text NOT NULL,
	"summary" text,
	"summary_through_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" integer PRIMARY KEY NOT NULL,
	"system_prompt" text NOT NULL,
	"default_model_id" text NOT NULL,
	"temperature" real DEFAULT 0.7 NOT NULL,
	"max_output_tokens" integer DEFAULT 2048 NOT NULL,
	"context_token_budget" integer DEFAULT 32000 NOT NULL,
	"recent_message_budget" integer DEFAULT 16000 NOT NULL,
	"memory_token_budget" integer DEFAULT 2000 NOT NULL,
	"summary_trigger_tokens" integer DEFAULT 20000 NOT NULL,
	"memory_retrieval_limit" integer DEFAULT 5 NOT NULL,
	"timezone" text DEFAULT 'Europe/Zurich' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settings_single_row_check" CHECK ("settings"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_source_session_id_sessions_id_fk" FOREIGN KEY ("source_session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_summary_through_message_id_messages_id_fk" FOREIGN KEY ("summary_through_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_claim_idx" ON "jobs" USING btree ("status","available_at","created_at");--> statement-breakpoint
CREATE INDEX "memories_active_idx" ON "memories" USING btree ("updated_at" DESC NULLS LAST) WHERE "memories"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "memories_content_hash_idx" ON "memories" USING btree ("content_hash") WHERE "memories"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "messages_session_order_idx" ON "messages" USING btree ("session_id","created_at","id");--> statement-breakpoint
INSERT INTO "settings" (
	"id",
	"system_prompt",
	"default_model_id"
) VALUES (
	1,
	'You are a thoughtful, helpful private AI assistant.',
	'default'
);
