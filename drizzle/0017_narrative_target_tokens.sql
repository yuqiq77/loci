ALTER TABLE "settings" ALTER COLUMN "capsule_token_budget" SET DEFAULT 12000;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "narrative_target_tokens" integer DEFAULT 6400 NOT NULL;--> statement-breakpoint
-- MC-121: the capsule is now a read limit that must seat every section at its
-- write cap (narrative target × 1.5 + snapshot budget × 2 + summary 600 × 2 +
-- chrome 42; src/server/summaries/narrative-budget.ts). Raise an existing row
-- to the new 12000 default, or to what its snapshot budget requires when that
-- is more; a higher owner-set value is kept. A higher limit never changes what
-- is sent: assembly counts the capsule's actual text.
UPDATE "settings"
SET "capsule_token_budget" = GREATEST(
  "capsule_token_budget",
  12000,
  CEIL("narrative_target_tokens" * 1.5)::integer + "recent_snapshot_token_budget" * 2 + 1242
);
