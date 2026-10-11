import {
  and,
  asc,
  eq,
  inArray,
  lt,
  lte,
  sql,
} from "drizzle-orm";
import { z } from "zod";

import { JOB_TYPES } from "@/shared/jobs";

import { getDatabase } from "./client";
import { jobs } from "./schema";

// A provider candidate whose request terminated during this job (MC-118
// decision 5): later attempts of the same row skip the (stage, candidate)
// pair. Keyed by the real model + endpoint, not the chat/consolidation label
// — the label's target can change between attempts.
const exhaustedCandidateSchema = z.object({
  stage: z.string().min(1),
  model: z.string().min(1),
  baseUrl: z.string().min(1),
  reason: z.string().min(1),
});

export type ExhaustedCandidate = z.infer<typeof exhaustedCandidateSchema>;

// Source-bound retry identity for the automatic continuity jobs (MC-118): the
// tick derives it from the source high-water marks and a policy version, and
// a terminal `failed` row with the same key fences automatic re-enqueue until
// the sources, the policy, or an owner action (which passes no key) changes.
const sourceKeySchema = z.string().min(1).optional();

const jobPayloadSchemas = {
  summarize_session: z.object({
    sessionId: z.uuid(),
  }),
  update_recent_snapshot: z.object({
    sourceKey: sourceKeySchema,
  }),
  extract_memories: z.object({
    sessionId: z.uuid(),
  }),
  embed_memory: z.object({
    memoryId: z.uuid(),
  }),
  // Deduped per mode: an owner-requested rebuild must not be swallowed by a
  // pending tick-enqueued incremental (they are different operations); two
  // requests of the same mode still collapse to one job.
  consolidate_narrative: z.object({
    mode: z.enum(["incremental", "rebuild"]),
    sourceKey: sourceKeySchema,
    exhausted: z.array(exhaustedCandidateSchema).optional(),
  }),
  title_session: z.object({
    sessionId: z.uuid(),
  }),
  // Deduped per diary day: the unique entry_date row is the completion
  // marker, so two pending jobs for one day would only race the insert.
  write_diary_entry: z.object({
    date: z.iso.date(),
    sourceKey: sourceKeySchema,
    exhausted: z.array(exhaustedCandidateSchema).optional(),
  }),
} as const satisfies Record<(typeof JOB_TYPES)[number], z.ZodType>;

export type JobType = keyof typeof jobPayloadSchemas;
export type JobPayloadMap = {
  [Type in JobType]: z.infer<(typeof jobPayloadSchemas)[Type]>;
};
export type JobPayload = JobPayloadMap[JobType];

export type ClaimedJob = {
  id: string;
  type: string;
  payload: unknown;
  attempts: number;
};

// Counts the first call, so two retries: first, then +1m, then +10m (MC-118
// scope 5 — slow background backoff; the old 10s/60s/5min table's third
// tier was unreachable for the same reason).
export const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [60_000, 10 * 60_000] as const;
const STALE_LEASE_MS = 15 * 60_000;

export function parseJobPayload(
  type: string,
  payload: unknown,
): JobPayload {
  if (!(type in jobPayloadSchemas)) {
    throw new Error(`Unsupported job type: ${type}`);
  }

  return jobPayloadSchemas[type as JobType].parse(payload);
}

export function retryDelayMs(attempts: number): number {
  const index = Math.max(0, Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1));
  return RETRY_DELAYS_MS[index];
}

export async function enqueueJob<Type extends JobType>(
  type: Type,
  payload: JobPayloadMap[Type],
): Promise<string | null> {
  const validatedPayload = jobPayloadSchemas[type].parse(payload) as JobPayloadMap[Type];
  const payloadKey =
    type === "summarize_session"
      ? (validatedPayload as JobPayloadMap["summarize_session"]).sessionId
      : type === "extract_memories"
        ? (validatedPayload as JobPayloadMap["extract_memories"])
            .sessionId
        : type === "embed_memory"
          ? (validatedPayload as JobPayloadMap["embed_memory"]).memoryId
          : type === "consolidate_narrative"
            ? (validatedPayload as JobPayloadMap["consolidate_narrative"])
                .mode
            : type === "title_session"
              ? (validatedPayload as JobPayloadMap["title_session"])
                  .sessionId
              : type === "write_diary_entry"
                ? (validatedPayload as JobPayloadMap["write_diary_entry"])
                    .date
                : "singleton";
  const payloadField =
    type === "summarize_session"
      ? "sessionId"
      : type === "extract_memories"
        ? "sessionId"
        : type === "embed_memory"
          ? "memoryId"
          : type === "consolidate_narrative"
            ? "mode"
            : type === "title_session"
              ? "sessionId"
              : type === "write_diary_entry"
                ? "date"
                : null;
  const dedupeKey = `${type}:${payloadKey}`;
  const dedupeStatuses =
    type === "embed_memory"
      ? (["pending"] as const)
      : (["pending", "running"] as const);

  return getDatabase().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${dedupeKey}))`,
    );

    const [active] = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.type, type),
          inArray(jobs.status, dedupeStatuses),
          payloadField
            ? sql`${jobs.payload}->>${payloadField} = ${payloadKey}`
            : undefined,
        ),
      )
      .limit(1);
    if (active) {
      return null;
    }

    // The source fence (MC-118 decision 2): a terminal failed row for the
    // same logical work blocks automatic re-enqueue. Only automatic callers
    // carry a sourceKey; the manual paths pass none and are exempt by
    // construction. Legacy failed rows without a key never fence.
    const sourceKey =
      "sourceKey" in validatedPayload ? validatedPayload.sourceKey : undefined;
    if (sourceKey) {
      const [fenced] = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.type, type),
            eq(jobs.status, "failed"),
            sql`${jobs.payload}->>'sourceKey' = ${sourceKey}`,
          ),
        )
        .limit(1);
      if (fenced) {
        return null;
      }
    }

    const [created] = await tx
      .insert(jobs)
      .values({
        type,
        payload: validatedPayload,
      })
      .returning({ id: jobs.id });
    return created.id;
  });
}

export async function claimNextJob(now?: Date): Promise<ClaimedJob | null> {
  const readyAt = now ?? sql`now()`;
  return getDatabase().transaction(async (tx) => {
    const [candidate] = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.status, "pending"),
          lte(jobs.availableAt, readyAt),
        ),
      )
      .orderBy(asc(jobs.createdAt))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!candidate) {
      return null;
    }

    const [claimed] = await tx
      .update(jobs)
      .set({
        status: "running",
        lockedAt: readyAt,
        attempts: sql`${jobs.attempts} + 1`,
      })
      .where(eq(jobs.id, candidate.id))
      .returning({
        id: jobs.id,
        type: jobs.type,
        payload: jobs.payload,
        attempts: jobs.attempts,
      });

    return {
      id: claimed.id,
      type: claimed.type,
      payload: claimed.payload,
      attempts: claimed.attempts,
    };
  });
}

export async function completeJob(
  id: string,
  now = new Date(),
): Promise<void> {
  await getDatabase()
    .update(jobs)
    .set({
      status: "complete",
      lockedAt: null,
      lastError: null,
      completedAt: now,
    })
    .where(and(eq(jobs.id, id), eq(jobs.status, "running")));
}

export async function retryOrFailJob(input: {
  id: string;
  attempts: number;
  error: string;
  now?: Date;
  // The chain has no retryable candidate left (MC-118 decision 5): fail the
  // row now instead of spending the remaining attempts on it.
  terminal?: boolean;
  // Suspected host suspension (decision 7): re-pend without consuming the
  // attempt — attempts are counted at claim time, so this hands one back.
  uncharged?: boolean;
}): Promise<void> {
  const now = input.now ?? new Date();
  if (input.uncharged) {
    // Re-pended after the first retry delay, not at once: the heuristic can
    // only fire after a call has already run ≥ 1.5× its timeout, so the
    // refund loop is wall-clock bounded either way, but a mis-firing host
    // should not also spin the poll.
    await getDatabase()
      .update(jobs)
      .set({
        status: "pending",
        availableAt: new Date(now.getTime() + retryDelayMs(1)),
        lockedAt: null,
        lastError: input.error,
        attempts: sql`greatest(${jobs.attempts} - 1, 0)`,
      })
      .where(and(eq(jobs.id, input.id), eq(jobs.status, "running")));
    return;
  }
  const terminal = input.terminal || input.attempts >= MAX_ATTEMPTS;

  await getDatabase()
    .update(jobs)
    .set({
      status: terminal ? "failed" : "pending",
      availableAt: terminal
        ? now
        : new Date(now.getTime() + retryDelayMs(input.attempts)),
      lockedAt: null,
      lastError: input.error,
      completedAt: terminal ? now : null,
    })
    .where(and(eq(jobs.id, input.id), eq(jobs.status, "running")));
}

// Persisted before the next candidate is called (decision 5): a process
// exit during fallback must not re-run the terminated request after
// recovery. The row keeps the list across attempts.
// A finding the job wants read after it is gone, merged into its payload
// where the diagnostics queue shows it beside the job's inputs (a capped raw
// tail). Written while the attempt runs, so a later failure of the same
// attempt does not leave it to the log line alone.
export async function recordJobNote(
  id: string,
  note: Record<string, unknown>,
): Promise<void> {
  await getDatabase()
    .update(jobs)
    .set({
      payload: sql`${jobs.payload} || ${JSON.stringify(note)}::jsonb`,
    })
    .where(eq(jobs.id, id));
}

export async function recordJobExhausted(
  id: string,
  exhausted: ExhaustedCandidate[],
): Promise<void> {
  await getDatabase()
    .update(jobs)
    .set({
      payload: sql`jsonb_set(${jobs.payload}, '{exhausted}', ${JSON.stringify(
        exhausted,
      )}::jsonb)`,
    })
    .where(eq(jobs.id, id));
}

export async function recoverStaleJobs(now = new Date()): Promise<number> {
  const staleBefore = new Date(now.getTime() - STALE_LEASE_MS);
  const recovered = await getDatabase()
    .update(jobs)
    .set({
      status: "pending",
      availableAt: now,
      lockedAt: null,
      completedAt: null,
    })
    .where(
      and(
        eq(jobs.status, "running"),
        lt(jobs.lockedAt, staleBefore),
      ),
    )
    .returning({ id: jobs.id });

  return recovered.length;
}
