import { z } from "zod";

const title = z.string().trim().min(1).max(200);
const modelId = z.string().trim().min(1).max(100);
const thinkingEffort = z.enum(["low", "medium", "high", "max"]);

export const createSessionSchema = z
  .object({
    title: title.optional(),
    modelId: modelId.optional(),
    thinkingEnabled: z.boolean().optional(),
    thinkingEffort: thinkingEffort.optional(),
  })
  .strict();

export const updateSessionSchema = z
  .object({
    title: title.optional(),
    modelId: modelId.optional(),
    thinkingEnabled: z.boolean().optional(),
    thinkingEffort: thinkingEffort.optional(),
    archived: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field must be supplied.",
  });

export const messagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export const sessionIdSchema = z.uuid();

export type CreateSessionInput = z.infer<typeof createSessionSchema>;
export type UpdateSessionInput = z.infer<typeof updateSessionSchema>;
