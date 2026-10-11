import { describe, expect, it } from "vitest";

import { AnthropicChatProvider } from "@/server/chat/anthropic";
import type { ChatChunk, ChatRequest } from "@/server/chat/types";

import { streamResponse } from "../helpers/stream-response";

function makeProvider(
  events: unknown[],
  options: { webSearch?: boolean } = {},
): { provider: AnthropicChatProvider; captured: () => Record<string, unknown> } {
  let body: Record<string, unknown> = {};
  const provider = new AnthropicChatProvider({
    apiKey: "secret",
    baseUrl: "https://api.anthropic.com",
    webSearch: options.webSearch,
    fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return streamResponse(events);
    },
  });
  return { provider, captured: () => body };
}

const BASE_REQUEST: ChatRequest = {
  model: "claude-test",
  messages: [{ role: "user", content: "hi" }],
  maxOutputTokens: 256,
};

async function drain(
  provider: AnthropicChatProvider,
  request: ChatRequest,
): Promise<ChatChunk[]> {
  const chunks: ChatChunk[] = [];
  for await (const chunk of provider.stream(
    request,
    new AbortController().signal,
  )) {
    chunks.push(chunk);
  }
  return chunks;
}

const DONE_EVENTS = [
  { type: "message_delta", delta: { stop_reason: "end_turn" } },
  { type: "message_stop" },
];

describe("tool-loop request mapping", () => {
  it("sends client tools with serial-only tool_choice alongside web search", async () => {
    const { provider, captured } = makeProvider(DONE_EVENTS, {
      webSearch: true,
    });

    await drain(provider, {
      ...BASE_REQUEST,
      tools: [
        {
          name: "echo_test",
          description: "Echo.",
          input_schema: { type: "object" },
        },
      ],
    });

    expect(captured().tools).toEqual([
      {
        name: "echo_test",
        description: "Echo.",
        input_schema: { type: "object" },
      },
      {
        type: "web_search_20260209",
        name: "web_search",
        allowed_callers: ["direct"],
      },
    ]);
    expect(captured().tool_choice).toEqual({
      type: "auto",
      disable_parallel_tool_use: true,
    });
  });

  it("pins tool_choice none on forced-final rounds", async () => {
    const { provider, captured } = makeProvider(DONE_EVENTS);

    await drain(provider, {
      ...BASE_REQUEST,
      tools: [
        { name: "echo_test", description: "Echo.", input_schema: {} },
      ],
      toolChoice: "none",
    });

    expect(captured().tool_choice).toEqual({ type: "none" });
  });

  it("keeps the wire request unchanged when no tool fields are set", async () => {
    const { provider, captured } = makeProvider(DONE_EVENTS);

    // collectBlocks is process-local (the passthrough pause continuation
    // sets it on every request) and must never reach the wire.
    await drain(provider, { ...BASE_REQUEST, collectBlocks: true });

    expect(captured()).not.toHaveProperty("tools");
    expect(captured()).not.toHaveProperty("tool_choice");
    expect(captured()).not.toHaveProperty("collectBlocks");
    expect(captured()).not.toHaveProperty("toolTurns");
  });

  it("replays continuation turns intact: thinking signatures, server blocks, error results", async () => {
    const { provider, captured } = makeProvider(DONE_EVENTS);

    await drain(provider, {
      ...BASE_REQUEST,
      tools: [
        { name: "echo_test", description: "Echo.", input_schema: {} },
      ],
      toolTurns: [
        {
          role: "assistant",
          blocks: [
            { type: "thinking", thinking: "hm", signature: "sig-1" },
            { type: "redacted_thinking", data: "opaque" },
            { type: "text", text: "checking" },
            {
              type: "server_block",
              raw: { type: "server_tool_use", id: "srv", name: "web_search" },
            },
            { type: "tool_use", id: "tu-1", name: "echo_test", input: { text: "x" } },
          ],
        },
        {
          role: "user",
          blocks: [
            { type: "tool_result", toolUseId: "tu-1", content: "boom", isError: true },
            { type: "text", text: "answer now" },
          ],
        },
      ],
    });

    const messages = captured().messages as Record<string, unknown>[];
    expect(messages.at(-2)).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hm", signature: "sig-1" },
        { type: "redacted_thinking", data: "opaque" },
        { type: "text", text: "checking" },
        { type: "server_tool_use", id: "srv", name: "web_search" },
        { type: "tool_use", id: "tu-1", name: "echo_test", input: { text: "x" } },
      ],
    });
    expect(messages.at(-1)).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu-1",
          content: "boom",
          is_error: true,
        },
        { type: "text", text: "answer now" },
      ],
    });
  });
});

describe("tool-loop stream parsing", () => {
  it("assembles mixed server/client blocks in one stream", async () => {
    const events = [
      { type: "message_start", message: { usage: { input_tokens: 5 } } },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "consider" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "sig-xyz" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "server_tool_use", id: "srv-1", name: "web_search" },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"query":"l' },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: 'oci"}' },
      },
      { type: "content_block_stop", index: 1 },
      {
        type: "content_block_start",
        index: 2,
        content_block: {
          type: "web_search_tool_result",
          tool_use_id: "srv-1",
          content: [{ type: "web_search_result", url: "https://example.com" }],
        },
      },
      { type: "content_block_stop", index: 2 },
      {
        type: "content_block_start",
        index: 3,
        content_block: { type: "text" },
      },
      {
        type: "content_block_delta",
        index: 3,
        delta: { type: "text_delta", text: "Let me check." },
      },
      { type: "content_block_stop", index: 3 },
      {
        type: "content_block_start",
        index: 4,
        content_block: { type: "tool_use", id: "tu-1", name: "echo_test" },
      },
      {
        type: "content_block_delta",
        index: 4,
        delta: { type: "input_json_delta", partial_json: '{"text":' },
      },
      {
        type: "content_block_delta",
        index: 4,
        delta: { type: "input_json_delta", partial_json: '"ping"}' },
      },
      { type: "content_block_stop", index: 4 },
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
      { type: "message_stop" },
    ];
    const { provider } = makeProvider(events);

    const chunks = await drain(provider, {
      ...BASE_REQUEST,
      tools: [{ name: "echo_test", description: "Echo.", input_schema: {} }],
      collectBlocks: true,
    });

    expect(chunks.filter((chunk) => chunk.type === "search")).toHaveLength(1);
    const blocks = chunks.flatMap((chunk) =>
      chunk.type === "content_block" ? [chunk.block] : [],
    );
    expect(blocks).toEqual([
      { type: "thinking", thinking: "consider", signature: "sig-xyz" },
      {
        type: "server_block",
        raw: {
          type: "server_tool_use",
          id: "srv-1",
          name: "web_search",
          input: { query: "loci" },
        },
      },
      {
        type: "server_block",
        raw: {
          type: "web_search_tool_result",
          tool_use_id: "srv-1",
          content: [{ type: "web_search_result", url: "https://example.com" }],
        },
      },
      { type: "text", text: "Let me check." },
      { type: "tool_use", id: "tu-1", name: "echo_test", input: { text: "ping" } },
    ]);
    expect(chunks.at(-1)).toEqual({ type: "done", finishReason: "tool_use" });
  });

  it("captures redacted_thinking blocks for replay", async () => {
    const events = [
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "redacted_thinking", data: "opaque-bytes" },
      },
      { type: "content_block_stop", index: 0 },
      ...DONE_EVENTS,
    ];
    const { provider } = makeProvider(events);

    const chunks = await drain(provider, {
      ...BASE_REQUEST,
      collectBlocks: true,
    });

    expect(
      chunks.find((chunk) => chunk.type === "content_block")?.block,
    ).toEqual({ type: "redacted_thinking", data: "opaque-bytes" });
  });

  it("marks unparseable tool input instead of failing the stream", async () => {
    const events = [
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tu-1", name: "echo_test" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"text": tru' },
      },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
      { type: "message_stop" },
    ];
    const { provider } = makeProvider(events);

    const chunks = await drain(provider, {
      ...BASE_REQUEST,
      collectBlocks: true,
    });

    expect(
      chunks.find((chunk) => chunk.type === "content_block")?.block,
    ).toEqual({
      type: "tool_use",
      id: "tu-1",
      name: "echo_test",
      input: {},
      inputInvalid: true,
    });
  });

  it("emits no content_block chunks without the opt-in", async () => {
    const events = [
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hi" },
      },
      { type: "content_block_stop", index: 0 },
      ...DONE_EVENTS,
    ];
    const { provider } = makeProvider(events);

    const chunks = await drain(provider, BASE_REQUEST);

    expect(chunks.some((chunk) => chunk.type === "content_block")).toBe(false);
    expect(chunks.filter((chunk) => chunk.type === "text")).toEqual([
      { type: "text", text: "Hi" },
    ]);
  });
});
