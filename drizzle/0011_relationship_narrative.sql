CREATE TABLE "relationship_narrative" (
	"id" integer PRIMARY KEY NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consolidated_through" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relationship_narrative_single_row_check" CHECK ("relationship_narrative"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "relationship_narrative_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content" text NOT NULL,
	"version" integer NOT NULL,
	"mode" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "relationship_narrative_versions_version_idx" ON "relationship_narrative_versions" USING btree ("version" DESC NULLS LAST);--> statement-breakpoint
INSERT INTO "relationship_narrative" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING;
