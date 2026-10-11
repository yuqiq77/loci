-- Make Opus 5.5 the default model for new conversations. Only the shipped
-- default moves: a default someone set to another model by hand is left
-- alone, and existing sessions keep the model they were created with.
UPDATE "settings" SET "default_model_id" = 'claude-opus-5-5' WHERE "default_model_id" = 'claude-opus-4-6';
