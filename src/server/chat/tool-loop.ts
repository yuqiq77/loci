import { CHAT_TIMEOUT_MS, TOOL_LOOP_RESULT_TOKEN_BUDGET } from "@/shared/chat";

import { estimateTextTokens } from "./context";
import { ProviderError } from "./provider-error";
import {
  toolSchemaHash,
  serializeToolDefinition,
  type RegisteredTool,
} from "./tool-registry";
import type {
  AssistantContentBlock,
  ChatChunk,
  ChatProvider,
  ChatRequest,
  ProviderToolResultBlock,
  ProviderToolUseBlock,
  ProviderTurn,
} from "./types";

// Attempt-wide budgets (MC-117A decision 4). Code constants next to the loop
// by charter — no settings surface; first-cut values, tuned from dogfood
// logs. Every count and clock below spans the whole attempt: a round can
// never reset any of them.
export const TOOL_LOOP_MAX_ROUNDS = 4; // 3 tool rounds + final
// pause_turn continuations are provider-side long-turn plumbing (typically
// hosted web_search), not tool rounds — they get their own bound so a
// search-heavy reply cannot starve the tool budget or strand the final round.
export const TOOL_LOOP_MAX_PAUSE_TURNS = 4;
export const TOOL_LOOP_MAX_TOOL_CALLS = 6;
export const TOOL_RESULT_TOKEN_BUDGET = 800; // estimated, per result
// The attempt-total result budget and the context reserve live in
// @/shared/chat: the settings schema needs the reserve client-side.
export const TOOL_LOOP_MAX_RECOVERABLE_FAILURES = 2;
// One wall-clock deadline starting at beginGeneration: the route mints the
// absolute deadlineAt when the attempt begins and the loop only spends what
// is left, so context assembly and retrieval draw from the same clock. The
// per-`provider.stream` timeout still exists but resets every round; the
// absolute deadline is the binding clock.
export const TOOL_LOOP_DEADLINE_MS = CHAT_TIMEOUT_MS;

// Forced finalization is soft first (owner decision 2026-09-05): the last
// permitted round keeps tool_choice auto — a tool_choice change invalidates
// the messages-tier prompt cache — and appends this hint after the round's
// tool results (append-only, so replayed history also passes preserved-
// thinking checks). Only if the model still calls a tool does one bounded
// hard round pin tool_choice to none; a tool call on that round is a
// protocol violation and fails the attempt.
export const TOOL_LOOP_FINAL_HINT =
  "The tool budget for this reply is exhausted. Answer now from the results you already have; do not call any more tools.";

export type ToolLoopForceFinalReason =
  | "round_cap"
  | "failure_cap"
  | "call_cap"
  | "result_budget";

export type ToolLoopFinalMode = "natural" | "soft" | "hard";

export type ToolStatusChunk = {
  type: "tool_status";
  status: "running" | "ok" | "error";
  toolName: string;
  roundIndex: number;
};

export type ToolLoopChunk = ChatChunk | ToolStatusChunk;

export type ToolRunStart = {
  attemptId: string;
  sessionId: string;
  assistantMessageId: string;
  roundIndex: number;
  callIndex: number;
  providerToolUseId: string;
  toolName: string;
  toolSchemaHash: string | null;
  input: Record<string, unknown>;
  precedingText: string | null;
  startedAt: Date;
};

export type ToolRunFinish = {
  resultContent: string | null;
  isError: boolean;
  errorCode: ToolRunErrorCode | null;
  finishedAt: Date;
};

// Persistence seam: the route passes the tool_runs recorder, unit tests an
// in-memory one. A failed trace write fails the attempt — the trace is part
// of the contract (`tool_runs` by construction), not best-effort telemetry.
export type ToolRunRecorder = {
  start(run: ToolRunStart): Promise<string>;
  finish(runId: string, finish: ToolRunFinish): Promise<void>;
};

// Machine-facing tool-run error codes recorded on tool_runs.error_code and
// enforced at the type level so a typo'd code cannot compile.
export type ToolRunErrorCode =
  | "unknown_tool"
  | "invalid_input"
  | "call_budget_exhausted"
  | "result_budget_exhausted"
  | "final_round_violation"
  | "tool_error";

const TRUNCATION_MARKER = "\n[truncated: result budget]";

function sliceToTokenBudget(text: string, budget: number): string {
  let clamped = text;
  let tokens = estimateTextTokens(clamped);
  while (clamped.length > 0 && tokens > budget) {
    // Cut proportionally to the current chars-per-token ratio so this
    // converges in a couple of passes instead of shaving char by char.
    const cut = Math.max(
      1,
      Math.ceil(((tokens - budget) * clamped.length) / tokens),
    );
    clamped = clamped.slice(0, clamped.length - cut);
    tokens = estimateTextTokens(clamped);
  }
  return clamped;
}

// Truncates to an estimated token budget on whole characters — deliberately
// not whole-unit trimming: a machine-facing result can be one huge unit, and
// dropping it entirely would starve the model. The truncation marker spends
// from the same budget (owner review 2026-08-29: it previously rode on top,
// so truncated results could push the attempt total past its cap). A zero
// budget yields the empty string. Estimation only — provider tokenizer
// numbers are a different accounting domain.
function clampToTokenBudget(text: string, budget: number): string {
  if (budget <= 0) {
    return "";
  }
  if (estimateTextTokens(text) <= budget) {
    return text;
  }
  const bodyBudget = budget - estimateTextTokens(TRUNCATION_MARKER);
  if (bodyBudget <= 0) {
    return sliceToTokenBudget(text, budget);
  }
  return `${sliceToTokenBudget(text, bodyBudget)}${TRUNCATION_MARKER}`;
}

// Empty text blocks (a start/stop pair with no deltas) are legal on the
// stream but rejected by the API when replayed; drop them from continuation
// turns.
function replayableBlocks(
  blocks: AssistantContentBlock[],
): AssistantContentBlock[] {
  return blocks.filter(
    (block) => !(block.type === "text" && block.text === ""),
  );
}

function addUsage(
  total: number | undefined,
  round: number | undefined,
): number | undefined {
  if (total === undefined && round === undefined) {
    return undefined;
  }
  return (total ?? 0) + (round ?? 0);
}

// One absolute attempt deadline chained onto the caller's abort signal —
// shared by the loop and the passthrough continuation so no round can ever
// reset the clock. `hit()` distinguishes the deadline firing from a caller
// abort; `cleanup()` must run in the caller's finally.
function attemptDeadline(
  deadlineAt: number,
  callerSignal: AbortSignal,
): { signal: AbortSignal; hit: () => boolean; cleanup: () => void } {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(callerSignal.reason);
  if (callerSignal.aborted) {
    abortFromCaller();
  } else {
    callerSignal.addEventListener("abort", abortFromCaller, { once: true });
  }
  let deadlineHit = false;
  const timer = setTimeout(
    () => {
      deadlineHit = true;
      controller.abort();
    },
    Math.max(0, deadlineAt - Date.now()),
  );
  return {
    signal: controller.signal,
    hit: () => deadlineHit,
    cleanup: () => {
      clearTimeout(timer);
      callerSignal.removeEventListener("abort", abortFromCaller);
    },
  };
}

// Passthrough with server-tool pause continuation (standalone fix,
// 2026-08-31 owner review of MC-117B): a provider-hosted tool (web_search)
// can end a response with stop_reason "pause_turn", and the paused response
// must be resent as-is until a non-pause stop — pre-fix, the route treated
// the pause as done and the answer truncated. The passthrough contract is
// kept: text streams live (a pause continuation appends, it never revises),
// the wire request is unchanged (collectBlocks is process-local, never
// serialized), and usage accumulates so the client sees attempt totals.
// Unlike the loop path, cap overflow completes with what already streamed
// instead of throwing: the client has seen the text, and retracting a
// visible answer is exactly the artifact class buffering exists to prevent.
// All rounds share the attempt's absolute deadline (owner review
// 2026-08-31): the per-stream provider timer resets on every continuation,
// so without the shared clock four pauses could run ~25 minutes — past the
// 6-minute stale-streaming window, where a concurrent send's debris sweep
// would retract the still-active generation.
async function* streamWithPauseContinuation(input: {
  provider: ChatProvider;
  request: ChatRequest;
  deadlineAt: number;
  signal: AbortSignal;
}): AsyncIterable<ChatChunk> {
  const deadline = attemptDeadline(input.deadlineAt, input.signal);
  const toolTurns: ProviderTurn[] = [];
  let pauses = 0;
  const totals: {
    inputTokens?: number;
    outputTokens?: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
  } = {};
  try {
  while (true) {
    let finishReason: string | undefined;
    let sawDone = false;
    const roundBlocks: AssistantContentBlock[] = [];
    const roundUsage: typeof totals = {};
    for await (const chunk of input.provider.stream(
      {
        ...input.request,
        collectBlocks: true,
        ...(toolTurns.length > 0 ? { toolTurns } : {}),
      },
      deadline.signal,
    )) {
      if (chunk.type === "content_block") {
        roundBlocks.push(chunk.block);
      } else if (chunk.type === "usage") {
        roundUsage.inputTokens = chunk.inputTokens ?? roundUsage.inputTokens;
        roundUsage.outputTokens =
          chunk.outputTokens ?? roundUsage.outputTokens;
        roundUsage.cacheCreationInputTokens =
          chunk.cacheCreationInputTokens ?? roundUsage.cacheCreationInputTokens;
        roundUsage.cacheReadInputTokens =
          chunk.cacheReadInputTokens ?? roundUsage.cacheReadInputTokens;
        yield {
          type: "usage",
          inputTokens: addUsage(totals.inputTokens, roundUsage.inputTokens),
          outputTokens: addUsage(totals.outputTokens, roundUsage.outputTokens),
          cacheCreationInputTokens: addUsage(
            totals.cacheCreationInputTokens,
            roundUsage.cacheCreationInputTokens,
          ),
          cacheReadInputTokens: addUsage(
            totals.cacheReadInputTokens,
            roundUsage.cacheReadInputTokens,
          ),
        };
      } else if (chunk.type === "done") {
        // Held for the pause decision below. Breaking here preserves the
        // pre-fix contract that nothing after done is ever forwarded.
        finishReason = chunk.finishReason;
        sawDone = true;
        break;
      } else {
        yield chunk;
      }
    }
    if (!sawDone) {
      // A clean EOF without a done chunk is a truncated stream, not a
      // completion. The Anthropic adapter already rejects it upstream;
      // this guard keeps a future provider from committing a partial
      // answer as success.
      throw new ProviderError(
        "PROVIDER_UNAVAILABLE",
        "Provider stream ended without a done chunk.",
      );
    }
    totals.inputTokens = addUsage(totals.inputTokens, roundUsage.inputTokens);
    totals.outputTokens = addUsage(
      totals.outputTokens,
      roundUsage.outputTokens,
    );
    totals.cacheCreationInputTokens = addUsage(
      totals.cacheCreationInputTokens,
      roundUsage.cacheCreationInputTokens,
    );
    totals.cacheReadInputTokens = addUsage(
      totals.cacheReadInputTokens,
      roundUsage.cacheReadInputTokens,
    );

    if (finishReason === "pause_turn" && pauses < TOOL_LOOP_MAX_PAUSE_TURNS) {
      pauses += 1;
      const replay = replayableBlocks(roundBlocks);
      if (replay.length > 0) {
        toolTurns.push({ role: "assistant", blocks: replay });
      }
      continue;
    }
    yield { type: "done", finishReason };
    return;
  }
  } catch (error) {
    if (deadline.hit()) {
      throw new ProviderError(
        "GENERATION_TIMEOUT",
        "Attempt deadline elapsed during pause continuation.",
      );
    }
    throw error;
  } finally {
    deadline.cleanup();
  }
}

export async function* runToolLoop(input: {
  provider: ChatProvider;
  request: ChatRequest;
  tools: RegisteredTool[];
  attempt: {
    attemptId: string;
    sessionId: string;
    assistantMessageId: string;
  };
  // Absolute epoch-ms deadline minted when the attempt began
  // (beginGeneration success), not when the loop starts: pre-loop context
  // assembly and retrieval spend from the same attempt-wide clock.
  deadlineAt: number;
  // Route-held IDs of memories already injected as automatic anchors this
  // request; handed to every tool execution (MC-117B decision 3).
  excludeMemoryIds: readonly string[];
  recorder: ToolRunRecorder;
  signal: AbortSignal;
}): AsyncIterable<ToolLoopChunk> {
  // Empty registry snapshot (all of production in 117A): passthrough with
  // live text streaming — no client tools field on the wire, no buffering,
  // unchanged prompt-cache identity. Provider-hosted pause_turn is the one
  // event that continues the stream across rounds; every round spends from
  // the same absolute attempt deadline (a continuation must not reset the
  // clock past the stale-streaming window).
  if (input.tools.length === 0) {
    yield* streamWithPauseContinuation(input);
    return;
  }

  const wireTools = input.tools.map((tool) => serializeToolDefinition(tool));
  const toolsByName = new Map(input.tools.map((tool) => [tool.name, tool]));
  const deadline = attemptDeadline(input.deadlineAt, input.signal);

  const toolTurns: ProviderTurn[] = [];
  let totalToolCalls = 0;
  let totalResultTokens = 0;
  let recoverableFailures = 0;
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
  const roundTraces: Record<string, unknown>[] = [];
  // Text carried across pause_turn continuations of one logical response;
  // reset when a tool round captures it as that round's preceding text.
  let carryText = "";
  // Forced-final state (soft first, hard fallback). The first trigger is
  // kept for the trace; hardFinal flips once the model calls a tool on the
  // soft round; the hint is appended to a user turn at most once per mode.
  let forceFinalReason: ToolLoopForceFinalReason | null = null;
  let hardFinal = false;
  let hintAppended = false;
  let finalMode: ToolLoopFinalMode = "natural";
  let finalTextChars = 0;
  // Round bookkeeping lives at attempt scope so a round that throws
  // mid-stream still folds the usage the provider already billed into the
  // totals and leaves a trace entry (flagged incomplete) instead of vanishing.
  let roundMode: ToolLoopFinalMode = "natural";
  let toolChoice: "auto" | "none" = "auto";
  let roundStartedAt = 0;
  let providerFirstTextMs: number | null = null;
  let roundUsage = { ...totals };
  let roundTraced = true;
  let loopOutcome: "completed" | "failed" | "timeout" | "cancelled" = "failed";
  let loopErrorCode: string | null = null;

  try {
    // Tool rounds and pause continuations are counted separately: the while
    // loop is bounded by TOOL_LOOP_MAX_ROUNDS tool rounds plus
    // TOOL_LOOP_MAX_PAUSE_TURNS pauses, each capped explicitly below.
    let toolRound = 0;
    let pauses = 0;
    while (true) {
      if (forceFinalReason === null) {
        forceFinalReason =
          toolRound >= TOOL_LOOP_MAX_ROUNDS - 1
            ? "round_cap"
            : recoverableFailures >= TOOL_LOOP_MAX_RECOVERABLE_FAILURES
              ? "failure_cap"
              : totalToolCalls >= TOOL_LOOP_MAX_TOOL_CALLS
                ? "call_cap"
                : totalResultTokens >= TOOL_LOOP_RESULT_TOKEN_BUDGET
                  ? "result_budget"
                  : null;
      }
      roundMode = hardFinal ? "hard" : forceFinalReason ? "soft" : "natural";
      finalMode = roundMode;
      if (roundMode === "soft" && !hintAppended) {
        // Every trigger follows a tool round, whose results are the last
        // user turn; the hint rides after them in that same message.
        const last = toolTurns.at(-1);
        if (last?.role === "user") {
          // Replace, don't mutate: turns already handed to a request stay
          // exactly what that request sent.
          toolTurns[toolTurns.length - 1] = {
            role: "user",
            blocks: [...last.blocks, { type: "text", text: TOOL_LOOP_FINAL_HINT }],
          };
          hintAppended = true;
        }
      }
      toolChoice = roundMode === "hard" ? "none" : "auto";
      roundStartedAt = performance.now();
      // Provider-side first text, not the user's first visible character:
      // loop-mode text is buffered until the final round.
      providerFirstTextMs = null;
      roundTraced = false;

      let roundText = "";
      let finishReason: string | undefined;
      const roundBlocks: AssistantContentBlock[] = [];
      roundUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      };

      for await (const chunk of input.provider.stream(
        {
          ...input.request,
          tools: wireTools,
          // A per-round snapshot, so a captured request keeps the turns it
          // actually carried when later rounds append.
          toolTurns: [...toolTurns],
          toolChoice,
          collectBlocks: true,
        },
        deadline.signal,
      )) {
        if (chunk.type === "text") {
          // Buffer-first (decision 3): pre-final text never reaches the
          // client. The final round's text is flushed once, below.
          providerFirstTextMs ??= Math.round(
            performance.now() - roundStartedAt,
          );
          roundText += chunk.text;
        } else if (chunk.type === "thinking") {
          yield chunk;
        } else if (chunk.type === "search") {
          yield chunk;
        } else if (chunk.type === "content_block") {
          roundBlocks.push(chunk.block);
        } else if (chunk.type === "usage") {
          roundUsage.inputTokens = chunk.inputTokens ?? roundUsage.inputTokens;
          roundUsage.outputTokens =
            chunk.outputTokens ?? roundUsage.outputTokens;
          roundUsage.cacheCreationInputTokens =
            chunk.cacheCreationInputTokens ??
            roundUsage.cacheCreationInputTokens;
          roundUsage.cacheReadInputTokens =
            chunk.cacheReadInputTokens ?? roundUsage.cacheReadInputTokens;
          // Usage accumulates across rounds (decision 4): the client always
          // sees attempt totals, never a later round resetting the counter.
          yield {
            type: "usage",
            inputTokens: totals.inputTokens + roundUsage.inputTokens,
            outputTokens: totals.outputTokens + roundUsage.outputTokens,
            cacheCreationInputTokens:
              totals.cacheCreationInputTokens +
              roundUsage.cacheCreationInputTokens,
            cacheReadInputTokens:
              totals.cacheReadInputTokens + roundUsage.cacheReadInputTokens,
          };
        } else if (chunk.type === "done") {
          finishReason = chunk.finishReason;
        }
      }

      totals.inputTokens += roundUsage.inputTokens;
      totals.outputTokens += roundUsage.outputTokens;
      totals.cacheCreationInputTokens += roundUsage.cacheCreationInputTokens;
      totals.cacheReadInputTokens += roundUsage.cacheReadInputTokens;

      const toolUses = roundBlocks.filter(
        (block): block is ProviderToolUseBlock => block.type === "tool_use",
      );
      roundTraces.push({
        roundIndex: roundTraces.length,
        toolRound,
        finishReason,
        toolCalls: toolUses.length,
        finalMode: roundMode,
        toolChoice,
        elapsedMs: Math.round(performance.now() - roundStartedAt),
        providerFirstTextMs,
        // Per-round usage is observational: a delta between adjacent rounds
        // shows cost movement but cannot be attributed to tool_choice alone
        // (history grows every round). Causal comparison stays with the
        // cache probe's arm 4.
        ...roundUsage,
      });
      roundTraced = true;

      if (finishReason === "refusal") {
        throw new ProviderError(
          "TOOL_LOOP_REFUSAL",
          "The provider refused mid tool loop.",
        );
      }

      if (finishReason === "pause_turn" && toolUses.length === 0) {
        // Continue the paused turn per docs: replay the assistant content so
        // far and re-request. A pause is provider-side plumbing, not a tool
        // round — it has its own cap instead of consuming the round budget.
        // A pause that arrives WITH client tool_use blocks falls through to
        // execution: replaying an unanswered tool_use would be rejected.
        pauses += 1;
        if (pauses > TOOL_LOOP_MAX_PAUSE_TURNS) {
          throw new ProviderError(
            "PROVIDER_UNAVAILABLE",
            "Provider paused the turn more times than the loop allows.",
          );
        }
        carryText += roundText;
        const replay = replayableBlocks(roundBlocks);
        if (replay.length > 0) {
          toolTurns.push({ role: "assistant", blocks: replay });
        }
        continue;
      }

      if (finishReason === "max_tokens" && toolUses.length > 0) {
        // The round was cut off while it still owed tool execution; there is
        // no coherent way to continue, so the attempt ends through the
        // existing failure path (scope §1).
        throw new ProviderError(
          "TOOL_LOOP_MAX_TOKENS",
          "max_tokens ended a tool round before its calls completed.",
        );
      }

      if (toolUses.length === 0) {
        if (finishReason === "tool_use") {
          throw new ProviderError(
            "PROVIDER_UNAVAILABLE",
            "Provider reported tool_use with no tool_use blocks.",
          );
        }
        // Final round: flush the buffered final text as the only prose that
        // completes the message.
        const finalText = carryText + roundText;
        finalTextChars = finalText.length;
        if (finalText) {
          yield { type: "text", text: finalText };
        }
        loopOutcome = "completed";
        yield { type: "done", finishReason };
        return;
      }

      if (roundMode === "hard") {
        // tool_choice was pinned to none; a tool_use round here is a
        // protocol violation, and executing it would break the bound.
        throw new ProviderError(
          "PROVIDER_UNAVAILABLE",
          "Provider requested tools on the final permitted round.",
        );
      }

      // Serial-only (decision, scope §1): parallel tool use is disabled on
      // the wire; if the provider still returns multiple tool_use blocks,
      // execute serially in block order and return all results in one user
      // message.
      const results: ProviderToolResultBlock[] = [];
      const precedingText = carryText + roundText;
      carryText = "";
      // Soft final round: the model called a tool despite the hint. Nothing
      // executes, but the protocol still owes each tool_use a result; the
      // hard round that follows pins tool_choice to none.
      const violation = roundMode === "soft";
      for (const [callIndex, toolUse] of toolUses.entries()) {
        if (!toolUse.id) {
          // A tool_use block without an id cannot be answered or traced;
          // fail fast at the protocol violation instead of at the DB index.
          throw new ProviderError(
            "PROVIDER_UNAVAILABLE",
            "Provider emitted a tool_use block without an id.",
          );
        }
        const tool = toolsByName.get(toolUse.name);
        if (!violation) {
          yield {
            type: "tool_status",
            status: "running",
            toolName: toolUse.name,
            roundIndex: toolRound,
          };
        }
        const startedAt = new Date();
        const runId = await input.recorder.start({
          attemptId: input.attempt.attemptId,
          sessionId: input.attempt.sessionId,
          assistantMessageId: input.attempt.assistantMessageId,
          roundIndex: toolRound,
          callIndex,
          providerToolUseId: toolUse.id,
          toolName: toolUse.name,
          toolSchemaHash: tool ? toolSchemaHash(tool) : null,
          input: toolUse.input,
          precedingText: callIndex === 0 ? precedingText || null : null,
          startedAt,
        });

        let content: string;
        let isError = false;
        let errorCode: ToolRunErrorCode | null = null;
        const remaining = Math.max(
          0,
          TOOL_LOOP_RESULT_TOKEN_BUDGET - totalResultTokens,
        );
        if (violation) {
          content =
            "Tool budget for this reply is exhausted; no more tools will run.";
          isError = true;
          errorCode = "final_round_violation";
        } else if (!tool) {
          // Bounded, sanitized, recoverable (scope §1): the model may
          // correct itself within the failure cap.
          content = `Unknown tool: ${toolUse.name}.`;
          isError = true;
          errorCode = "unknown_tool";
          recoverableFailures += 1;
        } else if (toolUse.inputInvalid) {
          content = "Tool input was not valid JSON.";
          isError = true;
          errorCode = "invalid_input";
          recoverableFailures += 1;
        } else if (totalToolCalls >= TOOL_LOOP_MAX_TOOL_CALLS) {
          content = "Tool call budget for this reply is exhausted.";
          isError = true;
          errorCode = "call_budget_exhausted";
        } else if (remaining <= 0) {
          content = "Tool result budget for this reply is exhausted.";
          isError = true;
          errorCode = "result_budget_exhausted";
        } else {
          totalToolCalls += 1;
          try {
            const outcome = await tool.execute(toolUse.input, {
              signal: deadline.signal,
              excludeMemoryIds: input.excludeMemoryIds,
            });
            if (outcome.kind !== "continue") {
              // Non-`continue` outcomes are non-constructible in Phase A;
              // reaching this line means the type boundary was subverted.
              throw new Error(`Unreachable tool outcome: ${outcome.kind}.`);
            }
            content = outcome.result.content;
            isError = outcome.result.isError ?? false;
            if (isError) {
              errorCode = "tool_error";
              recoverableFailures += 1;
            }
          } catch (error) {
            if (deadline.signal.aborted) {
              throw error;
            }
            if (tool.failurePolicy !== "recoverable_result") {
              throw error;
            }
            // Sanitized: executor internals never reach the model.
            content = `Tool ${toolUse.name} failed.`;
            isError = true;
            errorCode = "tool_error";
            recoverableFailures += 1;
          }
        }

        // Every result text returned to the model — error texts included,
        // and any provider-supplied tool name they embed — spends from the
        // same attempt budget, making the cap a hard ceiling (owner review
        // 2026-08-29). An over-budget result squeezes to empty; the adapter
        // omits empty content from the wire (a tool_result's content field
        // is optional, unlike text blocks).
        content = clampToTokenBudget(
          content,
          Math.min(
            tool?.resultTokenBudget ?? TOOL_RESULT_TOKEN_BUDGET,
            TOOL_RESULT_TOKEN_BUDGET,
            remaining,
          ),
        );
        totalResultTokens += estimateTextTokens(content);

        await input.recorder.finish(runId, {
          resultContent: content,
          isError,
          errorCode,
          finishedAt: new Date(),
        });
        if (!violation) {
          yield {
            type: "tool_status",
            status: isError ? "error" : "ok",
            toolName: toolUse.name,
            roundIndex: toolRound,
          };
        }
        results.push({
          type: "tool_result",
          toolUseId: toolUse.id,
          content,
          ...(isError ? { isError: true } : {}),
        });
      }

      toolTurns.push({
        role: "assistant",
        blocks: replayableBlocks(roundBlocks),
      });
      toolTurns.push({
        role: "user",
        blocks: violation
          ? [...results, { type: "text", text: TOOL_LOOP_FINAL_HINT }]
          : results,
      });
      if (violation) {
        hardFinal = true;
      }
      toolRound += 1;
    }
  } catch (error) {
    if (deadline.hit()) {
      loopOutcome = "timeout";
      loopErrorCode = "GENERATION_TIMEOUT";
      throw new ProviderError(
        "GENERATION_TIMEOUT",
        "Tool loop attempt deadline elapsed.",
      );
    }
    if (input.signal.aborted) {
      loopOutcome = "cancelled";
    } else {
      loopOutcome = "failed";
      loopErrorCode =
        error instanceof ProviderError ? error.code : "INTERNAL_ERROR";
    }
    throw error;
  } finally {
    deadline.cleanup();
    if (!roundTraced) {
      // The round threw mid-stream: keep what the provider already billed.
      totals.inputTokens += roundUsage.inputTokens;
      totals.outputTokens += roundUsage.outputTokens;
      totals.cacheCreationInputTokens += roundUsage.cacheCreationInputTokens;
      totals.cacheReadInputTokens += roundUsage.cacheReadInputTokens;
      roundTraces.push({
        roundIndex: roundTraces.length,
        finishReason: undefined,
        toolCalls: 0,
        finalMode: roundMode,
        toolChoice,
        elapsedMs: Math.round(performance.now() - roundStartedAt),
        providerFirstTextMs,
        incomplete: true,
        ...roundUsage,
      });
    }
    console.info("tool_loop_trace", {
      attemptId: input.attempt.attemptId,
      sessionId: input.attempt.sessionId,
      // Cost is priced per model; carry it so usage can be converted.
      model: input.request.model,
      // How the loop ended and, for a failure, the code the route will map;
      // a cancellation carries no code.
      loopOutcome,
      errorCode: loopErrorCode,
      rounds: roundTraces.length,
      toolCalls: totalToolCalls,
      resultTokens: totalResultTokens,
      recoverableFailures,
      // Forced-final observability: how the attempt ended (natural / soft /
      // hard), which budget first forced it, whether the hard fallback fired,
      // and the size of the answer it produced.
      finalMode,
      forceFinalReason,
      hardFallbackUsed: hardFinal,
      finalTextChars,
      perRound: roundTraces,
      ...totals,
    });
  }
}
