CREATE TYPE "public"."tool_run_status" AS ENUM('staged', 'committed', 'retracted', 'superseded');--> statement-breakpoint
CREATE TABLE "tool_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"assistant_message_id" uuid NOT NULL,
	"round_index" integer NOT NULL,
	"call_index" integer NOT NULL,
	"provider_tool_use_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"tool_schema_hash" text,
	"input" jsonb,
	"result_content" text,
	"is_error" boolean DEFAULT false NOT NULL,
	"error_code" text,
	"preceding_text" text,
	"status" "tool_run_status" DEFAULT 'staged' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tool_runs" ADD CONSTRAINT "tool_runs_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tool_runs_attempt_tool_use_idx" ON "tool_runs" USING btree ("attempt_id","provider_tool_use_id");--> statement-breakpoint
CREATE INDEX "tool_runs_attempt_order_idx" ON "tool_runs" USING btree ("attempt_id","round_index","call_index");--> statement-breakpoint
CREATE INDEX "tool_runs_assistant_message_idx" ON "tool_runs" USING btree ("assistant_message_id");--> statement-breakpoint
CREATE INDEX "tool_runs_session_created_idx" ON "tool_runs" USING btree ("session_id","created_at");