import { describe, expect, it } from "vitest";

import {
  activityLabel,
  nextActivity,
  WEB_SEARCH_ACTIVITY,
} from "@/features/chat/tool-status";

function tool(status: "running" | "ok" | "error", toolName = "search_memory") {
  return { event: "tool" as const, data: { status, toolName } };
}

const search = { event: "search" as const, data: {} };

describe("tool activity transitions", () => {
  it("running → ok shows tool progress, then nothing", () => {
    expect(nextActivity(tool("running"))).toBe("search_memory");
    expect(activityLabel("search_memory")).toBe("Recalling memory…");
    expect(nextActivity(tool("ok"))).toBeNull();
  });

  it("a tool error ends the call without becoming a chat failure", () => {
    expect(nextActivity(tool("error"))).toBeNull();
  });

  it("repeated calls to the same tool toggle correctly", () => {
    expect(
      [tool("running"), tool("ok"), tool("running"), tool("ok")].map(
        nextActivity,
      ),
    ).toEqual(["search_memory", null, "search_memory", null]);
  });

  it("the latest event wins: a finished web search never resurfaces", () => {
    const states = [search, tool("running"), tool("ok")].map(nextActivity);
    expect(states).toEqual([WEB_SEARCH_ACTIVITY, "search_memory", null]);
    expect(activityLabel(WEB_SEARCH_ACTIVITY)).toBe("Searching the web…");
  });

  it("labels unknown tools generically", () => {
    expect(activityLabel("echo_test")).toBe("Running tool…");
  });
});
