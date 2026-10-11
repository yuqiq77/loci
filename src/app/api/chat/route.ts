import { NextRequest, NextResponse } from "next/server";

import {
  buildChatContext,
  formatContextTime,
  formatLocalDay,
  logContinuityCapsuleTrace,
} from "@/server/chat/context";
import type { ModelMessage } from "@/server/chat/types";
import {
  assertChatProviderConfigured,
  getChatProvider,
} from "@/server/chat/anthropic";
import { modelSupportsTemperature } from "@/server/chat/models";
import { ProviderError } from "@/server/chat/provider-error";
import { chatRequestSchema } from "@/server/chat/schema";
import { encodeSse } from "@/server/chat/sse";
import { runToolLoop, TOOL_LOOP_DEADLINE_MS } from "@/server/chat/tool-loop";
import { resolveToolSnapshot } from "@/server/chat/tool-registry";
import { databaseToolRunRecorder } from "@/server/db/tool-runs";
import { requireOwner } from "@/server/auth/request";
import {
  beginGeneration,
  completeGeneration,
  discardGeneration,
  failGeneration,
  loadCompleteHistory,
  readMessageStatus,
} from "@/server/db/chat";
import { enqueueJob } from "@/server/db/jobs";
import { updateRecall } from "@/server/db/memories";
import {
  effectiveStandingContext,
  getRelationshipNarrative,
} from "@/server/db/narrative";
import { getRecentSnapshot } from "@/server/db/recent-snapshot";
import { errorResponse } from "@/server/http/errors";
import { isMemoryEnabled } from "@/server/memory/embedding";
import { retrieveMemories } from "@/server/memory/retrieve";
import { enqueueSummaryIfNeeded } from "@/server/summaries/summarize";
import { TOOL_LOOP_CONTEXT_RESERVE_TOKENS } from "@/shared/chat";
import { errorName } from "@/shared/errors";
import { DEFAULT_SESSION_TITLE } from "@/shared/sessions";

export const runtime = "nodejs";

function previousUserMessage(history: ModelMessage[]): string | null {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message.role === "user") {
      return message.content;
    }
  }
  return null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const unauthorized = await requireOwner(request);
  if (unauthorized) {
    return unauthorized;
  }

  const body = await request.json().catch(() => null);
  const parsed = chatRequestSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse("INVALID_INPUT");
  }

  try {
    assertChatProviderConfigured();
  } catch {
    return errorResponse("MODEL_NOT_CONFIGURED");
  }

  // beginGeneration commits its cleanupAttemptId residue deletion even when
  // the send itself is rejected — the union kinds map to HTTP errors here,
  // after the transaction has committed (MC-116A).
  let generation;
  try {
    const result = await beginGeneration(parsed.data);
    if (result.kind === "session_not_found") {
      return errorResponse("SESSION_NOT_FOUND");
    }
    if (result.kind === "generation_in_progress") {
      return errorResponse("GENERATION_IN_PROGRESS");
    }
    if (result.kind === "model_not_configured") {
      return errorResponse("MODEL_NOT_CONFIGURED");
    }
    if (result.kind === "message_not_retryable") {
      return errorResponse("MESSAGE_NOT_RETRYABLE");
    }
    generation = result.generation;
  } catch {
    return errorResponse("INTERNAL_ERROR");
  }
  // The attempt-wide clock starts the moment the attempt exists (decision
  // 4): context assembly and retrieval below spend from the same deadline
  // the loop enforces.
  const attemptDeadlineAt = Date.now() + TOOL_LOOP_DEADLINE_MS;

  const providerModel = generation.modelId;
  const provider = getChatProvider({
    webSearchEnabled: generation.webSearchEnabled,
  });
  // Tool surface for this attempt, resolved from the beginGeneration
  // snapshot. Empty unless the owner enabled client tools (tools_enabled,
  // default off) — the empty case is a pure passthrough.
  const enabledTools = resolveToolSnapshot(generation.enabledToolNames);
  // Only a tool-capable attempt threads its attempt id into completion and
  // retraction: without tools no run can exist, and skipping the id keeps
  // the production persistence path identical to pre-117A (single UPDATE,
  // no tool_runs touch).
  const toolAttemptId =
    enabledTools.length > 0 ? generation.attemptId : undefined;

  // From here to the stream construction the pair is committed but nothing
  // retracts it on a throw — the catch below discards, or the orphan would
  // block the session until the stale sweep (MC-116A review fix).
  // A rewrite generates against the transcript as it will be after the swap:
  // the old pair is excluded from the history read but stays untouched and
  // authoritative in the DB until completeGeneration commits (MC-116B).
  const supersededPair =
    generation.supersededUserMessageId &&
    generation.supersededAssistantMessageId
      ? {
          userMessageId: generation.supersededUserMessageId,
          assistantMessageId: generation.supersededAssistantMessageId,
        }
      : null;

  let messages: ModelMessage[];
  let retrievedMemories: Awaited<ReturnType<typeof retrieveMemories>> = [];
  try {
  const history = await loadCompleteHistory(
    parsed.data.sessionId,
    generation.userMessageId,
    generation.summaryThroughMessageId,
    supersededPair
      ? [supersededPair.userMessageId, supersededPair.assistantMessageId]
      : [],
  );
  // Fresh reads every turn are deliberate: snapshot writes are cursor-aligned
  // (decision D3), so per-session pinning is deferred until traces show real
  // cache cost. The two reads are independent and run in parallel; each
  // degrades on its own — a failed snapshot read drops the section, a failed
  // narrative read (MC-101R capsule source swap) falls back to the retained
  // standing-context field. Continuity failures never fail chat.
  const [recentSnapshot, narrative] = await Promise.all([
    getRecentSnapshot().catch((error) => {
      console.error("Recent snapshot read failed.", errorName(error));
      return null;
    }),
    getRelationshipNarrative().catch((error) => {
      console.error("Narrative read failed.", errorName(error));
      return null;
    }),
  ]);
  const standingContext = effectiveStandingContext(
    narrative,
    generation.standingContext,
  );
  if (isMemoryEnabled()) {
    try {
      retrievedMemories = await retrieveMemories({
        query: parsed.data.content,
        tokenBudget: generation.memoryTokenBudget,
        limit: generation.memoryRetrievalLimit,
        sessionId: parsed.data.sessionId,
        messageId: generation.userMessageId,
        summaryThroughMessageId: generation.summaryThroughMessageId,
        previousUserMessage: previousUserMessage(history),
        sessionSummary: generation.summary,
      });
    } catch (error) {
      console.error(
        "Memory retrieval failed.",
        error instanceof Error ? error.name : "UnknownError",
      );
    }
  }
  const context = buildChatContext({
    settings: {
      systemPrompt: generation.systemPrompt,
      standingContext,
      summary: generation.summary,
      summaryThroughMessageId: generation.summaryThroughMessageId,
      capsuleTokenBudget: generation.capsuleTokenBudget,
      contextTokenBudget: generation.contextTokenBudget,
      maxOutputTokens: generation.maxOutputTokens,
      toolLoopReserveTokens:
        enabledTools.length > 0 ? TOOL_LOOP_CONTEXT_RESERVE_TOKENS : 0,
    },
    history,
    currentUserMessage: parsed.data.content,
    memories: retrievedMemories.map(
      (memory) => `(${formatLocalDay(memory.createdAt)}) ${memory.content}`,
    ),
    recentSnapshot,
    currentTime: formatContextTime(new Date()),
  });
  messages = context.messages;
  logContinuityCapsuleTrace({
    sessionId: parsed.data.sessionId,
    standingContext,
    snapshotVersion: recentSnapshot?.version ?? null,
    snapshotAsOf: recentSnapshot ? formatLocalDay(recentSnapshot.asOf) : null,
    snapshotStale: recentSnapshot?.stale ?? null,
    summaryCursor: generation.summaryThroughMessageId,
    capsuleTokenBudget: generation.capsuleTokenBudget,
    capsule: context.capsule,
  });
  } catch (error) {
    console.error(
      "Chat setup failed after beginGeneration.",
      errorName(error),
    );
    try {
      await failGeneration({
        assistantMessageId: generation.assistantMessageId,
        content: "",
        errorCode: "INTERNAL_ERROR",
      });
    } catch (markError) {
      console.error(
        "Failed to mark failed generation.",
        errorName(markError),
      );
    }
    try {
      await discardGeneration({
        userMessageId: generation.userMessageId,
        assistantMessageId: generation.assistantMessageId,
        attemptId: toolAttemptId,
      });
    } catch (discardError) {
      console.error(
        "Failed to retract failed generation.",
        errorName(discardError),
      );
    }
    return errorResponse("INTERNAL_ERROR");
  }

  const upstream = new AbortController();
  const abortUpstream = () => upstream.abort(request.signal.reason);
  if (request.signal.aborted) {
    abortUpstream();
  } else {
    request.signal.addEventListener("abort", abortUpstream, { once: true });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let content = "";
      let thinking = "";
      // Set the moment completeGeneration commits: past that point the
      // exchange is durable and the catch below must not retract — for a
      // rewrite the swap has already deleted the old pair, so a discard
      // here would destroy BOTH pairs (review finding, 2026-08-02). The
      // reachable post-commit throw is the done enqueue against a stream
      // the client disconnected from.
      let completed = false;
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;
      let cacheCreationInputTokens: number | undefined;
      let cacheReadInputTokens: number | undefined;
      let usedWebSearch = false;

      controller.enqueue(
        encodeSse("message", {
          userMessageId: generation.userMessageId,
          assistantMessageId: generation.assistantMessageId,
        }),
      );

      try {
        let recallStarted = false;
        for await (const chunk of runToolLoop({
          provider,
          request: {
            model: providerModel,
            messages,
            temperature: modelSupportsTemperature(providerModel)
              ? generation.temperature
              : undefined,
            maxOutputTokens: generation.maxOutputTokens,
            thinkingEnabled: generation.thinkingEnabled,
            thinkingEffort: generation.thinkingEffort,
          },
          tools: enabledTools,
          attempt: {
            attemptId: generation.attemptId,
            sessionId: parsed.data.sessionId,
            assistantMessageId: generation.assistantMessageId,
          },
          deadlineAt: attemptDeadlineAt,
          excludeMemoryIds: retrievedMemories.map((memory) => memory.id),
          recorder: databaseToolRunRecorder,
          signal: upstream.signal,
        })) {
          if (!recallStarted && retrievedMemories.length > 0) {
            recallStarted = true;
            void updateRecall(
              retrievedMemories.map((memory) => memory.id),
              {
                sessionId: parsed.data.sessionId,
                messageId: generation.userMessageId,
              },
            ).catch((error) => {
              console.error(
                "Failed to update memory recall metadata.",
                error instanceof Error ? error.name : "UnknownError",
              );
            });
          }
          if (chunk.type === "text") {
            content += chunk.text;
            controller.enqueue(encodeSse("delta", { text: chunk.text }));
          } else if (chunk.type === "thinking") {
            thinking += chunk.text;
            controller.enqueue(encodeSse("thinking", { text: chunk.text }));
          } else if (chunk.type === "usage") {
            inputTokens = chunk.inputTokens ?? inputTokens;
            outputTokens = chunk.outputTokens ?? outputTokens;
            cacheCreationInputTokens =
              chunk.cacheCreationInputTokens ?? cacheCreationInputTokens;
            cacheReadInputTokens =
              chunk.cacheReadInputTokens ?? cacheReadInputTokens;
            controller.enqueue(
              encodeSse("usage", {
                inputTokens,
                outputTokens,
                cacheCreationInputTokens,
                cacheReadInputTokens,
              }),
            );
          } else if (chunk.type === "search") {
            usedWebSearch = true;
            controller.enqueue(encodeSse("search", {}));
          } else if (chunk.type === "tool_status") {
            // Transient execution status (MC-117A): typed, distinct from
            // text/thinking, never persisted as assistant prose. The wire
            // payload carries no more than the UI can act on today.
            controller.enqueue(
              encodeSse("tool", {
                status: chunk.status,
                toolName: chunk.toolName,
              }),
            );
          } else if (chunk.type === "content_block") {
            // Consumed inside the loop for replay; never forwarded. Handled
            // explicitly so a done chunk stays the only completion trigger.
          } else if (chunk.type === "done") {
            // Zero text is not a successful exchange (owner dogfooding,
            // 2026-08-05: thinking consumed the whole token budget). It
            // must not persist as a complete row — the cache breakpoint
            // lands on the last settled history message, so an empty
            // assistant block 400s every later send in the session
            // ("cache_control cannot be set for empty text blocks").
            // Throw into the shared failure path: the pair is retracted
            // and the client gets the notice + Retry.
            if (!content) {
              throw new ProviderError(
                "EMPTY_COMPLETION",
                "The provider returned no text; the token budget may have been consumed by thinking.",
              );
            }
            try {
              await completeGeneration({
                assistantMessageId: generation.assistantMessageId,
                content,
                thinking,
                inputTokens,
                outputTokens,
                usedWebSearch,
                attemptId: toolAttemptId,
                // The swap — delete the old pair, mark the replacement
                // complete — happens atomically in there; a throw falls
                // into the catch below, which retracts only the
                // replacement.
                ...(supersededPair
                  ? {
                      supersede: {
                        sessionId: parsed.data.sessionId,
                        userMessageId: supersededPair.userMessageId,
                        assistantMessageId:
                          supersededPair.assistantMessageId,
                        replacementUserMessageId: generation.userMessageId,
                      },
                    }
                  : {}),
              });
            } catch (completionError) {
              // The rejection may be a lost acknowledgment on a committed
              // transaction (owner review, 2026-08-05). Read the row back:
              // only a provably uncommitted outcome may fall through to the
              // retraction path — after a committed swap the replacement is
              // the only surviving copy of the tail.
              let status: string | null;
              try {
                status = await readMessageStatus(
                  generation.assistantMessageId,
                );
              } catch {
                // Truly ambiguous: never retract on uncertainty. A
                // still-streaming row is the stale sweep's to clean; the
                // client reconciles by attemptId either way.
                completed = true;
                throw completionError;
              }
              if (status !== "complete") {
                // Rolled back (streaming) or already swept (absent): the
                // old pair is intact, retraction is safe or a no-op.
                throw completionError;
              }
              // Committed with the ack lost — continue the success path.
            }
            completed = true;
            try {
              await enqueueSummaryIfNeeded(parsed.data.sessionId);
            } catch (error) {
              console.error(
                "Failed to enqueue summary check.",
                error instanceof Error ? error.name : "UnknownError",
              );
            }
            // Fire-and-forget (same pattern as updateRecall): the enqueue
            // transaction must not delay the done event or the stream close,
            // and starting it before the done write means a client disconnect
            // at end-of-stream cannot skip it.
            if (generation.title === DEFAULT_SESSION_TITLE) {
              void enqueueJob("title_session", {
                sessionId: parsed.data.sessionId,
              }).catch((error) => {
                console.error(
                  "Failed to enqueue session title job.",
                  errorName(error),
                );
              });
            }
            controller.enqueue(
              encodeSse("done", {
                assistantMessageId: generation.assistantMessageId,
                finishReason: chunk.finishReason,
              }),
            );
            break;
          }
        }
      } catch (error) {
        if (completed) {
          // The exchange committed before the throw: there is nothing to
          // retract, and retracting anyway would delete a completed pair —
          // after a swap, the only surviving copy of the conversation tail.
          // The finally below owns the cleanup.
          console.error(
            "Stream failed after completion; nothing to retract.",
            errorName(error),
          );
          return;
        }
        // Any abnormal stream end retracts the pair (MC-116A): provider
        // failure, provider timeout, client abort and network drop are
        // indistinguishable or equivalent here and all get the same
        // treatment. Mark first so a failed delete degrades to a visible
        // failed row instead of silent debris.
        const cancelled = upstream.signal.aborted;
        let retracted = false;
        const errorCode =
          error instanceof ProviderError
            ? error.code
            : cancelled
              ? "GENERATION_CANCELLED"
              : "PROVIDER_UNAVAILABLE";
        // The mark is best-effort context for the degraded mode — a failed
        // mark must not skip the discard, or nothing is unconditional.
        try {
          await failGeneration({
            assistantMessageId: generation.assistantMessageId,
            content,
            errorCode,
            cancelled,
          });
        } catch (markError) {
          console.error(
            "Failed to mark failed generation.",
            markError instanceof Error ? markError.name : "UnknownError",
          );
        }
        try {
          await discardGeneration({
            userMessageId: generation.userMessageId,
            assistantMessageId: generation.assistantMessageId,
            attemptId: toolAttemptId,
          });
          retracted = true;
        } catch (discardError) {
          console.error(
            "Failed to retract failed generation.",
            discardError instanceof Error
              ? discardError.name
              : "UnknownError",
          );
        }
        // A cancelled client cannot receive the error event.
        if (!cancelled) {
          console.error(
            "Chat generation failed.",
            error instanceof Error
              ? `${error.name}: ${error.message}`
              : "UnknownError",
          );
          controller.enqueue(
            encodeSse("error", {
              code: "PROVIDER_UNAVAILABLE",
              message: "Generation failed.",
              retracted,
            }),
          );
        }
      } finally {
        request.signal.removeEventListener("abort", abortUpstream);
        controller.close();
      }
    },
    cancel() {
      upstream.abort();
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      "Content-Type": "text/event-stream; charset=utf-8",
      Connection: "keep-alive",
    },
  });
}
