export type ProviderErrorCode =
  | "GENERATION_TIMEOUT"
  | "PROVIDER_UNAVAILABLE"
  | "EMPTY_COMPLETION"
  // Tool-loop attempt endings (MC-117A): a refusal mid-loop, or max_tokens
  // cutting off a round that still owed tool execution. Both retract through
  // the existing failure path; the codes exist so the failed row says why.
  | "TOOL_LOOP_REFUSAL"
  | "TOOL_LOOP_MAX_TOKENS"
  // A call whose wall clock ran far past its own timer: the process was
  // probably paused mid-call (MC-118 decision 7, a heuristic). Background
  // jobs refund the attempt instead of charging it.
  | "HOST_SUSPENDED";

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
