// Timeout hierarchy (MC-116A): the provider timeout is authoritative — the
// backend retracts a wedged generation itself. The stale sweep recovers from
// process death, and the client idle bound is a last resort for a dead server
// process only; it must sit above every legitimate quiet period, because an
// abort now destroys the generation.
export const CHAT_TIMEOUT_MS = 5 * 60 * 1000;
export const STALE_STREAMING_MS = 6 * 60 * 1000;
export const STREAM_IDLE_TIMEOUT_MS = CHAT_TIMEOUT_MS + 60_000;

// Tool-loop context reserve (MC-117A decision 4), here rather than beside the
// loop because the settings schema — validated in the browser too — must
// subtract it when it checks that the chat window seats a full unsummarized
// history. First-round assembly reserves headroom for tool results plus
// replayed thinking blocks (open choice 1: reserve-at-assembly, not per-round
// re-count). The margin covers summarized-thinking replay across rounds.
export const TOOL_LOOP_RESULT_TOKEN_BUDGET = 2000; // estimated, attempt total
export const TOOL_LOOP_THINKING_REPLAY_MARGIN_TOKENS = 1200;
export const TOOL_LOOP_CONTEXT_RESERVE_TOKENS =
  TOOL_LOOP_RESULT_TOKEN_BUDGET + TOOL_LOOP_THINKING_REPLAY_MARGIN_TOKENS;
