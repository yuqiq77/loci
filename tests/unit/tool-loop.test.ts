import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { estimateTextTokens } from "@/server/chat/context";
import { ProviderError } from "@/server/chat/provider-error";
import {
  runToolLoop,
  TOOL_LOOP_DEADLINE_MS,
  TOOL_LOOP_FINAL_HINT,
  TOOL_LOOP_MAX_ROUNDS,
  TOOL_LOOP_MAX_TOOL_CALLS,
  TOOL_RESULT_TOKEN_BUDGET,
  type ToolLoopChunk,
  type ToolRunFinish,
  type ToolRunStart,
} from "@/server/chat/tool-loop";
import { TOOL_LOOP_RESULT_TOKEN_BUDGET } from "@/shared/chat";
import type { RegisteredTool, ToolOutcome } from "@/server/chat/tool-registry";
import type {
  AssistantContentBlock,
  ChatChunk,
  ChatProvider,
  ChatRequest,
} from "@/server/chat/types";

import { makeEchoTestTool } from "../helpers/echo-test-tool";

const ATTEMPT = {
  attemptId: "attempt-1",
  sessionId: "session-1",
  assistantMessageId: "assistant-1",
};

function scriptedProvider(rounds: ChatChunk[][]): {
  provider: ChatProvider;
  requests: ChatRequest[];
} {
  const requests: ChatRequest[] = [];
  let call = 0;
  return {
    requests,
    provider: {
      async *stream(request, signal) {
        requests.push(request);
        const chunks = rounds[call];
        call += 1;
        if (!chunks) {
          throw new Error(`Unscripted provider round ${call}.`);
        }
        for (const chunk of chunks) {
          if (signal.aborted) {
            throw new Error("aborted");
          }
          yield chunk;
        }
      },
    },
  };
}

type RecordedRun = ToolRunStart & Partial<ToolRunFinish> & { id: string };

function memoryRecorder() {
  const runs: RecordedRun[] = [];
  return {
    runs,
    recorder: {
      async start(run: ToolRunStart) {
        const id = `run-${runs.length}`;
        runs.push({ ...run, id });
        return id;
      },
      async finish(id: string, finish: ToolRunFinish) {
        Object.assign(runs.find((run) => run.id === id)!, finish);
      },
    },
  };
}

function block(value: AssistantContentBlock): ChatChunk {
  return { type: "content_block", block: value };
}

function toolUseRound(
  id: string,
  input: Record<string, unknown>,
  extra: ChatChunk[] = [],
): ChatChunk[] {
  return [
    ...extra,
    block({ type: "tool_use", id, name: "echo_test", input }),
    { type: "done", finishReason: "tool_use" },
  ];
}

function finalRound(text: string): ChatChunk[] {
  return [
    { type: "text", text },
    block({ type: "text", text }),
    { type: "done", finishReason: "end_turn" },
  ];
}

// The forced-final hint is a text block after the tool results of a user
// turn; count its occurrences across a request's replayed turns.
function hintCount(request: ChatRequest): number {
  return (request.toolTurns ?? []).flatMap((turn) =>
    turn.blocks.filter(
      (block) => block.type === "text" && block.text === TOOL_LOOP_FINAL_HINT,
    ),
  ).length;
}

function lastTrace(): Record<string, unknown> {
  const call = vi
    .mocked(console.info)
    .mock.calls.findLast((entry) => entry[0] === "tool_loop_trace");
  return call?.[1] as Record<string, unknown>;
}

async function collect(input: {
  provider: ChatProvider;
  tools: RegisteredTool[];
  recorder: ReturnType<typeof memoryRecorder>["recorder"];
  signal?: AbortSignal;
  deadlineAt?: number;
}): Promise<ToolLoopChunk[]> {
  const chunks: ToolLoopChunk[] = [];
  for await (const chunk of runToolLoop({
    provider: input.provider,
    request: { model: "claude-test", messages: [], maxOutputTokens: 512 },
    tools: input.tools,
    attempt: ATTEMPT,
    deadlineAt: input.deadlineAt ?? Date.now() + TOOL_LOOP_DEADLINE_MS,
    excludeMemoryIds: [],
    recorder: input.recorder,
    signal: input.signal ?? new AbortController().signal,
  })) {
    chunks.push(chunk);
  }
  return chunks;
}

describe("runToolLoop", () => {
  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("passes through verbatim with an empty tool snapshot", async () => {
    const { provider, requests } = scriptedProvider([
      [
        { type: "text", text: "Hi" },
        { type: "done", finishReason: "end_turn" },
      ],
    ]);
    const { recorder, runs } = memoryRecorder();

    const chunks = await collect({ provider, tools: [], recorder });

    expect(chunks).toEqual([
      { type: "text", text: "Hi" },
      { type: "done", finishReason: "end_turn" },
    ]);
    // Byte-identical wire behavior: no client tools field. collectBlocks is
    // process-local (pause_turn continuation needs the blocks) and never
    // serialized — the adapter test proves it stays off the wire.
    expect(requests[0].tools).toBeUndefined();
    expect(requests[0].collectBlocks).toBe(true);
    expect(requests[0].toolTurns).toBeUndefined();
    expect(runs).toHaveLength(0);
  });

  it("continues a web-search-only pause_turn while streaming text live", async () => {
    const serverBlock: AssistantContentBlock = {
      type: "server_block",
      raw: { type: "server_tool_use", id: "srv-1", name: "web_search", input: {} },
    };
    const { provider, requests } = scriptedProvider([
      [
        { type: "usage", inputTokens: 100, outputTokens: 10 },
        { type: "search" },
        { type: "text", text: "Part one. " },
        block({ type: "text", text: "Part one. " }),
        block(serverBlock),
        { type: "done", finishReason: "pause_turn" },
      ],
      [
        { type: "usage", inputTokens: 150, outputTokens: 5 },
        { type: "text", text: "Part two." },
        { type: "done", finishReason: "end_turn" },
      ],
    ]);
    const { recorder, runs } = memoryRecorder();

    const chunks = await collect({ provider, tools: [], recorder });

    // Live streaming across the pause: both segments arrive as they stream,
    // no buffering, one done at the true end.
    expect(chunks.filter((chunk) => chunk.type === "text")).toEqual([
      { type: "text", text: "Part one. " },
      { type: "text", text: "Part two." },
    ]);
    expect(chunks.filter((chunk) => chunk.type === "done")).toEqual([
      { type: "done", finishReason: "end_turn" },
    ]);
    // The paused response is resent as-is (server-tools docs).
    expect(requests[1].toolTurns).toEqual([
      {
        role: "assistant",
        blocks: [{ type: "text", text: "Part one. " }, serverBlock],
      },
    ]);
    // Usage accumulates across the continuation.
    const usage = chunks.filter((chunk) => chunk.type === "usage");
    expect(usage.at(-1)).toMatchObject({ inputTokens: 250, outputTokens: 15 });
    expect(runs).toHaveLength(0);
  });

  it("holds one attempt deadline across pause continuations", async () => {
    vi.useFakeTimers();
    // Each continuation restarts provider.stream (fresh per-stream timer);
    // without the shared absolute deadline four pauses could run ~25min —
    // past the 6-minute stale-streaming window, where a concurrent send's
    // debris sweep would retract the still-active generation.
    let call = 0;
    const provider: ChatProvider = {
      async *stream(_request, signal) {
        call += 1;
        if (call === 1) {
          // A slow pause round consumes most of the attempt clock.
          await new Promise((resolve) =>
            setTimeout(resolve, TOOL_LOOP_DEADLINE_MS - 1_000),
          );
          yield { type: "done", finishReason: "pause_turn" };
          return;
        }
        // The continuation hangs; only the shared deadline can end it.
        await new Promise((_, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        });
      },
    };

    const failure = collect({
      provider,
      tools: [],
      recorder: memoryRecorder().recorder,
    }).catch((error) => error);

    await vi.advanceTimersByTimeAsync(TOOL_LOOP_DEADLINE_MS + 1);
    const error = await failure;
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).code).toBe("GENERATION_TIMEOUT");
    expect(call).toBe(2);
  });

  it("rejects a passthrough stream that ends without a done chunk", async () => {
    // The Anthropic adapter already throws on a missing message_stop; this
    // guards a future provider from committing a truncated stream as a
    // successful completion.
    const { provider } = scriptedProvider([
      [{ type: "text", text: "partial answ" }],
    ]);

    await expect(
      collect({ provider, tools: [], recorder: memoryRecorder().recorder }),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });

  it("completes gracefully when web-search-only pauses exceed the cap", async () => {
    const pauseRound: ChatChunk[] = [
      { type: "text", text: "…" },
      block({ type: "text", text: "…" }),
      { type: "done", finishReason: "pause_turn" },
    ];
    const { provider, requests } = scriptedProvider([
      pauseRound,
      pauseRound,
      pauseRound,
      pauseRound,
      pauseRound,
    ]);

    const chunks = await collect({
      provider,
      tools: [],
      recorder: memoryRecorder().recorder,
    });

    // Unlike the loop path (which buffers and can safely fail), the
    // passthrough has already streamed text — cap overflow completes with
    // what the client saw instead of retracting a visible answer.
    expect(requests).toHaveLength(5);
    expect(chunks.at(-1)).toEqual({
      type: "done",
      finishReason: "pause_turn",
    });
  });

  it("runs a tool round and flushes only the final round's text", async () => {
    const { provider, requests } = scriptedProvider([
      toolUseRound("tu-1", { text: "ping" }, [
        { type: "text", text: "pre-tool prose" },
        block({ type: "text", text: "pre-tool prose" }),
      ]),
      finalRound("Final answer."),
    ]);
    const { recorder, runs } = memoryRecorder();

    const chunks = await collect({
      provider,
      tools: [makeEchoTestTool()],
      recorder,
    });

    // Buffer-first: pre-tool text never reaches the client; the final text
    // arrives as a single flush before done.
    const textChunks = chunks.filter((chunk) => chunk.type === "text");
    expect(textChunks).toEqual([{ type: "text", text: "Final answer." }]);
    expect(chunks.filter((chunk) => chunk.type === "tool_status")).toEqual([
      {
        type: "tool_status",
        status: "running",
        toolName: "echo_test",
        roundIndex: 0,
      },
      {
        type: "tool_status",
        status: "ok",
        toolName: "echo_test",
        roundIndex: 0,
      },
    ]);

    // The run record holds the round's pre-tool text and the bounded result.
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      attemptId: "attempt-1",
      assistantMessageId: "assistant-1",
      roundIndex: 0,
      callIndex: 0,
      providerToolUseId: "tu-1",
      toolName: "echo_test",
      precedingText: "pre-tool prose",
      resultContent: "echo: ping",
      isError: false,
    });
    expect(runs[0].toolSchemaHash).toMatch(/^[0-9a-f]{64}$/);

    // Continuation request replays the assistant turn intact and returns the
    // result in one user message.
    const continuation = requests[1];
    expect(continuation.toolTurns).toEqual([
      {
        role: "assistant",
        blocks: [
          { type: "text", text: "pre-tool prose" },
          { type: "tool_use", id: "tu-1", name: "echo_test", input: { text: "ping" } },
        ],
      },
      {
        role: "user",
        blocks: [
          { type: "tool_result", toolUseId: "tu-1", content: "echo: ping" },
        ],
      },
    ]);
    expect(requests[0].collectBlocks).toBe(true);
    expect(requests[0].toolChoice).toBe("auto");
  });

  it("smoke: mixed client+server round executes the tool and replays server blocks intact", async () => {
    // The one loop-path mixed protocol smoke test (117B AC); everything
    // else about web_search stays on its own gate and adapter tests.
    const serverUse: AssistantContentBlock = {
      type: "server_block",
      raw: { type: "server_tool_use", id: "srv-1", name: "web_search", input: { query: "x" } },
    };
    const serverResult: AssistantContentBlock = {
      type: "server_block",
      raw: { type: "web_search_tool_result", tool_use_id: "srv-1", content: [] },
    };
    const { provider, requests } = scriptedProvider([
      [
        { type: "search" },
        block(serverUse),
        block(serverResult),
        block({ type: "tool_use", id: "tu-1", name: "echo_test", input: { text: "hi" } }),
        { type: "done", finishReason: "tool_use" },
      ],
      finalRound("Combined answer."),
    ]);
    const { recorder, runs } = memoryRecorder();

    const chunks = await collect({
      provider,
      tools: [makeEchoTestTool()],
      recorder,
    });

    expect(runs.map((run) => run.toolName)).toEqual(["echo_test"]);
    expect(requests[1].toolTurns?.[0]).toEqual({
      role: "assistant",
      blocks: [
        serverUse,
        serverResult,
        { type: "tool_use", id: "tu-1", name: "echo_test", input: { text: "hi" } },
      ],
    });
    expect(chunks.filter((chunk) => chunk.type === "search")).toHaveLength(1);
    expect(chunks.at(-1)).toEqual({ type: "done", finishReason: "end_turn" });
  });

  it("replays thinking blocks unchanged with their signatures", async () => {
    const thinking: AssistantContentBlock = {
      type: "thinking",
      thinking: "considering",
      signature: "sig-abc",
    };
    const redacted: AssistantContentBlock = {
      type: "redacted_thinking",
      data: "opaque-bytes",
    };
    const { provider, requests } = scriptedProvider([
      toolUseRound("tu-1", { text: "x" }, [block(thinking), block(redacted)]),
      finalRound("Done."),
    ]);
    const { recorder } = memoryRecorder();

    await collect({ provider, tools: [makeEchoTestTool()], recorder });

    const assistantTurn = requests[1].toolTurns?.[0];
    expect(assistantTurn).toEqual({
      role: "assistant",
      blocks: [
        thinking,
        redacted,
        { type: "tool_use", id: "tu-1", name: "echo_test", input: { text: "x" } },
      ],
    });
  });

  it("continues a pause_turn round and keeps its text in the final answer", async () => {
    const serverBlock: AssistantContentBlock = {
      type: "server_block",
      raw: { type: "server_tool_use", id: "srv-1", name: "web_search", input: {} },
    };
    const { provider, requests } = scriptedProvider([
      [
        { type: "text", text: "Part one. " },
        block({ type: "text", text: "Part one. " }),
        block(serverBlock),
        { type: "done", finishReason: "pause_turn" },
      ],
      finalRound("Part two."),
    ]);
    const { recorder } = memoryRecorder();

    const chunks = await collect({
      provider,
      tools: [makeEchoTestTool()],
      recorder,
    });

    expect(requests[1].toolTurns).toEqual([
      {
        role: "assistant",
        blocks: [{ type: "text", text: "Part one. " }, serverBlock],
      },
    ]);
    expect(chunks.filter((chunk) => chunk.type === "text")).toEqual([
      { type: "text", text: "Part one. Part two." },
    ]);
  });

  it("answers invalid tool input and unknown tools with recoverable error results", async () => {
    const { provider, requests } = scriptedProvider([
      [
        block({
          type: "tool_use",
          id: "tu-1",
          name: "echo_test",
          input: {},
          inputInvalid: true,
        }),
        block({ type: "tool_use", id: "tu-2", name: "no_such_tool", input: {} }),
        { type: "done", finishReason: "tool_use" },
      ],
      finalRound("Recovered."),
    ]);
    const { recorder, runs } = memoryRecorder();

    const chunks = await collect({
      provider,
      tools: [makeEchoTestTool()],
      recorder,
    });

    expect(runs.map((run) => run.errorCode)).toEqual([
      "invalid_input",
      "unknown_tool",
    ]);
    const results = requests[1].toolTurns?.[1];
    expect(results).toMatchObject({
      role: "user",
      blocks: [
        { toolUseId: "tu-1", isError: true },
        { toolUseId: "tu-2", isError: true },
        { type: "text", text: TOOL_LOOP_FINAL_HINT },
      ],
    });
    // Two recoverable failures hit the cap: the next round is a soft final —
    // tool_choice stays auto and the hint rides after the results.
    expect(requests[1].toolChoice).toBe("auto");
    expect(requests[1].toolTurns?.[1].blocks.at(-1)).toEqual({
      type: "text",
      text: TOOL_LOOP_FINAL_HINT,
    });
    expect(lastTrace()).toMatchObject({
      finalMode: "soft",
      forceFinalReason: "failure_cap",
    });
    expect(chunks.at(-1)).toEqual({ type: "done", finishReason: "end_turn" });
  });

  it("executes serially in block order and returns all results in one user message", async () => {
    const order: string[] = [];
    const tool = makeEchoTestTool({
      async execute(input) {
        order.push(String(input.text));
        return { kind: "continue", result: { content: `echo: ${input.text}` } };
      },
    });
    const { provider, requests } = scriptedProvider([
      [
        block({ type: "tool_use", id: "tu-1", name: "echo_test", input: { text: "a" } }),
        block({ type: "tool_use", id: "tu-2", name: "echo_test", input: { text: "b" } }),
        { type: "done", finishReason: "tool_use" },
      ],
      finalRound("ok"),
    ]);
    const { recorder, runs } = memoryRecorder();

    await collect({ provider, tools: [tool], recorder });

    expect(order).toEqual(["a", "b"]);
    expect(runs.map((run) => [run.roundIndex, run.callIndex])).toEqual([
      [0, 0],
      [0, 1],
    ]);
    expect(requests[1].toolTurns?.[1].blocks).toHaveLength(2);
  });

  it("enforces the attempt-wide tool call budget", async () => {
    const perRound = (round: number, calls: number): ChatChunk[] => [
      ...Array.from({ length: calls }, (_, index) =>
        block({
          type: "tool_use",
          id: `tu-${round}-${index}`,
          name: "echo_test",
          input: { text: "x" },
        }),
      ),
      { type: "done", finishReason: "tool_use" },
    ];
    const { provider, requests } = scriptedProvider([
      perRound(0, 4),
      perRound(1, 3),
      finalRound("done"),
    ]);
    const { recorder, runs } = memoryRecorder();

    await collect({ provider, tools: [makeEchoTestTool()], recorder });

    const executed = runs.filter((run) => run.errorCode !== "call_budget_exhausted");
    expect(executed).toHaveLength(TOOL_LOOP_MAX_TOOL_CALLS);
    // The seventh call still gets a protocol-required result — an error one.
    expect(
      runs.filter((run) => run.errorCode === "call_budget_exhausted"),
    ).toHaveLength(1);
    // Budget exhausted: the following round is a soft final.
    expect(requests[2].toolChoice).toBe("auto");
    expect(hintCount(requests[2])).toBe(1);
    expect(lastTrace()).toMatchObject({ forceFinalReason: "call_cap" });
  });

  it("clamps oversized results and stops at the attempt result budget", async () => {
    const tool = makeEchoTestTool({
      async execute() {
        return {
          kind: "continue",
          result: { content: "很".repeat(3000) },
        };
      },
    });
    const { provider } = scriptedProvider([
      [
        block({ type: "tool_use", id: "tu-1", name: "echo_test", input: { text: "a" } }),
        block({ type: "tool_use", id: "tu-2", name: "echo_test", input: { text: "b" } }),
        block({ type: "tool_use", id: "tu-3", name: "echo_test", input: { text: "c" } }),
        block({ type: "tool_use", id: "tu-4", name: "echo_test", input: { text: "d" } }),
        { type: "done", finishReason: "tool_use" },
      ],
      finalRound("done"),
    ]);
    const { recorder, runs } = memoryRecorder();

    await collect({ provider, tools: [tool], recorder });

    // CJK-weighted estimate: each result clamps to the per-result budget
    // (marker included), and the attempt total exhausts before the fourth
    // call.
    expect(runs[0].resultContent).toContain("[truncated: result budget]");
    expect(
      estimateTextTokens(runs[0].resultContent ?? ""),
    ).toBeLessThanOrEqual(TOOL_RESULT_TOKEN_BUDGET);
    const exhausted = runs.filter(
      (run) => run.errorCode === "result_budget_exhausted",
    );
    expect(exhausted.length).toBeGreaterThan(0);
    // The cap is a hard ceiling over everything returned to the model —
    // error texts included (owner review 2026-08-29).
    const total = runs.reduce(
      (sum, run) => sum + estimateTextTokens(run.resultContent ?? ""),
      0,
    );
    expect(total).toBeLessThanOrEqual(TOOL_LOOP_RESULT_TOKEN_BUDGET);
  });

  it("soft-finalizes the last permitted round: auto plus the hint, never none", async () => {
    const rounds: ChatChunk[][] = [
      toolUseRound("tu-1", { text: "a" }),
      toolUseRound("tu-2", { text: "b" }),
      toolUseRound("tu-3", { text: "c" }),
      finalRound("bounded"),
    ];
    const { provider, requests } = scriptedProvider(rounds);
    const { recorder } = memoryRecorder();

    const chunks = await collect({
      provider,
      tools: [makeEchoTestTool()],
      recorder,
    });

    expect(requests).toHaveLength(TOOL_LOOP_MAX_ROUNDS);
    // tool_choice never changes on the soft path, so the messages-tier
    // prompt cache survives the forced final round.
    expect(requests.map((request) => request.toolChoice)).toEqual([
      "auto",
      "auto",
      "auto",
      "auto",
    ]);
    // The hint appears exactly once, after the last round's results, and
    // never on earlier rounds.
    expect(requests.map(hintCount)).toEqual([0, 0, 0, 1]);
    expect(requests[3].toolTurns?.at(-1)).toMatchObject({
      role: "user",
      blocks: [
        { type: "tool_result", toolUseId: "tu-3" },
        { type: "text", text: TOOL_LOOP_FINAL_HINT },
      ],
    });
    expect(chunks.at(-1)).toEqual({ type: "done", finishReason: "end_turn" });
    expect(lastTrace()).toMatchObject({
      finalMode: "soft",
      forceFinalReason: "round_cap",
      hardFallbackUsed: false,
      finalTextChars: "bounded".length,
    });
    const perRound = lastTrace().perRound as Record<string, unknown>[];
    expect(perRound.map((round) => round.finalMode)).toEqual([
      "natural",
      "natural",
      "natural",
      "soft",
    ]);
  });

  it("survives a pause_turn on the last permitted round", async () => {
    // Pauses are provider-side plumbing with their own cap: a pause landing
    // where the round budget is exhausted must not fail a healthy attempt.
    const { provider, requests } = scriptedProvider([
      toolUseRound("tu-1", { text: "a" }),
      toolUseRound("tu-2", { text: "b" }),
      toolUseRound("tu-3", { text: "c" }),
      [
        { type: "text", text: "Almost " },
        block({ type: "text", text: "Almost " }),
        { type: "done", finishReason: "pause_turn" },
      ],
      finalRound("there."),
    ]);
    const chunks = await collect({
      provider,
      tools: [makeEchoTestTool()],
      recorder: memoryRecorder().recorder,
    });

    expect(requests).toHaveLength(5);
    // The pause continuation stays soft (auto) and does not re-append the
    // hint: the replayed history is append-only.
    expect(requests[3].toolChoice).toBe("auto");
    expect(requests[4].toolChoice).toBe("auto");
    expect(hintCount(requests[3])).toBe(1);
    expect(hintCount(requests[4])).toBe(1);
    expect(chunks.filter((chunk) => chunk.type === "text")).toEqual([
      { type: "text", text: "Almost there." },
    ]);
    expect(chunks.at(-1)).toEqual({ type: "done", finishReason: "end_turn" });
  });

  it("bounds pause_turn continuations with their own cap", async () => {
    const pauseRound: ChatChunk[] = [
      { type: "done", finishReason: "pause_turn" },
    ];
    const { provider } = scriptedProvider([
      pauseRound,
      pauseRound,
      pauseRound,
      pauseRound,
      pauseRound,
    ]);
    await expect(
      collect({
        provider,
        tools: [makeEchoTestTool()],
        recorder: memoryRecorder().recorder,
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });

  it("falls back to one hard none round when the soft final round still calls a tool", async () => {
    const { provider, requests } = scriptedProvider([
      toolUseRound("tu-1", { text: "a" }),
      toolUseRound("tu-2", { text: "b" }),
      toolUseRound("tu-3", { text: "c" }),
      toolUseRound("tu-4", { text: "d" }),
      finalRound("bounded"),
    ]);
    const { recorder, runs } = memoryRecorder();

    const chunks = await collect({
      provider,
      tools: [makeEchoTestTool()],
      recorder,
    });

    expect(requests.map((request) => request.toolChoice)).toEqual([
      "auto",
      "auto",
      "auto",
      "auto",
      "none",
    ]);
    // The violating call is answered for the protocol but never executed and
    // never shown as running.
    const violation = runs.find((run) => run.providerToolUseId === "tu-4");
    expect(violation).toMatchObject({
      roundIndex: 3,
      errorCode: "final_round_violation",
      isError: true,
    });
    expect(violation?.resultContent).not.toContain("echo:");
    expect(
      chunks.filter(
        (chunk) => chunk.type === "tool_status" && chunk.roundIndex === 3,
      ),
    ).toHaveLength(0);
    // The hard round's user turn: the error result, then the hint again.
    expect(requests[4].toolTurns?.at(-1)).toMatchObject({
      role: "user",
      blocks: [
        { type: "tool_result", toolUseId: "tu-4", isError: true },
        { type: "text", text: TOOL_LOOP_FINAL_HINT },
      ],
    });
    expect(chunks.filter((chunk) => chunk.type === "text")).toEqual([
      { type: "text", text: "bounded" },
    ]);
    expect(lastTrace()).toMatchObject({
      rounds: 5,
      finalMode: "hard",
      forceFinalReason: "round_cap",
      hardFallbackUsed: true,
    });
    const perRound = lastTrace().perRound as Record<string, unknown>[];
    expect(perRound.at(-1)).toMatchObject({ finalMode: "hard", toolChoice: "none" });
  });

  it("fails the attempt when tools return on the hard final round", async () => {
    const rounds: ChatChunk[][] = [
      toolUseRound("tu-1", { text: "a" }),
      toolUseRound("tu-2", { text: "b" }),
      toolUseRound("tu-3", { text: "c" }),
      toolUseRound("tu-4", { text: "d" }),
      toolUseRound("tu-5", { text: "e" }),
    ];
    const { provider, requests } = scriptedProvider(rounds);
    const { recorder } = memoryRecorder();

    await expect(
      collect({ provider, tools: [makeEchoTestTool()], recorder }),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    // Bounded: exactly one hard round, never a second.
    expect(requests).toHaveLength(5);
    expect(lastTrace()).toMatchObject({
      finalMode: "hard",
      hardFallbackUsed: true,
    });
  });

  it("traces a natural completion with per-round timing fields", async () => {
    const { provider } = scriptedProvider([
      toolUseRound("tu-1", { text: "a" }),
      finalRound("Final answer."),
    ]);

    await collect({
      provider,
      tools: [makeEchoTestTool()],
      recorder: memoryRecorder().recorder,
    });

    expect(lastTrace()).toMatchObject({
      model: "claude-test",
      loopOutcome: "completed",
      errorCode: null,
      finalMode: "natural",
      forceFinalReason: null,
      hardFallbackUsed: false,
      finalTextChars: "Final answer.".length,
    });
    const perRound = lastTrace().perRound as Record<string, unknown>[];
    expect(perRound).toHaveLength(2);
    expect(perRound[0]).toMatchObject({
      finalMode: "natural",
      toolChoice: "auto",
      providerFirstTextMs: null,
    });
    expect(typeof perRound[0].elapsedMs).toBe("number");
    expect(typeof perRound[1].providerFirstTextMs).toBe("number");
  });

  it("traces failed attempts: outcome, error code, and a mid-stream round's usage", async () => {
    const tools = [makeEchoTestTool()];

    // A loop-raised ProviderError after a complete round.
    const refusal = scriptedProvider([
      [
        { type: "usage", inputTokens: 40 },
        { type: "done", finishReason: "refusal" },
      ],
    ]);
    await expect(
      collect({ provider: refusal.provider, tools, recorder: memoryRecorder().recorder }),
    ).rejects.toMatchObject({ code: "TOOL_LOOP_REFUSAL" });
    expect(lastTrace()).toMatchObject({
      loopOutcome: "failed",
      errorCode: "TOOL_LOOP_REFUSAL",
      rounds: 1,
      inputTokens: 40,
    });

    // A provider that dies mid-round after reporting usage: the usage is
    // kept and the round is traced as incomplete.
    const dying: ChatProvider = {
      async *stream() {
        yield { type: "usage", inputTokens: 25 };
        throw new Error("socket closed");
      },
    };
    await expect(
      collect({ provider: dying, tools, recorder: memoryRecorder().recorder }),
    ).rejects.toThrow("socket closed");
    expect(lastTrace()).toMatchObject({
      loopOutcome: "failed",
      errorCode: "INTERNAL_ERROR",
      rounds: 1,
      inputTokens: 25,
    });
    expect((lastTrace().perRound as Record<string, unknown>[])[0]).toMatchObject({
      incomplete: true,
      inputTokens: 25,
      toolCalls: 0,
    });

    // Deadline and caller cancellation are distinct outcomes.
    const hanging: ChatProvider = {
      async *stream(_request, signal) {
        await new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          }),
        );
      },
    };
    await expect(
      collect({
        provider: hanging,
        tools,
        recorder: memoryRecorder().recorder,
        deadlineAt: Date.now() + 5,
      }),
    ).rejects.toMatchObject({ code: "GENERATION_TIMEOUT" });
    expect(lastTrace()).toMatchObject({
      loopOutcome: "timeout",
      errorCode: "GENERATION_TIMEOUT",
    });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    await expect(
      collect({
        provider: hanging,
        tools,
        recorder: memoryRecorder().recorder,
        signal: controller.signal,
      }),
    ).rejects.toThrow("aborted");
    expect(lastTrace()).toMatchObject({
      loopOutcome: "cancelled",
      errorCode: null,
    });
  });

  it("ends the attempt on refusal and on max_tokens that cut off tool calls", async () => {
    const refusal = scriptedProvider([
      [{ type: "done", finishReason: "refusal" }],
    ]);
    await expect(
      collect({
        provider: refusal.provider,
        tools: [makeEchoTestTool()],
        recorder: memoryRecorder().recorder,
      }),
    ).rejects.toMatchObject({ code: "TOOL_LOOP_REFUSAL" });

    const cutOff = scriptedProvider([
      [
        block({ type: "tool_use", id: "tu-1", name: "echo_test", input: {} }),
        { type: "done", finishReason: "max_tokens" },
      ],
    ]);
    await expect(
      collect({
        provider: cutOff.provider,
        tools: [makeEchoTestTool()],
        recorder: memoryRecorder().recorder,
      }),
    ).rejects.toMatchObject({ code: "TOOL_LOOP_MAX_TOKENS" });
  });

  it("completes a truncated text-only final round with its finish reason", async () => {
    const { provider } = scriptedProvider([
      [
        { type: "text", text: "Truncated ans" },
        block({ type: "text", text: "Truncated ans" }),
        { type: "done", finishReason: "max_tokens" },
      ],
    ]);
    const chunks = await collect({
      provider,
      tools: [makeEchoTestTool()],
      recorder: memoryRecorder().recorder,
    });
    expect(chunks.at(-1)).toEqual({ type: "done", finishReason: "max_tokens" });
    expect(chunks.filter((chunk) => chunk.type === "text")).toEqual([
      { type: "text", text: "Truncated ans" },
    ]);
  });

  it("accumulates usage across rounds instead of resetting per round", async () => {
    const { provider } = scriptedProvider([
      [
        { type: "usage", inputTokens: 100, outputTokens: 10 },
        ...toolUseRound("tu-1", { text: "a" }),
      ],
      [
        { type: "usage", inputTokens: 120, outputTokens: 5 },
        ...finalRound("done"),
      ],
    ]);
    const chunks = await collect({
      provider,
      tools: [makeEchoTestTool()],
      recorder: memoryRecorder().recorder,
    });

    const usage = chunks.filter((chunk) => chunk.type === "usage");
    expect(usage.at(-1)).toMatchObject({ inputTokens: 220, outputTokens: 15 });
  });

  it("holds one attempt-wide deadline that a new round cannot reset", async () => {
    vi.useFakeTimers();
    const requests: ChatRequest[] = [];
    let call = 0;
    const provider: ChatProvider = {
      async *stream(request, signal) {
        requests.push(request);
        call += 1;
        if (call === 1) {
          // A slow but successful first round consumes most of the clock.
          await new Promise((resolve) =>
            setTimeout(resolve, TOOL_LOOP_DEADLINE_MS - 1_000),
          );
          yield* toolUseRound("tu-1", { text: "a" });
          return;
        }
        // The second round hangs; only the attempt-wide deadline can end it.
        await new Promise((_, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        });
      },
    };

    const done = collect({
      provider,
      tools: [makeEchoTestTool()],
      recorder: memoryRecorder().recorder,
    });
    const failure = done.catch((error) => error);

    await vi.advanceTimersByTimeAsync(TOOL_LOOP_DEADLINE_MS + 1);
    const error = await failure;
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).code).toBe("GENERATION_TIMEOUT");
    // The second round started; a per-round reset would have kept it alive.
    expect(requests).toHaveLength(2);
  });

  it("spends pre-loop attempt time from the same deadline", async () => {
    vi.useFakeTimers();
    // The route mints deadlineAt at beginGeneration; by loop start most of
    // the clock may already be gone — the loop only gets what is left.
    const provider: ChatProvider = {
      async *stream(_request, signal) {
        await new Promise((_, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        });
      },
    };
    const failure = collect({
      provider,
      tools: [makeEchoTestTool()],
      recorder: memoryRecorder().recorder,
      deadlineAt: Date.now() + 1_000,
    }).catch((error) => error);

    await vi.advanceTimersByTimeAsync(1_001);
    const error = await failure;
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).code).toBe("GENERATION_TIMEOUT");
  });

  it("propagates cancellation through the tool executor", async () => {
    const abort = new AbortController();
    const tool = makeEchoTestTool({
      async execute(_input, context) {
        return new Promise((_, reject) => {
          context.signal.addEventListener(
            "abort",
            () => reject(new Error("tool aborted")),
            { once: true },
          );
        });
      },
    });
    const { provider } = scriptedProvider([toolUseRound("tu-1", { text: "a" })]);
    const { recorder, runs } = memoryRecorder();

    const pending = collect({
      provider,
      tools: [tool],
      recorder,
      signal: abort.signal,
    });
    const failure = pending.catch((error) => error);
    await new Promise((resolve) => setImmediate(resolve));
    abort.abort();

    const error = await failure;
    expect(error).toBeInstanceOf(Error);
    // The run was started (trace exists) but never finished.
    expect(runs).toHaveLength(1);
    expect(runs[0].finishedAt).toBeUndefined();
  });

  it("throws on a non-continue outcome smuggled past the type system", async () => {
    const tool = makeEchoTestTool({
      async execute() {
        return { kind: "yield" } as unknown as ToolOutcome;
      },
      failurePolicy: "hard_failure",
    });
    const { provider } = scriptedProvider([toolUseRound("tu-1", { text: "a" })]);

    await expect(
      collect({ provider, tools: [tool], recorder: memoryRecorder().recorder }),
    ).rejects.toThrow(/Unreachable tool outcome/);
  });
});
