import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AnthropicChatProvider,
  isOfficialAnthropicEndpoint,
  shouldEnableWebSearch,
} from "@/server/chat/anthropic";
import { withSuspensionDetection } from "@/server/chat/suspension";
import { CHAT_TIMEOUT_MS } from "@/shared/chat";

import { streamResponse } from "../helpers/stream-response";

afterEach(() => {
  vi.useRealTimers();
});

describe("isOfficialAnthropicEndpoint", () => {
  it("accepts the official host with or without a trailing slash", () => {
    expect(isOfficialAnthropicEndpoint("https://api.anthropic.com")).toBe(true);
    expect(isOfficialAnthropicEndpoint("https://api.anthropic.com/")).toBe(true);
  });

  it("rejects relays, look-alike hosts, and malformed URLs", () => {
    expect(isOfficialAnthropicEndpoint("https://relay.example.com/v1")).toBe(
      false,
    );
    expect(
      isOfficialAnthropicEndpoint("https://api.anthropic.com.evil.com"),
    ).toBe(false);
    expect(isOfficialAnthropicEndpoint("not-a-url")).toBe(false);
  });
});

describe("shouldEnableWebSearch", () => {
  it.each([
    [true, "https://api.anthropic.com", true],
    [false, "https://api.anthropic.com", false],
    [true, "https://relay.example.com/v1", false],
    [false, "https://relay.example.com/v1", false],
  ])(
    "returns %s && official endpoint for %s",
    (setting, baseUrl, expected) => {
      expect(shouldEnableWebSearch(baseUrl, setting)).toBe(expected);
    },
  );
});

describe("AnthropicChatProvider", () => {
  it("sends native Messages fields and normalizes stream events", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchMock: typeof fetch = async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return streamResponse([
        {
          type: "message_start",
          message: {
            usage: {
              input_tokens: 12,
              cache_creation_input_tokens: 100,
              cache_read_input_tokens: 200,
              output_tokens: 0,
            },
          },
        },
        {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "Hello" },
        },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 3 },
        },
        { type: "message_stop" },
      ]);
    };
    const provider = new AnthropicChatProvider({
      apiKey: "secret",
      baseUrl: "https://api.anthropic.com/",
      fetch: fetchMock,
      promptCaching: true,
    });

    const chunks = [];
    for await (const chunk of provider.stream(
      {
        model: "claude-test",
        messages: [
          { role: "system", content: "Be concise." },
          { role: "user", content: "Hi" },
        ],
        temperature: 0.5,
        maxOutputTokens: 256,
      },
      new AbortController().signal,
    )) {
      chunks.push(chunk);
    }

    expect(capturedUrl).toBe("https://api.anthropic.com/v1/messages");
    expect(capturedInit?.headers).toMatchObject({
      "x-api-key": "secret",
      "anthropic-version": "2023-06-01",
    });
    expect(JSON.parse(String(capturedInit?.body))).toEqual({
      model: "claude-test",
      max_tokens: 256,
      temperature: 0.5,
      stream: true,
      system: [
        {
          type: "text",
          text: "Be concise.",
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          content: "Hi",
        },
      ],
    });
    expect(chunks).toEqual([
      {
        type: "usage",
        inputTokens: 312,
        outputTokens: 0,
        cacheCreationInputTokens: 100,
        cacheReadInputTokens: 200,
      },
      { type: "text", text: "Hello" },
      {
        type: "usage",
        inputTokens: undefined,
        outputTokens: 3,
        cacheCreationInputTokens: undefined,
        cacheReadInputTokens: undefined,
      },
      { type: "done", finishReason: "end_turn" },
    ]);
  });

  it("enables adaptive thinking and omits temperature when thinking is on", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchMock: typeof fetch = async (_url, init) => {
      capturedInit = init;
      return streamResponse([{ type: "message_stop" }]);
    };
    const provider = new AnthropicChatProvider({
      apiKey: "secret",
      baseUrl: "https://api.anthropic.com",
      fetch: fetchMock,
    });

    const chunks = [];
    for await (const chunk of provider.stream(
      {
        model: "claude-test",
        messages: [{ role: "user", content: "Hi" }],
        temperature: 0.5,
        maxOutputTokens: 256,
        thinkingEnabled: true,
        thinkingEffort: "medium",
      },
      new AbortController().signal,
    )) {
      chunks.push(chunk);
    }

    const body = JSON.parse(String(capturedInit?.body));
    expect(body.temperature).toBeUndefined();
    expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(body.output_config).toEqual({ effort: "medium" });
  });

  it("disables thinking and keeps temperature when thinking is off", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchMock: typeof fetch = async (_url, init) => {
      capturedInit = init;
      return streamResponse([{ type: "message_stop" }]);
    };
    const provider = new AnthropicChatProvider({
      apiKey: "secret",
      baseUrl: "https://api.anthropic.com",
      fetch: fetchMock,
    });

    const chunks = [];
    for await (const chunk of provider.stream(
      {
        model: "claude-test",
        messages: [{ role: "user", content: "Hi" }],
        temperature: 0.5,
        maxOutputTokens: 256,
        thinkingEnabled: false,
        thinkingEffort: "high",
      },
      new AbortController().signal,
    )) {
      chunks.push(chunk);
    }

    const body = JSON.parse(String(capturedInit?.body));
    expect(body.temperature).toBe(0.5);
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.output_config).toBeUndefined();
  });

  it("omits the thinking param instead of disabling it on always-on models", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchMock: typeof fetch = async (_url, init) => {
      capturedInit = init;
      return streamResponse([{ type: "message_stop" }]);
    };
    const provider = new AnthropicChatProvider({
      apiKey: "secret",
      baseUrl: "https://api.anthropic.com",
      fetch: fetchMock,
    });

    const chunks = [];
    for await (const chunk of provider.stream(
      {
        model: "claude-fable-5",
        messages: [{ role: "user", content: "Hi" }],
        maxOutputTokens: 256,
        thinkingEnabled: false,
      },
      new AbortController().signal,
    )) {
      chunks.push(chunk);
    }

    const body = JSON.parse(String(capturedInit?.body));
    // Fable 5 400s on `thinking: {type: "disabled"}` — the param must be absent.
    expect("thinking" in body).toBe(false);
  });

  it("omits temperature entirely when the caller leaves it undefined", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchMock: typeof fetch = async (_url, init) => {
      capturedInit = init;
      return streamResponse([{ type: "message_stop" }]);
    };
    const provider = new AnthropicChatProvider({
      apiKey: "secret",
      baseUrl: "https://api.anthropic.com",
      fetch: fetchMock,
    });

    const chunks = [];
    for await (const chunk of provider.stream(
      {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "Hi" }],
        maxOutputTokens: 256,
        thinkingEnabled: false,
      },
      new AbortController().signal,
    )) {
      chunks.push(chunk);
    }

    const body = JSON.parse(String(capturedInit?.body));
    expect("temperature" in body).toBe(false);
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  it("adds the native web search tool when webSearch is enabled", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchMock: typeof fetch = async (_url, init) => {
      capturedInit = init;
      return streamResponse([{ type: "message_stop" }]);
    };
    const provider = new AnthropicChatProvider({
      apiKey: "secret",
      baseUrl: "https://api.anthropic.com",
      fetch: fetchMock,
      webSearch: true,
    });

    const chunks = [];
    for await (const chunk of provider.stream(
      {
        model: "claude-test",
        messages: [{ role: "user", content: "Hi" }],
        maxOutputTokens: 256,
      },
      new AbortController().signal,
    )) {
      chunks.push(chunk);
    }

    const body = JSON.parse(String(capturedInit?.body));
    expect(body.tools).toEqual([
      {
        type: "web_search_20260209",
        name: "web_search",
        allowed_callers: ["direct"],
      },
    ]);
  });

  it("omits tools when webSearch is not enabled", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchMock: typeof fetch = async (_url, init) => {
      capturedInit = init;
      return streamResponse([{ type: "message_stop" }]);
    };
    const provider = new AnthropicChatProvider({
      apiKey: "secret",
      baseUrl: "https://api.anthropic.com",
      fetch: fetchMock,
    });

    const chunks = [];
    for await (const chunk of provider.stream(
      {
        model: "claude-test",
        messages: [{ role: "user", content: "Hi" }],
        maxOutputTokens: 256,
      },
      new AbortController().signal,
    )) {
      chunks.push(chunk);
    }

    const body = JSON.parse(String(capturedInit?.body));
    expect("tools" in body).toBe(false);
  });

  it("counts tokens through the official Anthropic endpoint", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchMock: typeof fetch = async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return Response.json({ input_tokens: 42 });
    };
    const provider = new AnthropicChatProvider({
      apiKey: "secret",
      baseUrl: "https://api.anthropic.com/",
      fetch: fetchMock,
    });

    await expect(
      provider.countTokens(
        {
          model: "claude-test",
          messages: [
            { role: "system", content: "System guidance." },
            { role: "user", content: "Budget this text." },
          ],
        },
        new AbortController().signal,
      ),
    ).resolves.toBe(42);

    expect(capturedUrl).toBe(
      "https://api.anthropic.com/v1/messages/count_tokens",
    );
    expect(capturedInit?.headers).toMatchObject({
      "x-api-key": "secret",
      "anthropic-version": "2023-06-01",
    });
    expect(JSON.parse(String(capturedInit?.body))).toEqual({
      model: "claude-test",
      system: [{ type: "text", text: "System guidance." }],
      messages: [{ role: "user", content: "Budget this text." }],
    });
  });

  it("rejects countTokens on relay endpoints so callers can use the estimator", async () => {
    const fetchMock = vi.fn();
    const provider = new AnthropicChatProvider({
      apiKey: "secret",
      baseUrl: "https://relay.example.com",
      fetch: fetchMock,
    });

    await expect(
      provider.countTokens(
        {
          model: "claude-test",
          messages: [{ role: "user", content: "Hi" }],
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("emits a search chunk when the model starts a web search", async () => {
    const fetchMock: typeof fetch = async () =>
      streamResponse([
        {
          type: "content_block_start",
          content_block: { type: "server_tool_use", name: "web_search" },
        },
        {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "Result" },
        },
        { type: "message_stop" },
      ]);
    const provider = new AnthropicChatProvider({
      apiKey: "secret",
      baseUrl: "https://api.anthropic.com",
      fetch: fetchMock,
      webSearch: true,
    });

    const chunks = [];
    for await (const chunk of provider.stream(
      {
        model: "claude-test",
        messages: [{ role: "user", content: "Hi" }],
        maxOutputTokens: 256,
      },
      new AbortController().signal,
    )) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { type: "search" },
      { type: "text", text: "Result" },
      { type: "done", finishReason: undefined },
    ]);
  });

  it("turns the five-minute abort into GENERATION_TIMEOUT", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );
    const provider = new AnthropicChatProvider({
      apiKey: "secret",
      baseUrl: "https://api.anthropic.com",
      fetch: fetchMock as typeof fetch,
    });
    const iterator = provider.stream(
      {
        model: "claude-test",
        messages: [{ role: "user", content: "Hi" }],
        temperature: 0.5,
        maxOutputTokens: 256,
      },
      new AbortController().signal,
    )[Symbol.asyncIterator]();

    const result = expect(iterator.next()).rejects.toMatchObject({
      code: "GENERATION_TIMEOUT",
    });
    await vi.advanceTimersByTimeAsync(CHAT_TIMEOUT_MS);

    await result;
  });

  it("reports a suspected host suspension when the wall clock outruns the timer (background wrapper)", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );
    const provider = withSuspensionDetection(
      new AnthropicChatProvider({
        apiKey: "secret",
        baseUrl: "https://api.anthropic.com",
        fetch: fetchMock as typeof fetch,
      }),
    );
    const iterator = provider.stream(
      {
        model: "claude-test",
        messages: [{ role: "user", content: "Hi" }],
        temperature: 0.5,
        maxOutputTokens: 256,
      },
      new AbortController().signal,
    )[Symbol.asyncIterator]();

    const result = expect(iterator.next()).rejects.toMatchObject({
      code: "HOST_SUSPENDED",
    });
    // The laptop slept six hours mid-call; the timer only fires on resume.
    vi.setSystemTime(Date.now() + 6 * 60 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(CHAT_TIMEOUT_MS);

    await result;
  });

  it("forwards an already-aborted caller signal", async () => {
    const fetchMock: typeof fetch = async (_url, init) => {
      expect(init?.signal?.aborted).toBe(true);
      throw new DOMException("Aborted", "AbortError");
    };
    const provider = new AnthropicChatProvider({
      apiKey: "secret",
      baseUrl: "https://api.anthropic.com",
      fetch: fetchMock,
    });
    const controller = new AbortController();
    controller.abort("client disconnected");
    const iterator = provider.stream(
      {
        model: "claude-test",
        messages: [{ role: "user", content: "Hi" }],
        temperature: 0.5,
        maxOutputTokens: 256,
      },
      controller.signal,
    )[Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});
