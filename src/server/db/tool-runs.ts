import { and, asc, eq, inArray, isNull, lt } from "drizzle-orm";

import type {
  ToolRunFinish,
  ToolRunRecorder,
  ToolRunStart,
} from "@/server/chat/tool-loop";

import { getDatabase } from "./client";
import { toolRuns } from "./schema";

// Input/result/preceding-text bodies live at least this long: they are purged
// only by their own session's next beginGeneration, so a dormant session keeps
// them (lazy by design, MC-117A #11). Ids, statuses, timings, and the schema
// hash are retained. Bodies inherit the DB's privacy standing — no separate
// redaction machinery in Phase A.
export const TOOL_RUN_BODY_RETENTION_DAYS = 7;

type DatabaseClient = ReturnType<typeof getDatabase>;
type Executor =
  | DatabaseClient
  | Parameters<Parameters<DatabaseClient["transaction"]>[0]>[0];

// The loop's persistence seam bound to the real table. Runs are inserted
// `staged` before execution (so a process death mid-tool still leaves trace)
// and finished with the bounded result afterwards.
export const databaseToolRunRecorder: ToolRunRecorder = {
  async start(run: ToolRunStart): Promise<string> {
    const [row] = await getDatabase()
      .insert(toolRuns)
      .values({
        attemptId: run.attemptId,
        sessionId: run.sessionId,
        assistantMessageId: run.assistantMessageId,
        roundIndex: run.roundIndex,
        callIndex: run.callIndex,
        providerToolUseId: run.providerToolUseId,
        toolName: run.toolName,
        toolSchemaHash: run.toolSchemaHash,
        input: run.input,
        precedingText: run.precedingText,
        startedAt: run.startedAt,
      })
      .returning({ id: toolRuns.id });
    return row.id;
  },
  async finish(runId: string, finish: ToolRunFinish): Promise<void> {
    await getDatabase()
      .update(toolRuns)
      .set({
        resultContent: finish.resultContent,
        isError: finish.isError,
        errorCode: finish.errorCode,
        finishedAt: finish.finishedAt,
      })
      .where(eq(toolRuns.id, runId));
  },
};

// Status transitions are WHERE-guarded so they derive from commit state and
// stay idempotent: a retraction can never touch committed runs (lost-ACK
// safety), a commit never resurrects retracted ones.

export async function commitToolRuns(
  executor: Executor,
  attemptId: string,
): Promise<void> {
  await executor
    .update(toolRuns)
    .set({ status: "committed" })
    .where(
      and(eq(toolRuns.attemptId, attemptId), eq(toolRuns.status, "staged")),
    );
}

export async function retractToolRuns(
  executor: Executor,
  attemptId: string,
): Promise<void> {
  await executor
    .update(toolRuns)
    .set({ status: "retracted" })
    .where(
      and(eq(toolRuns.attemptId, attemptId), eq(toolRuns.status, "staged")),
    );
}

// Debris-sweep counterpart (MC-116A): when the sweep deletes a dead pair, the
// pair's still-staged runs are flagged by assistant id — the process that
// owned the attempt id is gone.
export async function retractToolRunsForAssistants(
  executor: Executor,
  assistantMessageIds: string[],
): Promise<void> {
  if (assistantMessageIds.length === 0) {
    return;
  }
  await executor
    .update(toolRuns)
    .set({ status: "retracted" })
    .where(
      and(
        inArray(toolRuns.assistantMessageId, assistantMessageIds),
        eq(toolRuns.status, "staged"),
      ),
    );
}

// A tail rewrite that discards a previously successful pair flags its runs
// superseded (MC-116B) — distinct from retracted: the exchange succeeded and
// was later unsaid, not failed.
export async function supersedeToolRunsForAssistant(
  executor: Executor,
  assistantMessageId: string,
): Promise<void> {
  await executor
    .update(toolRuns)
    .set({ status: "superseded" })
    .where(
      and(
        eq(toolRuns.assistantMessageId, assistantMessageId),
        eq(toolRuns.status, "committed"),
      ),
    );
}

export async function purgeExpiredToolRunBodies(
  executor: Executor,
  sessionId: string,
  now: Date,
): Promise<void> {
  const cutoff = new Date(
    now.getTime() - TOOL_RUN_BODY_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
  await executor
    .update(toolRuns)
    .set({
      input: null,
      resultContent: null,
      precedingText: null,
      purgedAt: now,
    })
    .where(
      and(
        eq(toolRuns.sessionId, sessionId),
        lt(toolRuns.createdAt, cutoff),
        isNull(toolRuns.purgedAt),
      ),
    );
}

// Trace/marker reader. Continuity modules must never import this module —
// the static import-boundary test enforces it.
export async function listToolRunsForAttempt(attemptId: string) {
  return getDatabase()
    .select()
    .from(toolRuns)
    .where(eq(toolRuns.attemptId, attemptId))
    .orderBy(asc(toolRuns.roundIndex), asc(toolRuns.callIndex));
}

// The §7.1 echo-marker capability: whether an assistant turn consumed tool
// results, queryable per turn. No continuity reader consumes this in Phase A.
export async function assistantTurnUsedTools(
  assistantMessageId: string,
): Promise<boolean> {
  const [row] = await getDatabase()
    .select({ id: toolRuns.id })
    .from(toolRuns)
    .where(eq(toolRuns.assistantMessageId, assistantMessageId))
    .limit(1);
  return Boolean(row);
}
