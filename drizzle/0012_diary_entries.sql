CREATE TABLE "diary_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_date" date NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "diary_entries_entry_date_unique" UNIQUE("entry_date")
);
--> statement-breakpoint
CREATE TABLE "diary_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"epoch" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "diary_state_single_row_check" CHECK ("diary_state"."id" = 1)
);
--> statement-breakpoint
CREATE INDEX "messages_completed_at_idx" ON "messages" USING btree ("completed_at") WHERE "messages"."status" = 'complete';--> statement-breakpoint
ALTER TABLE "settings" DROP COLUMN "timezone";--> statement-breakpoint
INSERT INTO "diary_state" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING;