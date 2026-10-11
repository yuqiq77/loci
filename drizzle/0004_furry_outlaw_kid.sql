ALTER TABLE "messages" ADD COLUMN "thinking" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "thinking_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "thinking_effort" text DEFAULT 'high' NOT NULL;