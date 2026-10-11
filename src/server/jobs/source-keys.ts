import { and, eq, inArray, isNotNull, isNull, max, sql } from "drizzle-orm";

import { getDatabase } from "@/server/db/client";
import { getRelationshipNarrative } from "@/server/db/narrative";
import {
  memories,
  messages,
  recentContinuitySnapshot,
  sessions,
} from "@/server/db/schema";

// Source-bound work identity for the automatic continuity jobs (MC-118
// Source keys). Kept apart from the tick so every automatic enqueue path —
// the minute tick and the summary-cursor piggyback in summaries/summarize.ts
// — derives the same key without importing the tick (which would cycle
// through summaries/diary → consolidate-narrative → summarize).

// Part of every automatic job's sourceKey: bump it when a retry policy input
// changes (the shared output cap, the backoff table, a prompt fix) so
// sources fenced under the old policy re-arm without deleting queue
// history. One version for the three fenced writers — their policy inputs
// are shared.
export const CONTINUITY_RETRY_POLICY_VERSION = 1;

// One aggregate per tick: maybeEnqueueContinuityJobs fetches this once and
// hands it to every predicate that gates on episode idleness / new material.
export async function newestCompletedMessageAt(): Promise<Date | null> {
  const [row] = await getDatabase()
    .select({ completedAt: max(messages.completedAt) })
    .from(messages)
    .where(
      and(
        eq(messages.status, "complete"),
        inArray(messages.role, ["user", "assistant"]),
        isNotNull(messages.completedAt),
      ),
    );
  return row.completedAt ?? null;
}

// Newest change among the rows the consolidation job actually reads as
// sources: soft-deleted rows are excluded (they never enter the sources) but
// superseded rows are not (the job folds them in, flagged). Served by the
// partial index memories_active_idx (updated_at desc where deleted_at is
// null).
export async function newestActiveMemoryUpdatedAt(): Promise<Date | null> {
  const [row] = await getDatabase()
    .select({ updatedAt: max(memories.updatedAt) })
    .from(memories)
    .where(isNull(memories.deletedAt));
  return row.updatedAt ?? null;
}

function isoOrNone(value: Date | null | undefined): string {
  return value ? value.toISOString() : "none";
}

// Readable snapshot identity: snapshot version, newest completed message,
// the summary-cursor set, newest active memory update, policy. Never the
// attempt's own window end, which is set from job start time and would
// change on every retry. The cursor set is count + the sum of the cursor
// instants (epoch seconds): a per-session cursor only ever advances, so any
// session's summary landing changes the sum — a global max would miss a
// session whose new cursor is still older than another session's (owner
// review, 2026-09-06).
export async function recentSnapshotSourceKey(
  newestCompletedAt: Date | null,
): Promise<string> {
  const database = getDatabase();
  const [snapshot] = await database
    .select({ version: recentContinuitySnapshot.version })
    .from(recentContinuitySnapshot)
    .where(eq(recentContinuitySnapshot.id, 1))
    .limit(1);
  const [summary] = await database
    .select({
      count: sql<number>`count(*)::int`,
      total: sql<string>`coalesce(sum(extract(epoch from ${messages.createdAt}))::bigint, 0)::text`,
    })
    .from(sessions)
    .innerJoin(messages, eq(messages.id, sessions.summaryThroughMessageId));
  const newestMemory = await newestActiveMemoryUpdatedAt();
  return [
    `v${snapshot?.version ?? 0}`,
    `msg:${isoOrNone(newestCompletedAt)}`,
    `sum:${summary?.count ?? 0}/${summary?.total ?? "0"}`,
    `mem:${isoOrNone(newestMemory)}`,
    `p${CONTINUITY_RETRY_POLICY_VERSION}`,
  ].join("|");
}

// Incremental narrative identity: narrative version + watermark, newest
// completed message, newest active memory update, policy. Not
// `sourceThrough` — that is a read boundary fixed at job start.
export async function narrativeSourceKey(
  newestCompletedAt: Date | null,
): Promise<string> {
  const narrative = await getRelationshipNarrative();
  const newestMemory = await newestActiveMemoryUpdatedAt();
  return [
    `v${narrative?.version ?? 0}`,
    `through:${isoOrNone(narrative?.consolidatedThrough)}`,
    `msg:${isoOrNone(newestCompletedAt)}`,
    `mem:${isoOrNone(newestMemory)}`,
    `p${CONTINUITY_RETRY_POLICY_VERSION}`,
  ].join("|");
}

// The date is the diary's natural source unit; the unique entry row remains
// the success marker.
export function diarySourceKey(date: string): string {
  return `${date}|p${CONTINUITY_RETRY_POLICY_VERSION}`;
}

// Reads the policy suffix the three derivations above write; null for a key
// in another format. Diagnostics only (MC-123) — the fence itself compares
// whole keys.
export function policyVersionFromSourceKey(
  sourceKey: string | null,
): number | null {
  const match = /\|p(\d+)$/.exec(sourceKey ?? "");
  return match ? Number(match[1]) : null;
}
