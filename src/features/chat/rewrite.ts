import type { ChatMessage } from "@/shared/types";

import type { TailObservation } from "./reconcile";

// Tail-rewrite rendering rules (MC-116B). While a replacement streams, a GET
// returns old pair + replacement pair; only the hide rule keeps the UI
// single-tailed. The old pair is never deleted client-side before the server
// commits the swap — hiding is a render-time filter, so restoration after a
// failure is free.

// Ids to hide from the rendered list: the superseded pair of every
// *streaming* replacement (reload/refetch mid-rewrite carries the marker in
// message metadata), plus the pair this page is optimistically rewriting
// (the local rows carry no marker between click and refetch). A retracted
// replacement leaves nothing referencing the old pair, so it renders
// normally again.
export function hiddenPairIds(
  messages: ChatMessage[],
  localSupersededUserIds: string[],
): Set<string> {
  const supersededUserIds = new Set(localSupersededUserIds);
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== "user" || !message.supersedes) {
      continue;
    }
    const reply = messages[index + 1];
    if (reply && reply.role === "assistant" && reply.status === "streaming") {
      supersededUserIds.add(message.supersedes);
    }
  }
  const hidden = new Set<string>();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== "user" || !supersededUserIds.has(message.id)) {
      continue;
    }
    hidden.add(message.id);
    const reply = messages[index + 1];
    if (reply && reply.role === "assistant") {
      hidden.add(reply.id);
    }
  }
  return hidden;
}

// Drops the superseded pair from local state once the swap has committed —
// the hidden rows are already gone from the server, so the done handler has
// nothing else to do.
export function removeSupersededPair(
  messages: ChatMessage[],
  supersededUserId: string,
): ChatMessage[] {
  const index = messages.findIndex(
    (message) => message.role === "user" && message.id === supersededUserId,
  );
  if (index === -1) {
    return messages;
  }
  const reply = messages[index + 1];
  const removed = new Set([messages[index].id]);
  if (reply && reply.role === "assistant") {
    removed.add(reply.id);
  }
  return messages.filter((message) => !removed.has(message.id));
}

// Whether a failed rewrite's Retry re-attempts the rewrite or falls back to
// the composer. Only a *retracted* observation reveals the DB's true tail:
// while the failed replacement itself still occupies it (orphaned streaming
// past the stale deadline, or terminal residue), the indicator is null
// BECAUSE of the replacement — the send-path sweep clears it, so the
// re-attempt proceeds and the server's MESSAGE_NOT_RETRYABLE stays the
// backstop. A retracted attempt whose target no longer matches the
// indicator means the tail truly moved or the episode boundary passed:
// clear the notice and hand the content to the user.
export function decideRewriteRetry(
  observation: TailObservation["kind"],
  rewritableTailId: string | null,
  retryOfMessageId: string,
): "re_attempt" | "composer_fallback" {
  if (observation !== "retracted") {
    return "re_attempt";
  }
  return rewritableTailId === retryOfMessageId
    ? "re_attempt"
    : "composer_fallback";
}

// When a send's `message` SSE arrives, the server holds exactly one
// in-flight row for the session — any other locally rendered streaming
// assistant is a phantom from a reload (its pair was swept server-side by
// this very send). Drop it and its adjacent user row, mirroring the server
// sweep's adjacency pairing, so a phantom never renders as a duplicate
// alongside the new exchange.
export function dropStaleStreaming(
  messages: ChatMessage[],
  keepAssistantId: string,
): ChatMessage[] {
  const removed = new Set<string>();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (
      message.role === "assistant" &&
      message.status === "streaming" &&
      message.id !== keepAssistantId
    ) {
      removed.add(message.id);
      const previous = messages[index - 1];
      if (previous && previous.role === "user") {
        removed.add(previous.id);
      }
    }
  }
  if (removed.size === 0) {
    return messages;
  }
  return messages.filter((message) => !removed.has(message.id));
}
