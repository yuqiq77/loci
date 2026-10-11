import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";

import { randomUUID } from "node:crypto";

import { isKnownModel } from "@/server/chat/models";
import { getEnabledTools } from "@/server/chat/tool-registry";
import type { TimedModelMessage } from "@/server/chat/types";
import { STALE_STREAMING_MS } from "@/shared/chat";
import type { ThinkingEffort } from "@/shared/types";

import { getDatabase } from "./client";
import {
  commitToolRuns,
  purgeExpiredToolRunBodies,
  retractToolRuns,
  retractToolRunsForAssistants,
  supersedeToolRunsForAssistant,
} from "./tool-runs";
import {
  afterMessageCondition,
  compareMessageCursors,
  messageRoleOrderSql,
  throughMessageCondition,
} from "./message-cursor";
import { messages, sessions, settings } from "./schema";

export type GenerationStart = {
  userMessageId: string;
  assistantMessageId: string;
  // Server-authoritative attempt identity for tool_runs (MC-117A), created
  // here — distinct from the client-stamped metadata attemptId that MC-116A
  // reconciliation uses.
  attemptId: string;
  // Tool-gate snapshot, immutable for the attempt: registration changes
  // after beginGeneration must not change this attempt's tool surface.
  enabledToolNames: string[];
  modelId: string;
  title: string;
  summary: string | null;
  summaryThroughMessageId: string | null;
  thinkingEnabled: boolean;
  thinkingEffort: ThinkingEffort;
  systemPrompt: string;
  standingContext: string;
  temperature: number;
  maxOutputTokens: number;
  contextTokenBudget: number;
  memoryTokenBudget: number;
  capsuleTokenBudget: number;
  memoryRetrievalLimit: number;
  webSearchEnabled: boolean;
  // The old pair a tail rewrite replaces (MC-116B), null on ordinary sends.
  // The route excludes these ids from model context and hands them to
  // completeGeneration for the commit-time swap; nothing deletes them here.
  supersededUserMessageId: string | null;
  supersededAssistantMessageId: string | null;
};


// Failure checks return a result union instead of throwing (MC-116A): the
// cleanupAttemptId residue deletion runs first inside the transaction, and a
// thrown rejection would roll it back — resurrecting the residue the client
// just reconciled away. The transaction commits, and the route maps
// non-started kinds to their HTTP errors afterwards.
export type BeginGenerationResult =
  | { kind: "started"; generation: GenerationStart }
  | { kind: "session_not_found" }
  | { kind: "generation_in_progress" }
  | { kind: "model_not_configured" }
  | { kind: "message_not_retryable" };

export async function beginGeneration(input: {
  sessionId: string;
  content: string;
  attemptId: string;
  cleanupAttemptId?: string;
  retryOfMessageId?: string;
  modelId?: string;
  now?: Date;
}): Promise<BeginGenerationResult> {
  const now = input.now ?? new Date();
  const assistantCreatedAt = new Date(now.getTime() + 1);
  const staleBefore = new Date(now.getTime() - STALE_STREAMING_MS);

  return getDatabase().transaction(async (tx): Promise<BeginGenerationResult> => {
    await tx.execute(
      sql`select id from sessions where id = ${input.sessionId} for update`,
    );

    // Deletes retracted rows, repositioning the summary cursor first: the
    // FK's onDelete would null it while the summary text stayed, and the
    // capsule requires cursor and summary together — a nulled cursor
    // silently drops the summary from model context.
    const deleteRetractedRows = async (
      rows: { id: string; role: string; createdAt: Date }[],
    ) => {
      const ids = rows.map((row) => row.id);
      const [cursorRow] = await tx
        .select({ cursor: sessions.summaryThroughMessageId })
        .from(sessions)
        .where(eq(sessions.id, input.sessionId))
        .limit(1);
      if (cursorRow?.cursor && ids.includes(cursorRow.cursor)) {
        const earliest = rows.reduce((left, right) =>
          compareMessageCursors(left, right) <= 0 ? left : right,
        );
        const [predecessor] = await tx
          .select({ id: messages.id })
          .from(messages)
          .where(
            and(
              eq(messages.sessionId, input.sessionId),
              throughMessageCondition(earliest),
              notInArray(messages.id, ids),
            ),
          )
          .orderBy(
            desc(messages.createdAt),
            desc(messageRoleOrderSql()),
            desc(messages.id),
          )
          .limit(1);
        await tx
          .update(sessions)
          .set({ summaryThroughMessageId: predecessor?.id ?? null })
          .where(eq(sessions.id, input.sessionId));
      }
      // A deleted pair's still-staged tool runs are flagged, never orphaned
      // (MC-117A): the owning process is gone, so the sweep is the only
      // remaining place their attempt can be closed out.
      await retractToolRunsForAssistants(
        tx,
        rows.filter((row) => row.role === "assistant").map((row) => row.id),
      );
      await tx.delete(messages).where(inArray(messages.id, ids));
    };

    // Terminal-residue cleanup, ahead of any validation and the insert: a
    // residue pair can itself occupy the session tail, and later checks must
    // see the tail as it will be after cleanup. Only the exact pair whose
    // user row carries the attempt id and whose adjacent assistant ended
    // terminally is deleted — a streaming pair is never touched.
    if (input.cleanupAttemptId) {
      const [residueUser] = await tx
        .select({ id: messages.id, createdAt: messages.createdAt })
        .from(messages)
        .where(
          and(
            eq(messages.sessionId, input.sessionId),
            eq(messages.role, "user"),
            sql`${messages.metadata} ->> 'attemptId' = ${input.cleanupAttemptId}`,
          ),
        )
        .limit(1);
      if (residueUser) {
        const [next] = await tx
          .select({
            id: messages.id,
            role: messages.role,
            status: messages.status,
            createdAt: messages.createdAt,
          })
          .from(messages)
          .where(
            and(
              eq(messages.sessionId, input.sessionId),
              afterMessageCondition({
                id: residueUser.id,
                role: "user",
                createdAt: residueUser.createdAt,
              }),
            ),
          )
          .orderBy(
            asc(messages.createdAt),
            messageRoleOrderSql(),
            asc(messages.id),
          )
          .limit(1);
        if (
          next &&
          next.role === "assistant" &&
          (next.status === "failed" || next.status === "cancelled")
        ) {
          await deleteRetractedRows([
            {
              id: residueUser.id,
              role: "user",
              createdAt: residueUser.createdAt,
            },
            { id: next.id, role: "assistant", createdAt: next.createdAt },
          ]);
        }
      }
    }

    // Debris sweep: stale streaming orphans (process death) and terminal
    // failed/cancelled pairs (degraded-mode discard failures, historical
    // debris). The messages table holds only successful exchanges plus the
    // single live streaming row; everything else is retracted here, so the
    // DB self-cleans even when no client ever supplies cleanupAttemptId.
    // Runs before the session row is read: the sweep may reposition the
    // summary cursor, and the snapshot returned to the route must carry the
    // repositioned value — a stale deleted id would make this request inject
    // the summary AND read full history at once.
    const debrisAssistants = await tx
      .select({ id: messages.id, createdAt: messages.createdAt })
      .from(messages)
      .where(
        and(
          eq(messages.sessionId, input.sessionId),
          eq(messages.role, "assistant"),
          or(
            and(
              eq(messages.status, "streaming"),
              lt(messages.createdAt, staleBefore),
            ),
            inArray(messages.status, ["failed", "cancelled"]),
          ),
        ),
      );
    for (const debris of debrisAssistants) {
      // The paired user message is the immediate predecessor in the
      // (createdAt, roleOrder, id) order — adjacency is the guard: a user
      // whose own exchange completed sits next to its complete assistant,
      // never next to debris.
      const [predecessor] = await tx
        .select({
          id: messages.id,
          role: messages.role,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .where(
          and(
            eq(messages.sessionId, input.sessionId),
            throughMessageCondition({
              id: debris.id,
              role: "assistant",
              createdAt: debris.createdAt,
            }),
            ne(messages.id, debris.id),
          ),
        )
        .orderBy(
          desc(messages.createdAt),
          desc(messageRoleOrderSql()),
          desc(messages.id),
        )
        .limit(1);
      const pair = [
        { id: debris.id, role: "assistant", createdAt: debris.createdAt },
      ];
      if (predecessor && predecessor.role === "user") {
        pair.push(predecessor);
      }
      await deleteRetractedRows(pair);
    }

    // Body retention (MC-117A): expired tool-run result/text bodies are
    // purged by this sweep; ids, statuses, timings, and the schema hash stay.
    await purgeExpiredToolRunBodies(tx, input.sessionId, now);

    const [session] = await tx
      .select({
        id: sessions.id,
        title: sessions.title,
        modelId: sessions.modelId,
        thinkingEnabled: sessions.thinkingEnabled,
        thinkingEffort: sessions.thinkingEffort,
        summary: sessions.summary,
        summaryThroughMessageId: sessions.summaryThroughMessageId,
        extractedThroughMessageId: sessions.extractedThroughMessageId,
      })
      .from(sessions)
      .where(
        and(
          eq(sessions.id, input.sessionId),
          isNull(sessions.archivedAt),
        ),
      )
      .limit(1);
    if (!session) {
      return { kind: "session_not_found" };
    }

    const modelId = input.modelId ?? session.modelId;
    if (!isKnownModel(modelId)) {
      return { kind: "model_not_configured" };
    }

    const [activeGeneration] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.sessionId, session.id),
          eq(messages.role, "assistant"),
          eq(messages.status, "streaming"),
        ),
      )
      .limit(1);
    if (activeGeneration) {
      return { kind: "generation_in_progress" };
    }

    // Tail-rewrite validation (MC-116B), after the streaming gate so a
    // concurrent generation reads as GENERATION_IN_PROGRESS, and after the
    // sweep so the tail is judged as it will be after cleanup. The target
    // must be the tail exchange's user message and lie strictly after both
    // cursors: once the episode boundary has passed and the exchange has
    // been absorbed into summary or memory, it can no longer be unsaid.
    let supersededUserMessageId: string | null = null;
    let supersededAssistantMessageId: string | null = null;
    if (input.retryOfMessageId) {
      const [target] = await tx
        .select({ id: messages.id, createdAt: messages.createdAt })
        .from(messages)
        .where(
          and(
            eq(messages.id, input.retryOfMessageId),
            eq(messages.sessionId, session.id),
            eq(messages.role, "user"),
            eq(messages.status, "complete"),
          ),
        )
        .limit(1);
      if (!target) {
        return { kind: "message_not_retryable" };
      }
      const targetCursor = {
        id: target.id,
        role: "user",
        createdAt: target.createdAt,
      };
      const [reply, after] = await tx
        .select({
          id: messages.id,
          role: messages.role,
          status: messages.status,
        })
        .from(messages)
        .where(
          and(
            eq(messages.sessionId, session.id),
            afterMessageCondition(targetCursor),
          ),
        )
        .orderBy(
          asc(messages.createdAt),
          messageRoleOrderSql(),
          asc(messages.id),
        )
        .limit(2);
      if (
        !reply ||
        reply.role !== "assistant" ||
        reply.status !== "complete" ||
        after
      ) {
        return { kind: "message_not_retryable" };
      }
      for (const cursorId of [
        session.summaryThroughMessageId,
        session.extractedThroughMessageId,
      ]) {
        if (!cursorId) {
          continue;
        }
        const [cursorRow] = await tx
          .select({
            id: messages.id,
            role: messages.role,
            createdAt: messages.createdAt,
          })
          .from(messages)
          .where(eq(messages.id, cursorId))
          .limit(1);
        if (cursorRow && compareMessageCursors(targetCursor, cursorRow) <= 0) {
          return { kind: "message_not_retryable" };
        }
      }
      supersededUserMessageId = target.id;
      supersededAssistantMessageId = reply.id;
    }

    const [configuration] = await tx
      .select()
      .from(settings)
      .where(eq(settings.id, 1))
      .limit(1);
    if (!configuration) {
      return { kind: "model_not_configured" };
    }

    const [userMessage] = await tx
      .insert(messages)
      .values({
        sessionId: session.id,
        role: "user",
        content: input.content,
        status: "complete",
        modelId,
        // supersedes is transient metadata, not a status: it exists only
        // while the replacement is in flight. Failure retracts the row and
        // the marker with it; success clears the key in the swap commit.
        metadata: {
          attemptId: input.attemptId,
          ...(supersededUserMessageId
            ? { supersedes: supersededUserMessageId }
            : {}),
        },
        createdAt: now,
        completedAt: now,
      })
      .returning({ id: messages.id });
    const [assistantMessage] = await tx
      .insert(messages)
      .values({
        sessionId: session.id,
        role: "assistant",
        content: "",
        status: "streaming",
        modelId,
        createdAt: assistantCreatedAt,
      })
      .returning({ id: messages.id });

    await tx
      .update(sessions)
      .set({ updatedAt: now })
      .where(eq(sessions.id, session.id));

    return {
      kind: "started",
      generation: {
        userMessageId: userMessage.id,
        assistantMessageId: assistantMessage.id,
        attemptId: randomUUID(),
        enabledToolNames: getEnabledTools(configuration.toolsEnabled).map(
          (tool) => tool.name,
        ),
        modelId,
        title: session.title,
        summary: session.summary,
        summaryThroughMessageId: session.summaryThroughMessageId,
        thinkingEnabled: session.thinkingEnabled,
        thinkingEffort: session.thinkingEffort as ThinkingEffort,
        systemPrompt: configuration.systemPrompt,
        standingContext: configuration.standingContext,
        temperature: configuration.temperature,
        maxOutputTokens: configuration.maxOutputTokens,
        contextTokenBudget: configuration.contextTokenBudget,
        memoryTokenBudget: configuration.memoryTokenBudget,
        capsuleTokenBudget: configuration.capsuleTokenBudget,
        memoryRetrievalLimit: configuration.memoryRetrievalLimit,
        webSearchEnabled: configuration.webSearchEnabled,
        supersededUserMessageId,
        supersededAssistantMessageId,
      },
    };
  });
}

// Commit-ambiguity probe (MC-116B owner review): when completeGeneration
// rejects, the transaction may still have committed with its acknowledgment
// lost. Returns the row's status, or null when the row is gone. Throws on a
// failed read — the caller must treat that as "unknown" and never retract.
export async function readMessageStatus(
  messageId: string,
): Promise<string | null> {
  const [row] = await getDatabase()
    .select({ status: messages.status })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);
  return row?.status ?? null;
}

export async function loadCompleteHistory(
  sessionId: string,
  currentUserMessageId: string,
  summaryThroughMessageId: string | null,
  // Extra ids to drop (MC-116B): the old pair a rewrite replaces, so the
  // replacement generates against the transcript as it will be after the
  // swap.
  excludeMessageIds: string[] = [],
): Promise<TimedModelMessage[]> {
  let cursor: { id: string; role: string; createdAt: Date } | undefined;
  if (summaryThroughMessageId) {
    [cursor] = await getDatabase()
      .select({
        id: messages.id,
        role: messages.role,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(eq(messages.id, summaryThroughMessageId))
      .limit(1);
  }

  const rows = await getDatabase()
    .select({
      role: messages.role,
      content: messages.content,
      status: messages.status,
      createdAt: messages.createdAt,
      completedAt: messages.completedAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        notInArray(messages.id, [currentUserMessageId, ...excludeMessageIds]),
        sql`${messages.role} in ('user', 'assistant')`,
        afterMessageCondition(cursor),
      ),
    )
    .orderBy(asc(messages.createdAt), messageRoleOrderSql(), asc(messages.id));

  const history: TimedModelMessage[] = [];
  let pendingUser: (typeof rows)[number] | null = null;

  for (const row of rows) {
    if (row.role === "user") {
      pendingUser = row.status === "complete" ? row : null;
      continue;
    }

    // An empty assistant row contributes nothing and poisons the provider
    // request: the cache breakpoint rolls onto the last settled history
    // message, and cache_control on an empty text block is a 400. The route
    // no longer persists empty completions (EMPTY_COMPLETION retracts), so
    // this is defense for rows that predate that fix.
    if (pendingUser && row.status === "complete" && row.content !== "") {
      history.push(
        {
          role: "user",
          content: pendingUser.content,
          // Complete rows carry completedAt; createdAt is the defensive
          // fallback for legacy rows so assembly never renders a null stamp.
          completedAt: pendingUser.completedAt ?? pendingUser.createdAt,
        },
        {
          role: "assistant",
          content: row.content,
          completedAt: row.completedAt ?? row.createdAt,
        },
      );
    }
    pendingUser = null;
  }

  return history;
}

export async function completeGeneration(input: {
  assistantMessageId: string;
  content: string;
  thinking?: string;
  inputTokens?: number;
  outputTokens?: number;
  usedWebSearch?: boolean;
  // Server attempt identity (MC-117A): the attempt's staged tool runs are
  // committed in the same transaction as the message completion.
  attemptId?: string;
  // Commit-on-success swap (MC-116B): delete the old pair and mark the
  // replacement complete in one transaction. Absent on ordinary sends.
  supersede?: {
    sessionId: string;
    userMessageId: string;
    assistantMessageId: string;
    replacementUserMessageId: string;
  };
}): Promise<void> {
  const completion = {
    content: input.content,
    thinking: input.thinking || null,
    status: "complete" as const,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    usedWebSearch: input.usedWebSearch ?? false,
    completedAt: new Date(),
  };
  const streamingReplacement = and(
    eq(messages.id, input.assistantMessageId),
    eq(messages.status, "streaming"),
  );
  if (!input.supersede) {
    // Without an attempt id (every attempt whose tool surface was empty —
    // all of MC-117A production) this stays the pre-117A single UPDATE.
    if (!input.attemptId) {
      await getDatabase()
        .update(messages)
        .set(completion)
        .where(streamingReplacement);
      return;
    }
    const attemptId = input.attemptId;
    await getDatabase().transaction(async (tx) => {
      const updated = await tx
        .update(messages)
        .set(completion)
        .where(streamingReplacement)
        .returning({ id: messages.id });
      // Runs commit only with an actually-completed message: a concurrently
      // swept row leaves them staged for the sweep to retract.
      if (updated.length === 1) {
        await commitToolRuns(tx, attemptId);
      }
    });
    return;
  }
  const supersede = input.supersede;
  await getDatabase().transaction(async (tx) => {
    // Same lock order as beginGeneration (session row first, then messages)
    // so the swap serializes against the debris sweep instead of racing the
    // ids it collected.
    await tx.execute(
      sql`select id from sessions where id = ${supersede.sessionId} for update`,
    );
    const updated = await tx
      .update(messages)
      .set(completion)
      .where(streamingReplacement)
      .returning({ id: messages.id });
    if (updated.length !== 1) {
      // The replacement was swept or failed concurrently — roll the whole
      // swap back; the old pair must never be deleted under a replacement
      // that did not actually complete.
      throw new Error("Replacement is no longer streaming; swap aborted.");
    }
    // If a summarize/extract job consumed the old pair while the replacement
    // streamed, deleting the row its cursor points at set-nulls the cursor
    // and the job rebuilds from scratch — the accepted degraded recovery
    // path (MC-116B decision 4), deliberately not repositioned here.
    await tx
      .delete(messages)
      .where(
        inArray(messages.id, [
          supersede.userMessageId,
          supersede.assistantMessageId,
        ]),
      );
    // Remove the single key, never overwrite the whole metadata object — a
    // whole-object write would destroy attemptId and break MC-116A
    // reconciliation.
    await tx
      .update(messages)
      .set({ metadata: sql`${messages.metadata} - 'supersedes'` })
      .where(eq(messages.id, supersede.replacementUserMessageId));
    // MC-117A × MC-116B: the discarded pair's committed runs become
    // superseded — the exchange succeeded and was later unsaid, not failed —
    // and the replacement attempt's staged runs commit, all in the swap
    // transaction.
    await supersedeToolRunsForAssistant(tx, supersede.assistantMessageId);
    if (input.attemptId) {
      await commitToolRuns(tx, input.attemptId);
    }
  });
}

export async function failGeneration(input: {
  assistantMessageId: string;
  content: string;
  errorCode: string;
  cancelled?: boolean;
}): Promise<void> {
  await getDatabase()
    .update(messages)
    .set({
      content: input.content,
      status: input.cancelled ? "cancelled" : "failed",
      errorCode: input.errorCode,
      completedAt: new Date(),
    })
    .where(
      and(
        eq(messages.id, input.assistantMessageId),
        eq(messages.status, "streaming"),
      ),
    );
}

export async function discardGeneration(input: {
  userMessageId: string;
  assistantMessageId: string;
  // Server attempt identity (MC-117A): retraction of the attempt's staged
  // tool runs is atomic with the pair deletion. The staged-only guard makes
  // it idempotent against commit state — a lost completion ACK can never
  // flip committed runs to retracted.
  attemptId?: string;
}): Promise<void> {
  await getDatabase().transaction(async (tx) => {
    if (input.attemptId) {
      await retractToolRuns(tx, input.attemptId);
    }
    await tx
      .delete(messages)
      .where(eq(messages.id, input.assistantMessageId));
    await tx
      .delete(messages)
      .where(eq(messages.id, input.userMessageId));
  });
}
