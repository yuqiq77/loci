import { z } from "zod";

import { JOB_STATUSES, JOB_TYPES } from "@/shared/jobs";

export const diagnosticsJobsQuerySchema = z.object({
  status: z.enum(JOB_STATUSES).optional(),
  type: z.enum(JOB_TYPES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  // Cursor: the id of the last row of the previous page.
  before: z.uuid().optional(),
});

export const diagnosticsToolRunsQuerySchema = z
  .object({
    sessionId: z.uuid().optional(),
    attemptId: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  })
  .refine((query) => Boolean(query.sessionId) !== Boolean(query.attemptId), {
    message: "Exactly one of sessionId or attemptId is required.",
  });

export const memoryTraceQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
