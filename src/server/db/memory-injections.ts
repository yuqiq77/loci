import {
  and,
  desc,
  eq,
  gt,
  inArray,
  ne,
} from "drizzle-orm";

import { getDatabase } from "./client";
import { memoryInjections, messages } from "./schema";

export const SUPPRESSION_FALLBACK_TURNS = 10;

export type MemoryInjectionDecision = {
  sessionId: string;
  messageId: string;
  memoryId: string;
  kind: string;
  similarity: number;
  score: number;
  injected: boolean;
  suppressionReason: string | null;
};

export async function insertMemoryInjectionTraces(
  decisions: MemoryInjectionDecision[],
): Promise<void> {
  if (decisions.length === 0) {
    return;
  }

  await getDatabase().insert(memoryInjections).values(decisions);
}

export async function listTracedMemoryIdsForSession(input: {
  sessionId: string;
  memoryIds: string[];
  excludeMessageId?: string;
}): Promise<Set<string>> {
  if (input.memoryIds.length === 0) {
    return new Set();
  }

  const rows = await getDatabase()
    .select({ memoryId: memoryInjections.memoryId })
    .from(memoryInjections)
    .where(
      and(
        eq(memoryInjections.sessionId, input.sessionId),
        eq(memoryInjections.injected, true),
        inArray(memoryInjections.memoryId, input.memoryIds),
        input.excludeMessageId
          ? ne(memoryInjections.messageId, input.excludeMessageId)
          : undefined,
      ),
    );

  return new Set(rows.map((row) => row.memoryId));
}

async function recentTurnMessageIds(input: {
  sessionId: string;
  currentMessageId: string;
}): Promise<string[]> {
  const rows = await getDatabase()
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, input.sessionId),
        eq(messages.role, "user"),
        eq(messages.status, "complete"),
        ne(messages.id, input.currentMessageId),
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(SUPPRESSION_FALLBACK_TURNS);

  return rows.map((row) => row.id);
}

export async function listRecentlyInjectedMemoryIds(input: {
  sessionId: string;
  currentMessageId: string;
  summaryThroughMessageId: string | null;
}): Promise<Set<string>> {
  if (input.summaryThroughMessageId) {
    const [cursor] = await getDatabase()
      .select({ createdAt: messages.createdAt })
      .from(messages)
      .where(eq(messages.id, input.summaryThroughMessageId))
      .limit(1);

    if (cursor) {
      const rows = await getDatabase()
        .select({ memoryId: memoryInjections.memoryId })
        .from(memoryInjections)
        .innerJoin(messages, eq(messages.id, memoryInjections.messageId))
        .where(
          and(
            eq(memoryInjections.sessionId, input.sessionId),
            eq(memoryInjections.injected, true),
            ne(memoryInjections.messageId, input.currentMessageId),
            gt(messages.createdAt, cursor.createdAt),
          ),
        );

      return new Set(rows.map((row) => row.memoryId));
    }
  }

  const messageIds = await recentTurnMessageIds(input);
  if (messageIds.length === 0) {
    return new Set();
  }

  const rows = await getDatabase()
    .select({ memoryId: memoryInjections.memoryId })
    .from(memoryInjections)
    .where(
      and(
        eq(memoryInjections.sessionId, input.sessionId),
        eq(memoryInjections.injected, true),
        inArray(memoryInjections.messageId, messageIds),
      ),
    );

  return new Set(rows.map((row) => row.memoryId));
}
