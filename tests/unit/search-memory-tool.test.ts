import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  retrieveByVector: vi.fn(),
  getEmbeddingProvider: vi.fn(),
  embed: vi.fn(),
}));

vi.mock("@/server/db/memories", () => ({
  retrieveByVector: mocks.retrieveByVector,
}));
vi.mock("@/server/memory/embedding", () => ({
  getEmbeddingProvider: mocks.getEmbeddingProvider,
}));

import { estimateTextTokens } from "@/server/chat/context";
import {
  searchMemoryTool,
  SEARCH_MEMORY_DEFAULT_LIMIT,
  SEARCH_MEMORY_MAX_LIMIT,
  SEARCH_MEMORY_RESULT_TOKEN_BUDGET,
  TOOL_QUERY_MAX_CHARS,
} from "@/server/chat/tools/search-memory";

function memoryRow(id: string, content: string) {
  return {
    id,
    content,
    kind: "shared_moment",
    createdAt: new Date(2026, 7, 20, 10, 0),
    updatedAt: new Date(2026, 7, 25, 10, 0),
  };
}

function context(excludeMemoryIds: string[] = []) {
  return { signal: new AbortController().signal, excludeMemoryIds };
}

async function run(
  input: Record<string, unknown>,
  executionContext = context(),
) {
  const outcome = await searchMemoryTool.execute(input, executionContext);
  if (outcome.kind !== "continue") {
    throw new Error("unexpected outcome kind");
  }
  return outcome.result;
}

describe("search_memory tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    mocks.getEmbeddingProvider.mockReturnValue({
      dimensions: 3,
      embed: mocks.embed,
    });
    mocks.embed.mockResolvedValue([[0.1, 0.2, 0.3]]);
    mocks.retrieveByVector.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns full bounded atoms with provenance and refs", async () => {
    mocks.retrieveByVector.mockResolvedValue([
      memoryRow("m1", "Riley prefers weekly project updates."),
    ]);

    const result = await run({ query: "check-in preference" });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content)).toEqual({
      items: [
        {
          content: "Riley prefers weekly project updates.",
          kind: "shared_moment",
          source_type: "memory_row",
          recorded_at: "2026-08-20",
          updated_at: "2026-08-25",
          source_ref: "memory:m1",
        },
      ],
    });
    expect(mocks.embed).toHaveBeenCalledWith(
      ["check-in preference"],
      expect.any(AbortSignal),
    );
    expect(mocks.retrieveByVector).toHaveBeenCalledWith(
      [0.1, 0.2, 0.3],
      SEARCH_MEMORY_DEFAULT_LIMIT,
      [],
    );
  });

  it("excludes this request's anchor-injected rows in the query itself", async () => {
    // SQL-side exclusion: a JS post-filter against retrieveByVector's
    // internal row cap could starve the limit while matches exist below it.
    mocks.retrieveByVector.mockResolvedValue([memoryRow("m2", "fresh hit")]);

    const result = await run({ query: "anything" }, context(["anchor-1"]));

    const items = JSON.parse(result.content).items as { source_ref: string }[];
    expect(items.map((item) => item.source_ref)).toEqual(["memory:m2"]);
    expect(mocks.retrieveByVector).toHaveBeenCalledWith(
      [0.1, 0.2, 0.3],
      SEARCH_MEMORY_DEFAULT_LIMIT,
      ["anchor-1"],
    );
  });

  it("fits its own result budget with a parseable envelope", async () => {
    // Five long CJK atoms far exceed the 800-token budget; the tool must
    // stop adding items instead of letting the substrate clamp cut the
    // JSON mid-string.
    mocks.retrieveByVector.mockResolvedValue(
      Array.from({ length: 5 }, (_, index) =>
        memoryRow(`m${index}`, "很".repeat(900)),
      ),
    );

    const result = await run({ query: "anything" });

    const parsed = JSON.parse(result.content) as { items: unknown[] };
    expect(parsed.items.length).toBeGreaterThan(0);
    expect(parsed.items.length).toBeLessThan(5);
    expect(
      estimateTextTokens(result.content),
    ).toBeLessThanOrEqual(SEARCH_MEMORY_RESULT_TOKEN_BUDGET);
  });

  it("truncates a single oversized atom instead of breaking the envelope", async () => {
    mocks.retrieveByVector.mockResolvedValue([
      memoryRow("m1", "很".repeat(3000)),
    ]);

    const result = await run({ query: "anything" });

    const parsed = JSON.parse(result.content) as {
      items: { content: string; source_ref: string }[];
    };
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].content.endsWith("…")).toBe(true);
    expect(parsed.items[0].source_ref).toBe("memory:m1");
    expect(
      estimateTextTokens(result.content),
    ).toBeLessThanOrEqual(SEARCH_MEMORY_RESULT_TOKEN_BUDGET);
  });

  it("clamps limit into range and defaults it when absent or junk", async () => {
    await run({ query: "q1", limit: 50 });
    expect(mocks.retrieveByVector).toHaveBeenLastCalledWith(
      expect.anything(),
      SEARCH_MEMORY_MAX_LIMIT,
      [],
    );
    await run({ query: "q2", limit: "three" });
    expect(mocks.retrieveByVector).toHaveBeenLastCalledWith(
      expect.anything(),
      SEARCH_MEMORY_DEFAULT_LIMIT,
      [],
    );
  });

  it("rejects an over-long query with a recoverable error result", async () => {
    const result = await run({ query: "很".repeat(TOOL_QUERY_MAX_CHARS + 1) });
    expect(result.isError).toBe(true);
    expect(mocks.embed).not.toHaveBeenCalled();
  });

  it("rejects a missing or empty query with a recoverable error result", async () => {
    expect((await run({})).isError).toBe(true);
    expect((await run({ query: "   " })).isError).toBe(true);
    expect(mocks.embed).not.toHaveBeenCalled();
  });

  it("reports unavailability when no embedding provider is configured", async () => {
    mocks.getEmbeddingProvider.mockReturnValue(null);
    const result = await run({ query: "anything" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not available");
  });

  it("propagates cancellation through the embedding call", async () => {
    const abort = new AbortController();
    mocks.embed.mockImplementation(
      (_inputs: string[], signal: AbortSignal) =>
        new Promise((_, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new Error("embed aborted")),
            { once: true },
          );
        }),
    );

    const pending = searchMemoryTool.execute(
      { query: "long lookup" },
      { signal: abort.signal, excludeMemoryIds: [] },
    );
    const failure = pending.catch((error) => error);
    abort.abort();

    await expect(failure).resolves.toBeInstanceOf(Error);
    expect(mocks.retrieveByVector).not.toHaveBeenCalled();
  });
});
