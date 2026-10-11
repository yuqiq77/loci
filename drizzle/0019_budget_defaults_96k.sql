ALTER TABLE "settings" ALTER COLUMN "context_token_budget" SET DEFAULT 96000;--> statement-breakpoint
ALTER TABLE "settings" ALTER COLUMN "recent_message_budget" SET DEFAULT 48000;--> statement-breakpoint
ALTER TABLE "settings" ALTER COLUMN "summary_trigger_tokens" SET DEFAULT 72000;--> statement-breakpoint
-- Move only the shipped 32k/16k/20k trio: those defaults could not seat a
-- full unsummarized history beside the capsule (the no-blind-spot rule the
-- settings schema now refuses). A row with any of the three set by hand is
-- left alone, even one the rule refuses: the settings page then names the
-- exact shortfall on its next save, and the window is raised there.
UPDATE "settings" SET "context_token_budget" = 96000, "recent_message_budget" = 48000, "summary_trigger_tokens" = 72000 WHERE "context_token_budget" = 32000 AND "recent_message_budget" = 16000 AND "summary_trigger_tokens" = 20000;