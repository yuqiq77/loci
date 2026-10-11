ALTER TABLE "settings" ALTER COLUMN "tools_enabled" SET DEFAULT true;--> statement-breakpoint
UPDATE "settings" SET "tools_enabled" = true WHERE "id" = 1;
