import {
  getChatEnv,
  getCompressionEnv,
  getConsolidationEnv,
  getExtractionEnv,
} from "@/server/env";
import { CHAT_TIMEOUT_MS } from "@/shared/chat";

import { modelRequiresThinking } from "./models";
import { ProviderError } from "./provider-error";
import { withSuspensionDetection } from "./suspension";
import type {
  AssistantContentBlock,
  ChatChunk,
  ChatProvider,
  ChatRequest,
  ModelMessage,
  ProviderTurn,
  TokenCountRequest,
} from "./types";

const ANTHROPIC_VERSION = "2023-06-01";

type FetchLike = typeof fetch;

type AnthropicUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

type AnthropicEvent = {
  type?: string;
  index?: number;
  content_block?: {
    type?: string;
    id?: string;
    name?: string;
    data?: string;
  } & Record<string, unknown>;
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    signature?: string;
    stop_reason?: string | null;
  };
  message?: {
    usage?: AnthropicUsage;
  };
  usage?: AnthropicUsage;
};

// In-flight content-block accumulation, keyed by the stream's block index.
// Client tool_use and server_tool_use accumulate input JSON; thinking
// accumulates text plus its signature; anything else provider-hosted is held
// raw so continuation requests can replay the assistant turn intact.
type PendingBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; thinking: string; signature: string }
  | { kind: "redacted_thinking"; data: string }
  | { kind: "tool_use"; id: string; name: string; json: string }
  | { kind: "server_tool_use"; id: string; name: string; json: string }
  | { kind: "server_raw"; raw: Record<string, unknown> };

// Empty accumulation means a no-argument call, not invalid JSON. A parse
// failure keeps the block replayable ({} input); for client tools the loop
// answers `invalid` with a recoverable error result.
function parseAccumulatedToolInput(json: string): {
  input: Record<string, unknown>;
  invalid: boolean;
} {
  if (!json) {
    return { input: {}, invalid: false };
  }
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { input: parsed as Record<string, unknown>, invalid: false };
    }
  } catch {
    // fall through to the invalid shape
  }
  return { input: {}, invalid: true };
}

function finalizePendingBlock(pending: PendingBlock): AssistantContentBlock {
  switch (pending.kind) {
    case "text":
      return { type: "text", text: pending.text };
    case "thinking":
      return {
        type: "thinking",
        thinking: pending.thinking,
        signature: pending.signature,
      };
    case "redacted_thinking":
      return { type: "redacted_thinking", data: pending.data };
    case "tool_use": {
      const { input, invalid } = parseAccumulatedToolInput(pending.json);
      return {
        type: "tool_use",
        id: pending.id,
        name: pending.name,
        input,
        ...(invalid ? { inputInvalid: true } : {}),
      };
    }
    case "server_tool_use":
      return {
        type: "server_block",
        raw: {
          type: "server_tool_use",
          id: pending.id,
          name: pending.name,
          input: parseAccumulatedToolInput(pending.json).input,
        },
      };
    case "server_raw":
      return { type: "server_block", raw: pending.raw };
  }
}

type AnthropicTokenCountResponse = {
  input_tokens?: number;
};

function totalInputTokens(usage: AnthropicUsage): number | undefined {
  const total =
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0);

  return total > 0 ? total : undefined;
}

function usageChunk(usage: AnthropicUsage): ChatChunk {
  return {
    type: "usage",
    inputTokens: totalInputTokens(usage),
    outputTokens: usage.output_tokens,
    cacheCreationInputTokens: usage.cache_creation_input_tokens,
    cacheReadInputTokens: usage.cache_read_input_tokens,
  };
}

// Wire mapping for tool-loop continuation turns. Assistant blocks are
// replayed exactly as received (thinking keeps its signature, server blocks
// their raw shape); tool results travel as string content.
function toAnthropicTurn(turn: ProviderTurn) {
  if (turn.role === "assistant") {
    return {
      role: "assistant" as const,
      content: turn.blocks.map((block) => {
        switch (block.type) {
          case "text":
            return { type: "text" as const, text: block.text };
          case "thinking":
            return {
              type: "thinking" as const,
              thinking: block.thinking,
              signature: block.signature,
            };
          case "redacted_thinking":
            return { type: "redacted_thinking" as const, data: block.data };
          case "tool_use":
            return {
              type: "tool_use" as const,
              id: block.id,
              name: block.name,
              input: block.input,
            };
          case "server_block":
            return block.raw;
        }
      }),
    };
  }
  return {
    role: "user" as const,
    content: turn.blocks.map((block) =>
      block.type === "text"
        ? { type: "text" as const, text: block.text }
        : {
            type: "tool_result" as const,
            tool_use_id: block.toolUseId,
            // content is optional on tool_result and an empty text block
            // would be rejected — a budget-squeezed empty result omits the
            // field.
            ...(block.content ? { content: block.content } : {}),
            ...(block.isError ? { is_error: true } : {}),
          },
    ),
  };
}

function toAnthropicRequest(
  request: ChatRequest,
  options: { promptCaching?: boolean; webSearch?: boolean },
) {
  const system = request.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const chatMessages = request.messages.filter(
    (message): message is ModelMessage & { role: "user" | "assistant" } =>
      message.role === "user" || message.role === "assistant",
  );
  // Roll the message-level breakpoint onto the last settled history message
  // (second to last), never the current turn: the current turn and any anchors
  // are volatile and must stay out of the cached prefix.
  const settledIndex = chatMessages.length - 2;
  const messages = chatMessages.map((message, index) => ({
    role: message.role,
    content:
      options.promptCaching && index === settledIndex
        ? [
            {
              type: "text" as const,
              text: message.content,
              cache_control: { type: "ephemeral" as const },
            },
          ]
        : message.content,
  }));

  const systemBlocks = system
    ? [
        {
          type: "text" as const,
          text: system,
          ...(options.promptCaching
            ? { cache_control: { type: "ephemeral" as const } }
            : {}),
        },
      ]
    : undefined;

  return {
    model: request.model,
    max_tokens: request.maxOutputTokens,
    // Temperature is omitted when thinking is on (thinking requires the default
    // temperature) and when the caller leaves it undefined (models that
    // deprecated sampling params) — sending it otherwise returns a 400.
    ...(!request.thinkingEnabled && request.temperature !== undefined
      ? { temperature: request.temperature }
      : {}),
    stream: true,
    // Only callers that opt in (the user-facing chat) set `thinkingEnabled`;
    // the compression provider leaves it undefined and is unaffected.
    ...(request.thinkingEnabled === undefined
      ? {}
      : request.thinkingEnabled
        ? {
            thinking: { type: "adaptive", display: "summarized" },
            output_config: { effort: request.thinkingEffort ?? "high" },
          }
        : modelRequiresThinking(request.model)
          ? // Always-on-thinking models (Fable 5, Opus 5.5) 400 on an explicit
            // `disabled` — omitting the param is the only way to say "off".
            {}
          : { thinking: { type: "disabled" } }),
    // Client tool definitions (already deterministically serialized by the
    // registry) coexist with native server-side web search in one request:
    // Anthropic runs web_search itself and streams the answer back, while
    // client tool_use blocks come back for the loop to execute. Parallel tool
    // use is disabled by contract (MC-117A serial-only); the final permitted
    // round pins tool_choice to none so the model must answer.
    ...(request.tools?.length || options.webSearch
      ? {
          tools: [
            // Already wire-shaped by the registry's single serializer; no
            // field re-map here, or the hash-equals-wire invariant drifts.
            ...(request.tools ?? []),
            ...(options.webSearch
              ? [
                  {
                    type: "web_search_20260209" as const,
                    name: "web_search" as const,
                    // Direct calls only. The provider default routes this
                    // tool through programmatic tool calling, which rejects
                    // `disable_parallel_tool_use` and a forced `tool_choice`,
                    // so the serial-only contract below could not be sent.
                    allowed_callers: ["direct" as const],
                  },
                ]
              : []),
          ],
        }
      : {}),
    ...(request.tools?.length
      ? {
          tool_choice:
            request.toolChoice === "none"
              ? { type: "none" as const }
              : { type: "auto" as const, disable_parallel_tool_use: true },
        }
      : {}),
    ...(systemBlocks ? { system: systemBlocks } : {}),
    messages: [
      ...messages,
      ...(request.toolTurns ?? []).map((turn) => toAnthropicTurn(turn)),
    ],
  };
}

function toAnthropicTokenCountRequest(request: TokenCountRequest) {
  const system = request.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const messages = request.messages
    .filter(
      (message): message is ModelMessage & { role: "user" | "assistant" } =>
        message.role === "user" || message.role === "assistant",
    )
    .map((message) => ({
      role: message.role,
      content: message.content,
    }));
  const systemBlocks = system
    ? [{ type: "text" as const, text: system }]
    : undefined;

  return {
    model: request.model,
    ...(systemBlocks ? { system: systemBlocks } : {}),
    messages,
  };
}

async function* parseSse(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<AnthropicEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? "";

    for (const block of blocks) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data || data === "[DONE]") {
        continue;
      }

      try {
        yield JSON.parse(data) as AnthropicEvent;
      } catch {
        throw new ProviderError(
          "PROVIDER_UNAVAILABLE",
          "Anthropic returned an invalid stream event.",
        );
      }
    }

    if (done) {
      break;
    }
  }
}

export class AnthropicChatProvider implements ChatProvider {
  constructor(
    private readonly options: {
      apiKey: string;
      baseUrl: string;
      fetch?: FetchLike;
      timeoutMs?: number;
      promptCaching?: boolean;
      webSearch?: boolean;
    },
  ) {}

  async *stream(
    request: ChatRequest,
    signal: AbortSignal,
  ): AsyncIterable<ChatChunk> {
    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = () => controller.abort(signal.reason);
    if (signal.aborted) {
      abortFromCaller();
    } else {
      signal.addEventListener("abort", abortFromCaller, { once: true });
    }
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.options.timeoutMs ?? CHAT_TIMEOUT_MS);

    try {
      const response = await (this.options.fetch ?? fetch)(
        `${this.options.baseUrl.replace(/\/$/, "")}/v1/messages`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": this.options.apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
          },
          body: JSON.stringify(
            toAnthropicRequest(request, {
              promptCaching: this.options.promptCaching,
              webSearch: this.options.webSearch,
            }),
          ),
          signal: controller.signal,
        },
      );

      if (!response.ok || !response.body) {
        let detail = "";
        try {
          detail = (await response.text()).slice(0, 500);
        } catch {
          detail = "";
        }
        throw new ProviderError(
          "PROVIDER_UNAVAILABLE",
          `Anthropic request failed with status ${response.status}.${
            detail ? ` ${detail}` : ""
          }`,
        );
      }

      let finishReason: string | undefined;
      let stopped = false;
      // Assembled only when the caller opts in (`collectBlocks`): the tool
      // loop needs complete blocks for replay; every other consumer keeps the
      // exact chunk stream it had before MC-117A.
      const pendingBlocks = new Map<number, PendingBlock>();
      for await (const event of parseSse(response.body)) {
        if (
          event.type === "content_block_delta" &&
          event.delta?.type === "text_delta" &&
          event.delta.text
        ) {
          if (request.collectBlocks && event.index !== undefined) {
            const pending = pendingBlocks.get(event.index);
            if (pending?.kind === "text") {
              pending.text += event.delta.text;
            }
          }
          yield { type: "text", text: event.delta.text };
        } else if (
          event.type === "content_block_delta" &&
          event.delta?.type === "thinking_delta" &&
          event.delta.thinking
        ) {
          if (request.collectBlocks && event.index !== undefined) {
            const pending = pendingBlocks.get(event.index);
            if (pending?.kind === "thinking") {
              pending.thinking += event.delta.thinking;
            }
          }
          yield { type: "thinking", text: event.delta.thinking };
        } else if (
          event.type === "content_block_delta" &&
          event.delta?.type === "signature_delta" &&
          event.delta.signature
        ) {
          if (request.collectBlocks && event.index !== undefined) {
            const pending = pendingBlocks.get(event.index);
            if (pending?.kind === "thinking") {
              pending.signature += event.delta.signature;
            }
          }
        } else if (
          event.type === "content_block_delta" &&
          event.delta?.type === "input_json_delta" &&
          event.delta.partial_json !== undefined
        ) {
          if (request.collectBlocks && event.index !== undefined) {
            const pending = pendingBlocks.get(event.index);
            if (
              pending?.kind === "tool_use" ||
              pending?.kind === "server_tool_use"
            ) {
              pending.json += event.delta.partial_json;
            }
          }
        } else if (event.type === "content_block_start") {
          const block = event.content_block;
          if (
            block?.type === "server_tool_use" &&
            block?.name === "web_search"
          ) {
            // The model started a native web search; surface it so the UI can
            // show a "searching" indicator. The result is threaded back and
            // the answer resumes as text in the same stream.
            yield { type: "search" };
          }
          if (request.collectBlocks && event.index !== undefined && block) {
            if (block.type === "text") {
              pendingBlocks.set(event.index, { kind: "text", text: "" });
            } else if (block.type === "thinking") {
              pendingBlocks.set(event.index, {
                kind: "thinking",
                thinking: "",
                signature: "",
              });
            } else if (block.type === "redacted_thinking") {
              pendingBlocks.set(event.index, {
                kind: "redacted_thinking",
                data: block.data ?? "",
              });
            } else if (block.type === "tool_use") {
              pendingBlocks.set(event.index, {
                kind: "tool_use",
                id: block.id ?? "",
                name: block.name ?? "",
                json: "",
              });
            } else if (block.type === "server_tool_use") {
              pendingBlocks.set(event.index, {
                kind: "server_tool_use",
                id: block.id ?? "",
                name: block.name ?? "",
                json: "",
              });
            } else {
              // Provider-hosted result blocks (web_search_tool_result) arrive
              // complete; hold them raw for intact replay.
              pendingBlocks.set(event.index, {
                kind: "server_raw",
                raw: block as Record<string, unknown>,
              });
            }
          }
        } else if (event.type === "content_block_stop") {
          if (request.collectBlocks && event.index !== undefined) {
            const pending = pendingBlocks.get(event.index);
            if (pending) {
              pendingBlocks.delete(event.index);
              yield {
                type: "content_block",
                block: finalizePendingBlock(pending),
              };
            }
          }
        } else if (event.type === "message_start" && event.message?.usage) {
          yield usageChunk(event.message.usage);
        } else if (event.type === "message_delta") {
          finishReason = event.delta?.stop_reason ?? finishReason;
          if (event.usage) {
            yield usageChunk(event.usage);
          }
        } else if (event.type === "message_stop") {
          stopped = true;
          yield { type: "done", finishReason };
        }
      }

      if (!stopped) {
        throw new ProviderError(
          "PROVIDER_UNAVAILABLE",
          "Anthropic stream ended before message_stop.",
        );
      }
    } catch (error) {
      if (timedOut) {
        throw new ProviderError(
          "GENERATION_TIMEOUT",
          "Anthropic generation timed out.",
        );
      }
      if (signal.aborted) {
        throw error;
      }
      if (error instanceof ProviderError) {
        throw error;
      }
      throw new ProviderError(
        "PROVIDER_UNAVAILABLE",
        "Anthropic request failed.",
      );
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abortFromCaller);
    }
  }

  async countTokens(
    request: TokenCountRequest,
    signal: AbortSignal,
  ): Promise<number> {
    if (!isOfficialAnthropicEndpoint(this.options.baseUrl)) {
      throw new ProviderError(
        "PROVIDER_UNAVAILABLE",
        "Anthropic count-tokens requires the official endpoint.",
      );
    }

    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = () => controller.abort(signal.reason);
    if (signal.aborted) {
      abortFromCaller();
    } else {
      signal.addEventListener("abort", abortFromCaller, { once: true });
    }
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.options.timeoutMs ?? CHAT_TIMEOUT_MS);

    try {
      const response = await (this.options.fetch ?? fetch)(
        `${this.options.baseUrl.replace(/\/$/, "")}/v1/messages/count_tokens`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": this.options.apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
          },
          body: JSON.stringify(toAnthropicTokenCountRequest(request)),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        let detail = "";
        try {
          detail = (await response.text()).slice(0, 500);
        } catch {
          detail = "";
        }
        throw new ProviderError(
          "PROVIDER_UNAVAILABLE",
          `Anthropic count-tokens failed with status ${response.status}.${
            detail ? ` ${detail}` : ""
          }`,
        );
      }

      const data = (await response.json()) as AnthropicTokenCountResponse;
      if (typeof data.input_tokens !== "number") {
        throw new ProviderError(
          "PROVIDER_UNAVAILABLE",
          "Anthropic count-tokens returned an invalid response.",
        );
      }
      return data.input_tokens;
    } catch (error) {
      if (timedOut) {
        throw new ProviderError(
          "GENERATION_TIMEOUT",
          "Anthropic count-tokens timed out.",
        );
      }
      if (signal.aborted) {
        throw error;
      }
      if (error instanceof ProviderError) {
        throw error;
      }
      throw new ProviderError(
        "PROVIDER_UNAVAILABLE",
        "Anthropic count-tokens request failed.",
      );
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abortFromCaller);
    }
  }
}

// Native web search is an Anthropic-hosted server tool: the search runs and its
// result is threaded back to the model entirely on Anthropic's side, within one
// response. A third-party relay that accepts the `tools` field but does not
// faithfully execute (or splits the server_tool_use/result pair across upstream
// accounts) leaves the model without its search result, so it searches again in
// a loop. That cannot be fixed from the client, so web search is only sent to
// the official host; any other CHAT_BASE_URL runs without it.
export function isOfficialAnthropicEndpoint(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === "api.anthropic.com";
  } catch {
    return false;
  }
}

export function shouldEnableWebSearch(
  baseUrl: string,
  webSearchEnabled: boolean,
): boolean {
  return webSearchEnabled && isOfficialAnthropicEndpoint(baseUrl);
}

export function assertChatProviderConfigured(): void {
  getChatEnv();
}

export function getChatProvider(options: {
  webSearchEnabled: boolean;
}): ChatProvider {
  const env = getChatEnv();
  return new AnthropicChatProvider({
    apiKey: env.CHAT_API_KEY,
    baseUrl: env.CHAT_BASE_URL,
    promptCaching: true,
    webSearch: shouldEnableWebSearch(
      env.CHAT_BASE_URL,
      options.webSearchEnabled,
    ),
  });
}

// The background factories wrap the provider with host-suspension
// detection (MC-118 decision 7); the user-facing getChatProvider does not —
// a refund semantic has no meaning on the chat path.
export function getCompressionProvider(): ChatProvider {
  const env = getCompressionEnv();
  return withSuspensionDetection(
    new AnthropicChatProvider({
      apiKey: env.COMPRESSION_API_KEY,
      baseUrl: env.COMPRESSION_BASE_URL,
    }),
  );
}

export function getConsolidationProvider(): ChatProvider {
  const env = getConsolidationEnv();
  return withSuspensionDetection(
    new AnthropicChatProvider({
      apiKey: env.CONSOLIDATION_API_KEY,
      baseUrl: env.CONSOLIDATION_BASE_URL,
    }),
  );
}

export function getExtractionProvider(): ChatProvider {
  const env = getExtractionEnv();
  return withSuspensionDetection(
    new AnthropicChatProvider({
      apiKey: env.EXTRACTION_API_KEY,
      baseUrl: env.EXTRACTION_BASE_URL,
    }),
  );
}

// The chat account's credentials as a plain streaming provider — no prompt
// caching, no web search; those are chat-path options with no business on a
// one-shot background job. Narrative consolidation runs on the main chat
// model first and falls back to the consolidation provider.
export function getChatBackgroundProvider(): ChatProvider {
  const env = getChatEnv();
  return withSuspensionDetection(
    new AnthropicChatProvider({
      apiKey: env.CHAT_API_KEY,
      baseUrl: env.CHAT_BASE_URL,
    }),
  );
}
