export type ThinkingEffort = "low" | "medium" | "high" | "max";

export type SessionSummary = {
  id: string;
  title: string;
  modelId: string;
  thinkingEnabled: boolean;
  thinkingEffort: ThinkingEffort;
  createdAt: string;
  updatedAt: string;
};

export const MEMORY_KINDS = [
  "boundary_fact",
  "shared_moment",
  "shift",
  "open_thread",
] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];

export type MessageRole = "user" | "assistant" | "system" | "tool";

export type MessageStatus =
  | "pending"
  | "streaming"
  | "complete"
  | "failed"
  | "cancelled";

export type ChatMessage = {
  id: string;
  role: MessageRole;
  content: string;
  thinking?: string;
  status: MessageStatus;
  // Name of the web search or client tool running right now (MC-117C).
  // Transient: set from the stream, never persisted, absent on history rows.
  activeTool?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  // Send-attempt id from the user row's metadata (MC-116A) — the handle
  // failure reconciliation matches on; content equality can't.
  attemptId?: string;
  // Transient supersede marker (MC-116B): the user message id of the old
  // pair this in-flight replacement rewrites. Exists only while the
  // replacement streams — cleared at commit, gone with a retracted row.
  supersedes?: string;
  createdAt: string;
};
