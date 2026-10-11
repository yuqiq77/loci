CREATE TABLE "memory_injections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"memory_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"similarity" real NOT NULL,
	"score" real NOT NULL,
	"injected" boolean NOT NULL,
	"suppression_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_injections" ADD CONSTRAINT "memory_injections_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_injections" ADD CONSTRAINT "memory_injections_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_injections" ADD CONSTRAINT "memory_injections_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_injections_session_message_idx" ON "memory_injections" USING btree ("session_id","message_id");--> statement-breakpoint
CREATE INDEX "memory_injections_session_memory_idx" ON "memory_injections" USING btree ("session_id","memory_id","created_at");--> statement-breakpoint
CREATE INDEX "memory_injections_message_idx" ON "memory_injections" USING btree ("message_id");