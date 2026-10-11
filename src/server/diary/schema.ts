import { z } from "zod";

export const diaryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).default(0),
  // YYYY-MM: only that month's entries (the Journals month view).
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .optional(),
});

// Manual "journal this day" (MC-118 scope 8): the diary's only re-arm once
// the automatic row for a date is fenced — the date never changes and
// DIARY_BACKLOG_DAYS stops automatic backfill after three days.
export const diaryEnqueueSchema = z.object({
  date: z.iso.date(),
});
