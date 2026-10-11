import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";

import type { ChatMessage } from "@/shared/types";

import { getDatabase } from "./client";
import {
  compareMessageCursors,
  messageRoleOrderSql,
} from "./message-cursor";
import { messages, sessions } from "./schema";

export async function listSessionMessages(
  sessionId: string,
  limit: number,
  offset: number,
): Promise<ChatMessage[]> {
  const roleOrder = sql<number>`
    case
      when ${messages.role} = 'user' then 0
      when ${messages.role} = 'assistant' then 1
      else 2
    end
  `;
  const rows = await getDatabase()
    .select({
      id: messages.id,
      role: messages.role,
      content: messages.content,
      thinking: messages.thinking,
      status: messages.status,
      inputTokens: messages.inputTokens,
      outputTokens: messages.outputTokens,
      metadata: messages.metadata,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.sessionId, sessionId))
    .orderBy(asc(messages.createdAt), roleOrder, asc(messages.id))
    .limit(limit)
    .offset(offset);

  return rows.map((row) => ({
    id: row.id,
    role: row.role,
    content: row.content,
    thinking: row.thinking ?? undefined,
    status: row.status,
    inputTokens: row.inputTokens ?? undefined,
    outputTokens: row.outputTokens ?? undefined,
    attemptId:
      typeof row.metadata.attemptId === "string"
        ? row.metadata.attemptId
        : undefined,
    supersedes:
      typeof row.metadata.supersedes === "string"
        ? row.metadata.supersedes
        : undefined,
    createdAt: row.createdAt.toISOString(),
  }));
}

// The rewritable-tail indicator (MC-116B decision 5): the tail user message
// id when the session ends in a complete exchange lying strictly after both
// the summary and extraction cursors, else null. Computed from the
// database's true tail — never inferred client-side from a paginated slice,
// which need not even contain the tail. An extraction-covered tail is the
// normal state of any resumed conversation, not an edge case.
export async function getRewritableTailId(
  sessionId: string,
): Promise<string | null> {
  const database = getDatabase();
  const [session] = await database
    .select({
      summaryThroughMessageId: sessions.summaryThroughMessageId,
      extractedThroughMessageId: sessions.extractedThroughMessageId,
    })
    .from(sessions)
    // Archived sessions mirror beginGeneration's filter: the indicator must
    // never advertise an affordance the send path deterministically rejects.
    .where(and(eq(sessions.id, sessionId), isNull(sessions.archivedAt)))
    .limit(1);
  if (!session) {
    return null;
  }

  const tail = await database
    .select({
      id: messages.id,
      role: messages.role,
      status: messages.status,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.sessionId, sessionId))
    .orderBy(
      desc(messages.createdAt),
      desc(messageRoleOrderSql()),
      desc(messages.id),
    )
    .limit(2);
  const [last, secondLast] = tail;
  if (
    !last ||
    last.role !== "assistant" ||
    last.status !== "complete" ||
    !secondLast ||
    secondLast.role !== "user" ||
    secondLast.status !== "complete"
  ) {
    return null;
  }

  const candidate = {
    id: secondLast.id,
    role: "user",
    createdAt: secondLast.createdAt,
  };
  for (const cursorId of [
    session.summaryThroughMessageId,
    session.extractedThroughMessageId,
  ]) {
    if (!cursorId) {
      continue;
    }
    const [cursorRow] = await database
      .select({
        id: messages.id,
        role: messages.role,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(and(eq(messages.sessionId, sessionId), eq(messages.id, cursorId)))
      .limit(1);
    if (cursorRow && compareMessageCursors(candidate, cursorRow) <= 0) {
      return null;
    }
  }
  return candidate.id;
}
