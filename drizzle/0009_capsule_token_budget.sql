ALTER TABLE "settings" ALTER COLUMN "recent_snapshot_token_budget" SET DEFAULT 400;--> statement-breakpoint
UPDATE "settings" SET "recent_snapshot_token_budget" = 400 WHERE "recent_snapshot_token_budget" = 300;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "capsule_token_budget" integer DEFAULT 2000 NOT NULL;
