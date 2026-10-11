import { z } from "zod";

// Owner-edited long-horizon narrative submitted from the profile page. The
// precise token-budget check lives in the route (it uses the token
// estimator); this only bounds raw length. expectedVersion is the version
// the editor loaded: background consolidations write daily, so a save from
// a stale tab must 409 instead of silently replacing a newer narrative.
export const profileSchema = z.object({
  content: z.string().max(20000),
  expectedVersion: z.number().int().nonnegative(),
});

export type ProfileInput = z.infer<typeof profileSchema>;

// Manual consolidation triggers from the profile page. Both bypass the
// tick-side interval guard by enqueueing directly.
export const consolidateNarrativeSchema = z.object({
  mode: z.enum(["incremental", "rebuild"]),
});

export type ConsolidateNarrativeInput = z.infer<
  typeof consolidateNarrativeSchema
>;
