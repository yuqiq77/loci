import type { ChatStreamEvent } from "./read-sse";

// Transient activity for a streaming assistant message (MC-117C): the name
// of whatever is running right now — a provider-hosted web search or a
// client tool — or null. The latest event wins, so a newer status can never
// sit behind an older one (a finished web search must not resurface after a
// client tool completes). One value per attempt, kept on the active draft
// (so a session switch restores it) and mirrored onto the visible message.
// Never persisted: a reload has no activity, and history rows carry none.
export const WEB_SEARCH_ACTIVITY = "web_search";

export function nextActivity(
  event: Extract<ChatStreamEvent, { event: "search" | "tool" }>,
): string | null {
  if (event.event === "search") {
    return WEB_SEARCH_ACTIVITY;
  }
  // ok and error both end the call; a tool error is not a chat failure —
  // the loop answers it and generation continues.
  return event.data.status === "running" ? event.data.toolName : null;
}

export function activityLabel(activeTool: string): string {
  switch (activeTool) {
    case "search_memory":
      return "Recalling memory…";
    case WEB_SEARCH_ACTIVITY:
      return "Searching the web…";
    default:
      return "Running tool…";
  }
}
