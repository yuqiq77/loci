ALTER TABLE "sessions" ADD COLUMN "extracted_through_message_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "used_web_search" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "superseded_by" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_extracted_through_message_id_messages_id_fk" FOREIGN KEY ("extracted_through_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_superseded_by_memories_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."memories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memories_superseded_by_idx" ON "memories" USING btree ("superseded_by");
