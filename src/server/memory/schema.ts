import { z } from "zod";

import { MEMORY_KINDS } from "@/shared/types";

export const memoryIdSchema = z.uuid();
export const memoryKindSchema = z.enum(MEMORY_KINDS);

export const memoriesQuerySchema = z.object({
  q: z.string().max(1000).optional().default(""),
  kind: memoryKindSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  trash: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
});

export const updateMemorySchema = z
  .object({
    content: z.string().trim().min(10).max(1000).optional(),
    kind: memoryKindSchema.optional(),
    importance: z.number().min(0).max(1).optional(),
    valence: z.number().min(-1).max(1).optional(),
    arousal: z.number().min(0).max(1).optional(),
    resolved: z.boolean().optional(),
    pinned: z.boolean().optional(),
    supersededBy: z.uuid().nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field must be supplied.",
  });

export type UpdateMemoryInput = z.infer<typeof updateMemorySchema>;
