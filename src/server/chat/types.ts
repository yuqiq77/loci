export type ModelRole = "system" | "user" | "assistant";

export type ModelMessage = {
  role: ModelRole;
  content: string;
};

// History rows keep their completion instant so context assembly can render
// server-local transcript stamps at read time. Stored content never carries
// stamps (one clock; presentation stamps are ours) — the instant rides beside
// the text, and consumers that need the raw content (retrieval query
// building) read `content` untouched.
export type TimedModelMessage = ModelMessage & {
  completedAt: Date;
};

// Rich provider-turn types for the tool loop (MC-117A). A NEW shape beside
// the string-shaped ModelMessage, never a reshape of it: offline writers
// (streamCompressionText consumers) keep the string type untouched.
export type ProviderTextBlock = { type: "text"; text: string };

// Thinking blocks are replayed unchanged with their signature in continuation
// requests (same-model requirement); redacted_thinking data is opaque and
// replayed verbatim.
export type ProviderThinkingBlock = {
  type: "thinking";
  thinking: string;
  signature: string;
};

export type ProviderRedactedThinkingBlock = {
  type: "redacted_thinking";
  data: string;
};

export type ProviderToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  // Parsed from the accumulated input JSON; {} with inputInvalid set when the
  // provider emitted JSON that does not parse — the loop answers that with a
  // recoverable error result instead of failing the attempt.
  input: Record<string, unknown>;
  inputInvalid?: boolean;
};

// Provider-hosted server tool blocks (web_search) that arrive in the same
// stream as client tool_use. Held raw so a continuation request can replay
// the assistant turn intact without modeling their provider-specific shape.
export type ProviderServerBlock = {
  type: "server_block";
  raw: Record<string, unknown>;
};

export type AssistantContentBlock =
  | ProviderTextBlock
  | ProviderThinkingBlock
  | ProviderRedactedThinkingBlock
  | ProviderToolUseBlock
  | ProviderServerBlock;

export type ProviderToolResultBlock = {
  type: "tool_result";
  toolUseId: string;
  content: string;
  isError?: boolean;
};

export type ProviderTurn =
  | { role: "assistant"; blocks: AssistantContentBlock[] }
  // A user turn carries the round's tool results, optionally followed by
  // text the loop appends (the forced-final hint) — append-only, never
  // edited, so replayed history stays byte-stable.
  | { role: "user"; blocks: (ProviderToolResultBlock | ProviderTextBlock)[] };

// Wire-ready client tool definition; serialization order and the
// tool_schema_hash both derive from the registry's single serializer.
export type WireToolDefinition = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export type ChatRequest = {
  model: string;
  messages: ModelMessage[];
  temperature?: number;
  maxOutputTokens: number;
  thinkingEnabled?: boolean;
  thinkingEffort?: string;
  // Tool-loop fields (MC-117A); all absent on non-loop callers, which keeps
  // the wire request — and the prompt-cache identity — byte-identical.
  tools?: WireToolDefinition[];
  toolTurns?: ProviderTurn[];
  toolChoice?: "auto" | "none";
  // When set the adapter assembles and yields complete content blocks; only
  // the loop opts in, so existing consumers never see the new chunk type.
  collectBlocks?: boolean;
};

export type TokenCountRequest = {
  model: string;
  messages: ModelMessage[];
};

export type ChatChunk =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "search" }
  | { type: "content_block"; block: AssistantContentBlock }
  | {
      type: "usage";
      inputTokens?: number;
      outputTokens?: number;
      cacheCreationInputTokens?: number;
      cacheReadInputTokens?: number;
    }
  | { type: "done"; finishReason?: string };

export interface ChatProvider {
  stream(
    request: ChatRequest,
    signal: AbortSignal,
  ): AsyncIterable<ChatChunk>;
  countTokens?(
    request: TokenCountRequest,
    signal: AbortSignal,
  ): Promise<number>;
}
