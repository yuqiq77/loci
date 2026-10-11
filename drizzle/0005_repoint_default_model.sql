-- Retire the legacy "default" model id: repoint existing sessions and the
-- configured default to the concrete model "default" used to resolve to
-- (CHAT_MODEL = claude-opus-4-6). Message rows are untouched; only the model
-- pointers move, so no conversation history is affected.
UPDATE "sessions" SET "model_id" = 'claude-opus-4-6' WHERE "model_id" = 'default';
--> statement-breakpoint
UPDATE "settings" SET "default_model_id" = 'claude-opus-4-6' WHERE "default_model_id" = 'default';
