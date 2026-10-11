CREATE TABLE "memory_extraction_backfill_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_key" text NOT NULL,
	"session_id" uuid NOT NULL,
	"segment" integer NOT NULL,
	"path" text NOT NULL,
	"from_message_id" uuid,
	"through_message_id" uuid NOT NULL,
	"exchange_count" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_output_tokens" integer NOT NULL,
	"candidate_count" integer DEFAULT 0 NOT NULL,
	"written_count" integer DEFAULT 0 NOT NULL,
	"deduped_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "memory_extraction_backfill_windows_status_check" CHECK ("memory_extraction_backfill_windows"."status" in ('pending', 'running', 'complete', 'failed', 'split')),
	CONSTRAINT "memory_extraction_backfill_windows_exchange_count_check" CHECK ("memory_extraction_backfill_windows"."exchange_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "memory_extraction_backfill_windows" ADD CONSTRAINT "memory_extraction_backfill_windows_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_extraction_backfill_windows_run_path_idx" ON "memory_extraction_backfill_windows" USING btree ("run_key","segment","path");--> statement-breakpoint
CREATE INDEX "memory_extraction_backfill_windows_run_status_idx" ON "memory_extraction_backfill_windows" USING btree ("run_key","status","segment","path");