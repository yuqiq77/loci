import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
} from "drizzle-orm";

import { estimateTextTokens } from "@/server/chat/context";
import { getDatabase } from "@/server/db/client";
import { getDiaryEpoch } from "@/server/db/diary";
import { enqueueJob } from "@/server/db/jobs";
import {
  afterMessageCondition,
  compareMessageCursors,
  messageRoleOrderSql,
  type MessageCursor,
} from "@/server/db/message-cursor";
import { getRelationshipNarrative } from "@/server/db/narrative";
import {
  messages,
  recentContinuitySnapshot,
  sessions,
} from "@/server/db/schema";
import { isMemoryEnabled } from "@/server/memory/embedding";
import { openDiaryDays } from "@/server/summaries/diary";
import { errorName } from "@/shared/errors";

import {
  diarySourceKey,
  narrativeSourceKey,
  newestActiveMemoryUpdatedAt,
  newestCompletedMessageAt,
  recentSnapshotSourceKey,
} from "./source-keys";

export {
  CONTINUITY_RETRY_POLICY_VERSION,
  diarySourceKey,
  narrativeSourceKey,
  newestCompletedMessageAt,
  recentSnapshotSourceKey,
} from "./source-keys";

// Dogfooding value (2026-07-07); must stay well above the 5-minute prompt
// cache TTL so an episode-boundary snapshot entering the capsule always
// lands on an already-cold cache (D3 amendment).
export const EPISODE_IDLE_MS = 15 * 60 * 1000;
export const CONTINUITY_CHECK_INTERVAL_MS = 60 * 1000;
export const MAX_EXTRACTION_SPAN_TOKENS = 12_000;
// Approximates the spec's "nightly" consolidation without a scheduler: the
// episode tick fires an incremental run at most once per interval. Manual
// /profile actions bypass this guard by enqueueing directly.
export const CONSOLIDATION_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Cadence guard for the snapshot (owner decision 2026-07-09, dogfooding):
// without it, any chat followed by a 15-minute lull rewrote the snapshot —
// several model calls and content churns per day for a document with a 7-day
// TTL whose freshness mainly serves sessions opened later (the active
// session already carries recent turns verbatim). Idle answers "is now
// quiet"; this answers "is it worth it". The summary-cursor piggyback
// enqueue in summarizeSession deliberately bypasses this guard.
export const SNAPSHOT_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

// The shared episode-idle gate, one definition for every consumer: the
// episode is idle when the newest completed message is old enough. Idle
// answers "is now quiet"; each consumer's own cadence guard answers "is it
// worth it".
function episodeIsIdle(
  newestCompletedAt: Date | null,
  now: Date,
): newestCompletedAt is Date {
  return (
    newestCompletedAt !== null &&
    newestCompletedAt <= new Date(now.getTime() - EPISODE_IDLE_MS)
  );
}

export async function shouldEnqueueRecentSnapshot(
  newestCompletedAt: Date | null,
  now = new Date(),
): Promise<boolean> {
  if (!episodeIsIdle(newestCompletedAt, now)) {
    return false;
  }

  const [snapshot] = await getDatabase()
    .select({
      sourceWindowEnd: recentContinuitySnapshot.sourceWindowEnd,
      updatedAt: recentContinuitySnapshot.updatedAt,
    })
    .from(recentContinuitySnapshot)
    .where(eq(recentContinuitySnapshot.id, 1))
    .limit(1);
  if (
    snapshot &&
    snapshot.updatedAt >
      new Date(now.getTime() - SNAPSHOT_MIN_INTERVAL_MS)
  ) {
    return false;
  }

  return (
    !snapshot?.sourceWindowEnd ||
    newestCompletedAt > snapshot.sourceWindowEnd
  );
}

async function loadSessionExtractionSpan(input: {
  sessionId: string;
  cursor?: MessageCursor;
}) {
  return getDatabase()
    .select({
      role: messages.role,
      content: messages.content,
      completedAt: messages.completedAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, input.sessionId),
        eq(messages.status, "complete"),
        inArray(messages.role, ["user", "assistant"]),
        isNotNull(messages.completedAt),
        afterMessageCondition(input.cursor),
      ),
    )
    .orderBy(
      asc(messages.createdAt),
      messageRoleOrderSql(),
      asc(messages.id),
    );
}

export async function sessionsNeedingMemoryExtraction(
  now = new Date(),
): Promise<string[]> {
  if (!isMemoryEnabled()) {
    return [];
  }

  const database = getDatabase();
  const rows = await database
    .select({
      id: sessions.id,
      extractedThroughMessageId: sessions.extractedThroughMessageId,
    })
    .from(sessions)
    .where(isNull(sessions.archivedAt));
  if (rows.length === 0) {
    return [];
  }

  // Cheap shortlist before touching message contents: one pass for the
  // newest completed message per session (full cursor tuple, so the
  // comparison uses the exact total order), one batched lookup for the
  // extraction cursors. The tick runs forever, so fully-extracted sessions
  // must cost aggregate reads only — the content-bearing span query below
  // runs solely for sessions that may actually have un-extracted material.
  const newestRows = await database
    .selectDistinctOn([messages.sessionId], {
      sessionId: messages.sessionId,
      id: messages.id,
      role: messages.role,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.status, "complete"),
        inArray(messages.role, ["user", "assistant"]),
        isNotNull(messages.completedAt),
      ),
    )
    .orderBy(
      messages.sessionId,
      desc(messages.createdAt),
      desc(messageRoleOrderSql()),
      desc(messages.id),
    );
  const newestBySession = new Map(
    newestRows.map((row) => [row.sessionId, row]),
  );

  const cursorIds = rows
    .map((row) => row.extractedThroughMessageId)
    .filter((id): id is string => id !== null);
  const cursorRows =
    cursorIds.length > 0
      ? await database
          .select({
            id: messages.id,
            role: messages.role,
            createdAt: messages.createdAt,
          })
          .from(messages)
          .where(inArray(messages.id, cursorIds))
      : [];
  const cursorsById = new Map(cursorRows.map((row) => [row.id, row]));

  const idleBefore = new Date(now.getTime() - EPISODE_IDLE_MS);
  const sessionIds: string[] = [];
  for (const session of rows) {
    const newest = newestBySession.get(session.id);
    if (!newest) {
      continue;
    }
    const cursor = session.extractedThroughMessageId
      ? cursorsById.get(session.extractedThroughMessageId)
      : undefined;
    // Exact total-order comparison: only sessions whose newest completed
    // message sorts after the cursor can have un-extracted material.
    if (cursor && compareMessageCursors(newest, cursor) <= 0) {
      continue;
    }

    const span = await loadSessionExtractionSpan({
      sessionId: session.id,
      cursor,
    });
    if (!span.some((message) => message.role === "assistant")) {
      continue;
    }

    const newestCompletedAt = span.reduce<Date | null>(
      (latest, message) =>
        !latest || (message.completedAt && message.completedAt > latest)
          ? message.completedAt
          : latest,
      null,
    );
    const spanTokens = span.reduce(
      (total, message) => total + estimateTextTokens(message.content),
      0,
    );
    if (
      (newestCompletedAt && newestCompletedAt <= idleBefore) ||
      spanTokens > MAX_EXTRACTION_SPAN_TOKENS
    ) {
      sessionIds.push(session.id);
    }
  }

  return sessionIds;
}

export async function shouldEnqueueNarrativeConsolidation(
  newestCompletedAt: Date | null,
  now = new Date(),
): Promise<boolean> {
  // Episode idleness is gated on messages only: editing memories is
  // curation, not conversation, and must not hold the episode open.
  if (!episodeIsIdle(newestCompletedAt, now)) {
    return false;
  }

  const narrative = await getRelationshipNarrative();
  if (!narrative) {
    return false;
  }
  if (
    narrative.consolidatedThrough >
    new Date(now.getTime() - CONSOLIDATION_MIN_INTERVAL_MS)
  ) {
    return false;
  }

  if (newestCompletedAt > narrative.consolidatedThrough) {
    return true;
  }
  // "New material" must match the job's source semantics, which also read
  // memory rows updated past the watermark — owner edits/restores/supersedes
  // and late-landing extraction or embedding writes would otherwise sit
  // unconsolidated until the next conversation. The aggregate only runs when
  // messages alone do not qualify (rare); the job's own resolution flips are
  // stamped exactly at the watermark, so they never re-trigger this.
  const newestMemoryUpdatedAt = await newestActiveMemoryUpdatedAt();
  return (
    newestMemoryUpdatedAt !== null &&
    newestMemoryUpdatedAt > narrative.consolidatedThrough
  );
}

// Diary days whose entry should exist but does not: window closed (a day is
// never journaled while its night is open), within the backlog bound, at or
// after the diary epoch, D18-qualifying material inside the window, and no
// diary_entries row yet. Deliberately no *_MIN_INTERVAL_MS guard (owner,
// 2026-07-12): interval guards give rolling processes with no natural work
// unit an artificial rhythm; the diary's unit is the discrete day and the
// unique entry_date row is its completion marker — coverage-by-date is
// stateless and self-healing, an interval has phase and can only add misses.
export async function diaryDaysNeedingEntries(
  newestCompletedAt: Date | null,
  now = new Date(),
): Promise<string[]> {
  if (!episodeIsIdle(newestCompletedAt, now)) {
    return [];
  }
  return openDiaryDays({ epoch: await getDiaryEpoch(), newestCompletedAt, now });
}

export async function maybeEnqueueContinuityJobs(
  now = new Date(),
): Promise<void> {
  // Shared by the snapshot and narrative predicates. A failed read degrades
  // to null (both predicates decline this tick, retried on the next one) and
  // is logged like any other failed check.
  let newestCompletedAt: Date | null = null;
  try {
    newestCompletedAt = await newestCompletedMessageAt();
  } catch (error) {
    console.error(
      "Continuity job predicate failed.",
      "newest_completed_message",
      errorName(error),
    );
  }

  // Queue order is not a completion barrier: an extraction retry can make a
  // later narrative job run first. Stay conservative until the extraction
  // cursor is caught up, then let the next tick enqueue consolidation.
  // Written by the memory_extraction check, read by narrative_consolidation —
  // the barrier depends on that order in the checks array below.
  let extractionCaughtUp = false;

  const checks: { name: string; run: () => Promise<void> }[] = [
    {
      name: "recent_snapshot",
      run: async () => {
        if (await shouldEnqueueRecentSnapshot(newestCompletedAt, now)) {
          await enqueueJob("update_recent_snapshot", {
            sourceKey: await recentSnapshotSourceKey(newestCompletedAt),
          });
        }
      },
    },
    {
      name: "memory_extraction",
      run: async () => {
        const sessionIds = await sessionsNeedingMemoryExtraction(now);
        extractionCaughtUp = sessionIds.length === 0;
        for (const sessionId of sessionIds) {
          await enqueueJob("extract_memories", { sessionId });
        }
      },
    },
    {
      name: "narrative_consolidation",
      run: async () => {
        if (!extractionCaughtUp) {
          return;
        }
        if (
          await shouldEnqueueNarrativeConsolidation(newestCompletedAt, now)
        ) {
          await enqueueJob("consolidate_narrative", {
            mode: "incremental",
            sourceKey: await narrativeSourceKey(newestCompletedAt),
          });
        }
      },
    },
    {
      name: "diary_entries",
      run: async () => {
        const dates = await diaryDaysNeedingEntries(newestCompletedAt, now);
        for (const date of dates) {
          await enqueueJob("write_diary_entry", {
            date,
            sourceKey: diarySourceKey(date),
          });
        }
      },
    },
  ];

  for (const check of checks) {
    try {
      await check.run();
    } catch (error) {
      console.error(
        "Continuity job predicate failed.",
        check.name,
        errorName(error),
      );
    }
  }
}
