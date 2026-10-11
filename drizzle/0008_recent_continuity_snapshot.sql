CREATE TABLE "recent_continuity_snapshot" (
	"id" integer PRIMARY KEY NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_window_start" timestamp with time zone,
	"source_window_end" timestamp with time zone,
	"source_summary_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_memory_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"stale_after" timestamp with time zone,
	CONSTRAINT "recent_continuity_snapshot_single_row_check" CHECK ("recent_continuity_snapshot"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "recent_snapshot_token_budget" integer DEFAULT 300 NOT NULL;
