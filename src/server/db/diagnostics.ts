import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  max,
  min,
  or,
  sql,
} from "drizzle-orm";

import { estimateTextTokens, formatLocalDay } from "@/server/chat/context";
import { decodeJobError, type DecodedJobError } from "@/server/jobs/last-error";
import {
  CONTINUITY_RETRY_POLICY_VERSION,
  diarySourceKey,
  narrativeSourceKey,
  newestCompletedMessageAt,
  policyVersionFromSourceKey,
  recentSnapshotSourceKey,
} from "@/server/jobs/source-keys";
import { openDiaryDays } from "@/server/summaries/diary";
import { errorName } from "@/shared/errors";
import type { JOB_STATUSES, JOB_TYPES } from "@/shared/jobs";

import { getDatabase } from "./client";
import { countDiaryEntries, getDiaryEpoch } from "./diary";
import type { ExhaustedCandidate } from "./jobs";
import { countActive, countDeleted } from "./memories";
import { getRelationshipNarrative } from "./narrative";
import { getRecentSnapshot } from "./recent-snapshot";
import {
  diaryEntries,
  jobs,
  memories,
  memoryInjections,
  messages,
  toolRuns,
} from "./schema";
import { listToolRunsForAttempt } from "./tool-runs";

// Read-only diagnostics over rows that already exist (MC-123). Nothing here
// writes: no recall update, no trace insert, no job mutation. Every token
// figure is the local estimator — never a provider count.

// The injection and failed-job windows: seven server-local days including
// today (the formatLocalDay clock).
const WINDOW_DAYS = 7;

function windowStart(now: Date): Date {
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - (WINDOW_DAYS - 1),
  );
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

// Section isolation (MC-200 rule): a failing aggregate returns { error } for
// its section and the rest of the payload still arrives. Logged once, with
// the section name.
export type SectionResult<T> = T | { error: string };

export async function settleSections<
  T extends Record<string, Promise<unknown>>,
>(sections: T): Promise<{ [K in keyof T]: SectionResult<Awaited<T[K]>> }> {
  const names = Object.keys(sections) as (keyof T & string)[];
  const settled = await Promise.allSettled(names.map((name) => sections[name]));
  const result = {} as { [K in keyof T]: SectionResult<Awaited<T[K]>> };
  settled.forEach((outcome, index) => {
    const name = names[index];
    if (outcome.status === "fulfilled") {
      result[name] = outcome.value as Awaited<T[typeof name]>;
    } else {
      const error = errorName(outcome.reason);
      console.error("diagnostics_section_failed", { section: name, error });
      result[name] = { error };
    }
  });
  return result;
}

// ---------------------------------------------------------------------------
// Pulse

async function memoriesPulse() {
  const database = getDatabase();
  const active = isNull(memories.deletedAt);
  const duplicateGroups = database
    .select({ n: count().as("n") })
    .from(memories)
    .where(active)
    .groupBy(memories.contentHash)
    .having(gt(count(), 1))
    .as("duplicate_groups");
  const [activeCount, trashCount, byKind, [flags], [duplicates]] =
    await Promise.all([
      countActive(),
      countDeleted(),
      database
        .select({ kind: memories.kind, count: count() })
        .from(memories)
        .where(active)
        .groupBy(memories.kind)
        .orderBy(desc(count()), asc(memories.kind)),
      database
        .select({
          pinned: count(sql`case when ${memories.pinned} then 1 end`),
          unresolvedOpenThreads: count(
            sql`case when ${memories.kind} = 'open_thread' and not ${memories.resolved} then 1 end`,
          ),
          missingEmbedding: count(
            sql`case when ${memories.embedding} is null then 1 end`,
          ),
          superseded: count(
            sql`case when ${memories.supersededBy} is not null then 1 end`,
          ),
          chainHeads: count(
            sql`case when ${memories.supersededBy} is null and exists (
              select 1 from ${memories} as chained
              where chained.superseded_by = ${memories.id}
                and chained.deleted_at is null
            ) then 1 end`,
          ),
        })
        .from(memories)
        .where(active),
      database
        .select({
          groups: count(),
          largest: sql<number>`coalesce(max(${duplicateGroups.n}), 0)::int`,
        })
        .from(duplicateGroups),
    ]);
  return {
    active: activeCount,
    trash: trashCount,
    byKind,
    pinned: flags.pinned,
    unresolvedOpenThreads: flags.unresolvedOpenThreads,
    missingEmbedding: flags.missingEmbedding,
    superseded: flags.superseded,
    chainHeads: flags.chainHeads,
    duplicateGroups: duplicates.groups,
    largestDuplicateGroup: duplicates.largest,
  };
}

async function injectionsPulse(since: Date) {
  const database = getDatabase();
  const inWindow = gte(memoryInjections.createdAt, since);
  // Injected counts per memory, aggregated before the join so only the ten
  // survivors touch `memories` — and only for their kind: memory bodies stay
  // on /memories (the ids link there).
  const topInjected = database
    .select({
      memoryId: memoryInjections.memoryId,
      count: count().as("injected_count"),
    })
    .from(memoryInjections)
    .where(and(inWindow, eq(memoryInjections.injected, true)))
    .groupBy(memoryInjections.memoryId)
    .orderBy(desc(count()))
    .limit(10)
    .as("top_injected");
  const [decisions, top, [turns]] = await Promise.all([
    database
      .select({
        injected: memoryInjections.injected,
        reason: memoryInjections.suppressionReason,
        count: count(),
      })
      .from(memoryInjections)
      .where(inWindow)
      .groupBy(memoryInjections.injected, memoryInjections.suppressionReason)
      .orderBy(desc(count())),
    database
      .select({
        memoryId: topInjected.memoryId,
        kind: memories.kind,
        count: topInjected.count,
      })
      .from(topInjected)
      .innerJoin(memories, eq(memories.id, topInjected.memoryId))
      .orderBy(desc(topInjected.count)),
    database
      .select({
        total: count(),
        withWebSearch: count(
          sql`case when ${messages.usedWebSearch} then 1 end`,
        ),
      })
      .from(messages)
      .where(
        and(
          eq(messages.role, "assistant"),
          eq(messages.status, "complete"),
          gte(messages.completedAt, since),
        ),
      ),
  ]);
  const suppressed = decisions.filter((row) => !row.injected);
  return {
    sinceDay: formatLocalDay(since),
    injected: decisions
      .filter((row) => row.injected)
      .reduce((sum, row) => sum + row.count, 0),
    suppressed: suppressed.reduce((sum, row) => sum + row.count, 0),
    suppressedByReason: suppressed.map((row) => ({
      reason: row.reason ?? "unknown",
      count: row.count,
    })),
    topMemories: top,
    assistantTurns: {
      total: turns.total,
      withWebSearch: turns.withWebSearch,
    },
  };
}

async function carriersPulse(now: Date) {
  const database = getDatabase();
  const [narrative, snapshot, epoch, entries, [lastEntry], [lastDiaryJob]] =
    await Promise.all([
      getRelationshipNarrative(),
      getRecentSnapshot(now),
      getDiaryEpoch(),
      countDiaryEntries(),
      database
        .select({ entryDate: max(diaryEntries.entryDate) })
        .from(diaryEntries),
      database
        .select({
          id: jobs.id,
          status: jobs.status,
          date: sql<string | null>`${jobs.payload}->>'date'`,
          completedAt: jobs.completedAt,
        })
        .from(jobs)
        .where(eq(jobs.type, "write_diary_entry"))
        .orderBy(desc(jobs.createdAt))
        .limit(1),
    ]);
  return {
    tokenUnit: "estimator" as const,
    narrative: narrative
      ? {
          version: narrative.version,
          updatedAt: narrative.updatedAt.toISOString(),
          consolidatedThrough: narrative.consolidatedThrough.toISOString(),
          estimatedTokens: estimateTextTokens(narrative.content),
        }
      : null,
    recentSnapshot: snapshot
      ? {
          version: snapshot.version,
          asOf: snapshot.asOf.toISOString(),
          ageMinutes: Math.max(
            0,
            Math.round((now.getTime() - snapshot.asOf.getTime()) / 60_000),
          ),
          estimatedTokens: estimateTextTokens(snapshot.content),
        }
      : null,
    diary: {
      epoch: iso(epoch),
      entries,
      lastEntryDate: lastEntry?.entryDate ?? null,
      // The rows record the job, not the skip reason (that is logged only
      // as diary_entry_skipped): a complete job with no entry for its date
      // is a skipped window.
      lastJob: lastDiaryJob
        ? {
            id: lastDiaryJob.id,
            date: lastDiaryJob.date,
            status: lastDiaryJob.status,
            completedAt: iso(lastDiaryJob.completedAt),
          }
        : null,
    },
  };
}

async function queuePulse(since: Date) {
  const database = getDatabase();
  const [byStatusType, [pending], running, failedByType] = await Promise.all([
    database
      .select({ status: jobs.status, type: jobs.type, count: count() })
      .from(jobs)
      .groupBy(jobs.status, jobs.type)
      .orderBy(asc(jobs.status), asc(jobs.type)),
    database
      .select({ oldestAvailableAt: min(jobs.availableAt) })
      .from(jobs)
      .where(eq(jobs.status, "pending")),
    database
      .select({
        id: jobs.id,
        type: jobs.type,
        attempts: jobs.attempts,
        lockedAt: jobs.lockedAt,
      })
      .from(jobs)
      .where(eq(jobs.status, "running"))
      .orderBy(asc(jobs.lockedAt)),
    database
      .select({ type: jobs.type, count: count() })
      .from(jobs)
      .where(and(eq(jobs.status, "failed"), gte(jobs.completedAt, since)))
      .groupBy(jobs.type)
      .orderBy(desc(count())),
  ]);
  return {
    byStatusType,
    oldestPendingAvailableAt: iso(pending?.oldestAvailableAt),
    running: running.map((row) => ({
      ...row,
      lockedAt: iso(row.lockedAt),
    })),
    failedSinceDay: formatLocalDay(since),
    failedByType,
  };
}

export async function loadDiagnosticsPulse(now = new Date()) {
  const since = windowStart(now);
  return settleSections({
    memories: memoriesPulse(),
    injections: injectionsPulse(since),
    carriers: carriersPulse(now),
    queue: queuePulse(since),
  });
}

export type DiagnosticsPulse = Awaited<ReturnType<typeof loadDiagnosticsPulse>>;

// ---------------------------------------------------------------------------
// Jobs

export type JobStatus = (typeof JOB_STATUSES)[number];
export type JobType = (typeof JOB_TYPES)[number];

export type JobView = {
  id: string;
  type: string;
  status: JobStatus;
  attempts: number;
  availableAt: string;
  lockedAt: string | null;
  createdAt: string;
  completedAt: string | null;
  // Present ⇒ an automatic, fenceable job; absent ⇒ manual.
  sourceKey: string | null;
  policyVersion: number | null;
  exhausted: ExhaustedCandidate[];
  // The rest of the payload as recorded (session id, mode, date, …).
  payload: Record<string, unknown>;
  lastError: DecodedJobError | null;
};

function toJobView(row: typeof jobs.$inferSelect): JobView {
  const { sourceKey, exhausted, ...payload } = row.payload;
  const key = typeof sourceKey === "string" ? sourceKey : null;
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    attempts: row.attempts,
    availableAt: row.availableAt.toISOString(),
    lockedAt: iso(row.lockedAt),
    createdAt: row.createdAt.toISOString(),
    completedAt: iso(row.completedAt),
    sourceKey: key,
    policyVersion: policyVersionFromSourceKey(key),
    exhausted: Array.isArray(exhausted)
      ? (exhausted as ExhaustedCandidate[])
      : [],
    payload,
    lastError: decodeJobError(row.lastError),
  };
}

// Newest first. The cursor is the last row's id, compared as the
// (created_at, id) tuple in SQL — the column is microsecond-precise and a JS
// Date is not, so a timestamp cursor would skip rows in the boundary
// millisecond. An unknown cursor id compares NULL and yields no rows.
export async function listJobsForDiagnostics(input: {
  status?: JobStatus;
  type?: JobType;
  limit: number;
  before?: string;
}): Promise<{ rows: JobView[]; nextCursor: string | null }> {
  const rows = await getDatabase()
    .select()
    .from(jobs)
    .where(
      and(
        input.status ? eq(jobs.status, input.status) : undefined,
        input.type ? eq(jobs.type, input.type) : undefined,
        input.before
          ? sql`(${jobs.createdAt}, ${jobs.id}) < (
              select ${jobs.createdAt}, ${jobs.id} from ${jobs}
              where ${jobs.id} = ${input.before}
            )`
          : undefined,
      ),
    )
    .orderBy(desc(jobs.createdAt), desc(jobs.id))
    .limit(input.limit);
  return {
    rows: rows.map(toJobView),
    nextCursor: rows.length === input.limit ? rows[rows.length - 1].id : null,
  };
}

// ---------------------------------------------------------------------------
// Fences

export type FenceRow = {
  id: string;
  type: string;
  sourceKey: string;
  policyVersion: number | null;
  attempts: number;
  completedAt: string | null;
  lastError: DecodedJobError | null;
};

export type FenceView = {
  writer: "recent_snapshot" | "narrative" | "diary";
  jobType: string;
  label: string;
  // Null when the writer has no source to fence right now (diary: no
  // closed day awaiting an entry).
  sourceKey: string | null;
  policyVersion: number;
  status: "blocked" | "clear";
  blockedBy: FenceRow | null;
  // Failed rows of this writer under another key — an older source state
  // or an older policy version. Not a fence.
  history: FenceRow[];
};

export function classifyFence(
  sourceKey: string | null,
  failedRows: FenceRow[],
): Pick<FenceView, "status" | "blockedBy" | "history"> {
  const blockedBy = sourceKey
    ? (failedRows.find((row) => row.sourceKey === sourceKey) ?? null)
    : null;
  return {
    status: blockedBy ? "blocked" : "clear",
    blockedBy,
    history: failedRows.filter((row) => row !== blockedBy),
  };
}

const FENCED_JOB_TYPES = [
  "update_recent_snapshot",
  "consolidate_narrative",
  "write_diary_entry",
] as const;

// Bounded: a row under one of the derived keys (a fence) at any age, plus
// history inside the window.
async function failedFencedRows(
  keys: string[],
  since: Date,
): Promise<FenceRow[]> {
  const sourceKey = sql`${jobs.payload}->>'sourceKey'`;
  const rows = await getDatabase()
    .select({
      id: jobs.id,
      type: jobs.type,
      sourceKey: sql<string>`${sourceKey}`,
      attempts: jobs.attempts,
      completedAt: jobs.completedAt,
      lastError: jobs.lastError,
    })
    .from(jobs)
    .where(
      and(
        eq(jobs.status, "failed"),
        inArray(jobs.type, [...FENCED_JOB_TYPES]),
        isNotNull(sourceKey),
        or(gte(jobs.completedAt, since), inArray(sourceKey, keys)),
      ),
    )
    .orderBy(desc(jobs.completedAt));
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    sourceKey: row.sourceKey,
    policyVersion: policyVersionFromSourceKey(row.sourceKey),
    attempts: row.attempts,
    completedAt: iso(row.completedAt),
    lastError: decodeJobError(row.lastError),
  }));
}

// Derives each writer's key with the same inputs the tick uses at the moment
// of the request (the diary's minus the idle guard), then classifies the
// failed rows against it.
export async function resolveFences(now = new Date()): Promise<FenceView[]> {
  const [newestCompletedAt, epoch] = await Promise.all([
    newestCompletedMessageAt(),
    getDiaryEpoch(),
  ]);
  const [snapshotKey, narrativeKey, openDays] = await Promise.all([
    recentSnapshotSourceKey(newestCompletedAt),
    narrativeSourceKey(newestCompletedAt),
    openDiaryDays({ epoch, newestCompletedAt, now }),
  ]);
  const diaryKeys = openDays.map(diarySourceKey);
  const failed = await failedFencedRows(
    [snapshotKey, narrativeKey, ...diaryKeys],
    windowStart(now),
  );

  const fence = (
    writer: FenceView["writer"],
    jobType: (typeof FENCED_JOB_TYPES)[number],
    label: string,
    sourceKey: string | null,
  ): FenceView => ({
    writer,
    jobType,
    label,
    sourceKey,
    policyVersion: CONTINUITY_RETRY_POLICY_VERSION,
    ...classifyFence(
      sourceKey,
      failed.filter((row) => row.type === jobType),
    ),
  });

  return [
    fence(
      "recent_snapshot",
      "update_recent_snapshot",
      "Recent snapshot",
      snapshotKey,
    ),
    fence("narrative", "consolidate_narrative", "Narrative", narrativeKey),
    ...(openDays.length === 0
      ? [
          fence(
            "diary",
            "write_diary_entry",
            "Journal — no closed day awaiting an entry",
            null,
          ),
        ]
      : openDays.map((date) =>
          fence("diary", "write_diary_entry", `Journal ${date}`, diarySourceKey(date)),
        )),
  ];
}

// ---------------------------------------------------------------------------
// Tool runs

export type ToolRunView = {
  id: string;
  roundIndex: number;
  callIndex: number;
  toolName: string;
  toolSchemaHash: string | null;
  input: Record<string, unknown> | null;
  isError: boolean;
  errorCode: string | null;
  // Null with purgedAt set = body purged by retention; null without it = no
  // result recorded (the run never finished).
  resultContent: string | null;
  precedingText: string | null;
  status: (typeof toolRuns.$inferSelect)["status"];
  startedAt: string;
  finishedAt: string | null;
  elapsedMs: number | null;
  purgedAt: string | null;
};

export type ToolRunAttemptView = {
  attemptId: string;
  sessionId: string;
  assistantMessageId: string;
  startedAt: string;
  runs: ToolRunView[];
};

function toToolRunView(row: typeof toolRuns.$inferSelect): ToolRunView {
  return {
    id: row.id,
    roundIndex: row.roundIndex,
    callIndex: row.callIndex,
    toolName: row.toolName,
    toolSchemaHash: row.toolSchemaHash,
    input: row.input,
    isError: row.isError,
    errorCode: row.errorCode,
    resultContent: row.resultContent,
    precedingText: row.precedingText,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    finishedAt: iso(row.finishedAt),
    elapsedMs: row.finishedAt
      ? row.finishedAt.getTime() - row.startedAt.getTime()
      : null,
    purgedAt: iso(row.purgedAt),
  };
}

function groupAttempts(
  rows: (typeof toolRuns.$inferSelect)[],
): ToolRunAttemptView[] {
  const attempts = new Map<string, ToolRunAttemptView>();
  for (const row of rows) {
    const attempt = attempts.get(row.attemptId) ?? {
      attemptId: row.attemptId,
      sessionId: row.sessionId,
      assistantMessageId: row.assistantMessageId,
      startedAt: "",
      runs: [],
    };
    attempt.runs.push(toToolRunView(row));
    attempts.set(row.attemptId, attempt);
  }
  for (const attempt of attempts.values()) {
    // Rounds run sequentially and calls within a round in order, so the
    // first run by (round, call) is the attempt's first run.
    attempt.runs.sort(
      (a, b) => a.roundIndex - b.roundIndex || a.callIndex - b.callIndex,
    );
    attempt.startedAt = attempt.runs[0].startedAt;
  }
  return [...attempts.values()].sort((a, b) =>
    b.startedAt.localeCompare(a.startedAt),
  );
}

// Recent attempts of one session, newest first; `limit` bounds the runs
// read, so the oldest attempt in the page may be cut.
export async function listToolRunAttemptsForSession(
  sessionId: string,
  limit: number,
): Promise<ToolRunAttemptView[]> {
  const rows = await getDatabase()
    .select()
    .from(toolRuns)
    .where(eq(toolRuns.sessionId, sessionId))
    .orderBy(desc(toolRuns.createdAt))
    .limit(limit);
  return groupAttempts(rows);
}

export async function listToolRunAttempt(
  attemptId: string,
): Promise<ToolRunAttemptView[]> {
  return groupAttempts(await listToolRunsForAttempt(attemptId));
}

// ---------------------------------------------------------------------------
// Per-memory trace

export type MemoryTraceDecision = {
  id: string;
  sessionId: string;
  messageId: string;
  injected: boolean;
  similarity: number;
  score: number;
  suppressionReason: string | null;
  createdAt: string;
};

// An empty result means "no decision recorded within the trace margin", not
// "never considered": the writer only records injected and near-miss rows.
export async function listMemoryTrace(
  memoryId: string,
  limit: number,
): Promise<MemoryTraceDecision[]> {
  const rows = await getDatabase()
    .select({
      id: memoryInjections.id,
      sessionId: memoryInjections.sessionId,
      messageId: memoryInjections.messageId,
      injected: memoryInjections.injected,
      similarity: memoryInjections.similarity,
      score: memoryInjections.score,
      suppressionReason: memoryInjections.suppressionReason,
      createdAt: memoryInjections.createdAt,
    })
    .from(memoryInjections)
    .where(eq(memoryInjections.memoryId, memoryId))
    .orderBy(desc(memoryInjections.createdAt), desc(memoryInjections.id))
    .limit(limit);
  return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
}
