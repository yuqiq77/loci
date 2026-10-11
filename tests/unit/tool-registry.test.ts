import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const embeddingMocks = vi.hoisted(() => ({
  isMemoryEnabled: vi.fn(() => true),
}));

vi.mock("@/server/memory/embedding", () => ({
  isMemoryEnabled: embeddingMocks.isMemoryEnabled,
  getEmbeddingProvider: vi.fn(() => null),
}));

import {
  getEnabledTools,
  registerToolForTests,
  resetToolsForTests,
  resolveToolSnapshot,
  serializeToolDefinition,
  toolSchemaHash,
  type ToolOutcome,
} from "@/server/chat/tool-registry";

import { makeEchoTestTool } from "../helpers/echo-test-tool";

afterEach(() => {
  resetToolsForTests();
});

describe("tool registry", () => {
  it("gates the production allowlist on tools_enabled", () => {
    // Off: no client tool definitions. On: exactly [search_memory].
    expect(getEnabledTools(false)).toEqual([]);
    expect(getEnabledTools(true).map((tool) => tool.name)).toEqual([
      "search_memory",
    ]);
  });

  it("keeps the gate closed without an embedding provider", () => {
    // The environment half of the gate (addendum §4): the toggle must not
    // advertise a tool whose every call would fail.
    embeddingMocks.isMemoryEnabled.mockReturnValueOnce(false);
    expect(getEnabledTools(true)).toEqual([]);
  });

  it("lets test-registered stubs bypass the owner gate", () => {
    registerToolForTests(makeEchoTestTool());
    expect(getEnabledTools(false).map((tool) => tool.name)).toEqual([
      "echo_test",
    ]);
  });

  it("refuses a duplicate tool name", () => {
    registerToolForTests(makeEchoTestTool());
    expect(() => registerToolForTests(makeEchoTestTool())).toThrow(
      /already registered/,
    );
    expect(() =>
      registerToolForTests(makeEchoTestTool({ name: "search_memory" })),
    ).toThrow(/already registered/);
  });

  it("resolves a snapshot gate-blind: a settings flip mid-attempt changes nothing", () => {
    // The gate was applied at beginGeneration; resolution must not re-check.
    expect(
      resolveToolSnapshot(["search_memory"]).map((tool) => tool.name),
    ).toEqual(["search_memory"]);
  });

  it("serializes deterministically regardless of schema key order", () => {
    const first = makeEchoTestTool({
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
      },
    });
    const second = makeEchoTestTool({
      inputSchema: {
        properties: { text: { type: "string" } },
        type: "object",
      },
    });

    expect(JSON.stringify(serializeToolDefinition(first))).toBe(
      JSON.stringify(serializeToolDefinition(second)),
    );
    expect(toolSchemaHash(first)).toBe(toolSchemaHash(second));
  });

  it("changes the schema hash when the contract surface changes", () => {
    const base = makeEchoTestTool();
    const changed = makeEchoTestTool({
      inputSchema: { type: "object", properties: {} },
    });
    expect(toolSchemaHash(base)).not.toBe(toolSchemaHash(changed));
  });

  it("resolves the beginGeneration snapshot, dropping names no longer registered", () => {
    registerToolForTests(makeEchoTestTool());
    expect(resolveToolSnapshot(["echo_test", "ghost_tool"])).toHaveLength(1);

    // The snapshot is immutable for the attempt: a name outside it never
    // resolves, no matter what registers later.
    registerToolForTests(makeEchoTestTool({ name: "late_tool" }));
    expect(
      resolveToolSnapshot(["echo_test"]).map((tool) => tool.name),
    ).toEqual(["echo_test"]);
  });
});

describe("outcome discriminator", () => {
  it("only the continue variant is constructible", () => {
    const outcome: ToolOutcome = {
      kind: "continue",
      result: { content: "ok" },
    };
    expect(outcome.kind).toBe("continue");

    // Non-`continue` variants are opaque, non-constructible types in Phase
    // A: each construction attempt below must be a type error.
    // @ts-expect-error yield is not constructible
    const yielded: ToolOutcome = { kind: "yield" };
    // @ts-expect-error present is not constructible
    const presented: ToolOutcome = { kind: "present" };
    // @ts-expect-error enqueue is not constructible
    const queued: ToolOutcome = { kind: "enqueue" };
    // @ts-expect-error terminal is not constructible
    const terminal: ToolOutcome = { kind: "terminal" };
    expect([yielded, presented, queued, terminal]).toBeDefined();
  });
});

// Static import-boundary test (MC-117A AC): continuity modules must not
// import the tool-run reader or the loop. A plain read over import
// statements — no lint machinery.
describe("continuity import boundary", () => {
  const root = join(__dirname, "..", "..", "src", "server");
  const continuityFiles = [
    ...readdirSync(join(root, "summaries"))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => join(root, "summaries", name)),
    ...readdirSync(join(root, "memory"))
      .filter((name) => name.startsWith("extract") && name.endsWith(".ts"))
      .map((name) => join(root, "memory", name)),
  ];
  const forbidden = [
    "db/tool-runs",
    "chat/tool-loop",
    "chat/tool-registry",
  ];

  it("keeps every continuity reader blind to tool runs", () => {
    expect(continuityFiles.length).toBeGreaterThanOrEqual(6);
    for (const file of continuityFiles) {
      const source = readFileSync(file, "utf8");
      const imports = source.match(/^import[\s\S]*?from\s+"[^"]+";/gmu) ?? [];
      for (const statement of imports) {
        for (const forbiddenModule of forbidden) {
          expect(
            statement.includes(forbiddenModule),
            `${file} imports ${forbiddenModule}`,
          ).toBe(false);
        }
      }
    }
  });
});
