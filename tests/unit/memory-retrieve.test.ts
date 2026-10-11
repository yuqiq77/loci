import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RetrievedMemory } from "@/server/db/memories";

const mocks = vi.hoisted(() => ({
  embed: vi.fn(),
  getEmbeddingProvider: vi.fn(),
  retrieveByVector: vi.fn(),
  insertMemoryInjectionTraces: vi.fn(),
  listRecentlyInjectedMemoryIds: vi.fn(),
}));

vi.mock("@/server/memory/embedding", () => ({
  getEmbeddingProvider: mocks.getEmbeddingProvider,
}));
vi.mock("@/server/db/memories", () => ({
  retrieveByVector: mocks.retrieveByVector,
}));
vi.mock("@/server/db/memory-injections", () => ({
  insertMemoryInjectionTraces: mocks.insertMemoryInjectionTraces,
  listRecentlyInjectedMemoryIds: mocks.listRecentlyInjectedMemoryIds,
}));

import {
  buildRetrievalQuery,
  retrieveMemories,
} from "@/server/memory/retrieve";
import {
  SUPPRESSION_REASON_CUE,
  SUPPRESSION_REASON_SIMILARITY_THRESHOLD,
} from "@/server/memory/score";

function memory(
  overrides: Partial<RetrievedMemory> = {},
): RetrievedMemory {
  return {
    id: "memory-id",
    content: "A relevant memory",
    kind: "shared_moment",
    embedding: null,
    importance: 0.5,
    valence: 0,
    arousal: 0,
    resolved: false,
    pinned: false,
    supersededBy: null,
    sourceSessionId: null,
    sourceMessageId: null,
    contentHash: "hash",
    recallCount: 0,
    lastRecalledAt: null,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: new Date("2026-06-01T00:00:00Z"),
    deletedAt: null,
    similarity: 0.8,
    ...overrides,
  };
}

describe("memory retrieval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.embed.mockResolvedValue([[1, 0]]);
    mocks.getEmbeddingProvider.mockReturnValue({
      dimensions: 1536,
      embed: mocks.embed,
    });
    mocks.retrieveByVector.mockResolvedValue([]);
    mocks.insertMemoryInjectionTraces.mockResolvedValue(undefined);
    mocks.listRecentlyInjectedMemoryIds.mockResolvedValue(new Set());
  });

  it("expands short queries with the previous user message", async () => {
    await retrieveMemories({
      query: "嗯",
      previousUserMessage: "继续讲这个迁移计划",
      tokenBudget: 100,
      limit: 5,
    });

    expect(mocks.embed).toHaveBeenCalledWith([
      "继续讲这个迁移计划\n嗯",
    ]);
  });

  it("uses the session summary head when a short query has no previous user message", () => {
    expect(
      buildRetrievalQuery({
        query: "然后呢",
        sessionSummary: "我们在讨论 v0.2.0 的检索质量。",
      }),
    ).toBe("我们在讨论 v0.2.0 的检索质量。\n然后呢");
  });

  it("leaves threshold-length and longer queries unchanged", () => {
    expect(
      buildRetrievalQuery({
        query: "123456789012",
        previousUserMessage: "previous",
      }),
    ).toBe("123456789012");
    expect(
      buildRetrievalQuery({
        query: "这是一条超过十二个字符的查询",
        previousUserMessage: "上一句",
      }),
    ).toBe("这是一条超过十二个字符的查询");
  });

  it("keeps retrieval working when suppression lookup and trace write fail", async () => {
    mocks.retrieveByVector.mockResolvedValue([memory()]);
    mocks.listRecentlyInjectedMemoryIds.mockRejectedValue(
      new Error("lookup failed"),
    );
    mocks.insertMemoryInjectionTraces.mockRejectedValue(
      new Error("write failed"),
    );
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const memories = await retrieveMemories({
      query: "This is a long enough query",
      tokenBudget: 100,
      limit: 5,
      sessionId: "session-id",
      messageId: "message-id",
    });

    expect(memories.map((item) => item.id)).toEqual(["memory-id"]);
    expect(consoleError).toHaveBeenCalledWith(
      "Memory injection suppression lookup failed.",
      "Error",
    );
    expect(consoleError).toHaveBeenCalledWith(
      "Memory injection trace write failed.",
      "Error",
    );
    consoleError.mockRestore();
  });

  it("traces near-miss candidates as suppressed and skips far-below noise", async () => {
    mocks.retrieveByVector.mockResolvedValue([
      memory({ id: "kept", similarity: 0.8 }),
      memory({ id: "too-low", similarity: 0.69 }),
      memory({ id: "far-below", similarity: 0.3 }),
    ]);

    const memories = await retrieveMemories({
      query: "This is a long enough query",
      tokenBudget: 100,
      limit: 5,
      sessionId: "session-id",
      messageId: "message-id",
    });

    expect(memories.map((item) => item.id)).toEqual(["kept"]);
    expect(mocks.insertMemoryInjectionTraces).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          memoryId: "too-low",
          injected: false,
          suppressionReason: SUPPRESSION_REASON_SIMILARITY_THRESHOLD,
        }),
      ]),
    );
    const traced = mocks.insertMemoryInjectionTraces.mock.calls[0][0] as {
      memoryId: string;
    }[];
    expect(traced.map((row) => row.memoryId)).not.toContain("far-below");
  });

  it("traces shared-moment cue suppression while injecting salient band matches", async () => {
    mocks.retrieveByVector.mockResolvedValue([
      memory({
        id: "band-non-salient",
        similarity: 0.72,
        importance: 0.5,
        arousal: 0.5,
      }),
      memory({
        id: "band-important",
        similarity: 0.71,
        importance: 0.7,
      }),
      memory({
        id: "band-aroused",
        similarity: 0.71,
        arousal: 0.7,
      }),
      memory({
        id: "band-pinned",
        similarity: 0.71,
        pinned: true,
      }),
      memory({
        id: "strong-cue",
        similarity: 0.73,
        importance: 0.1,
        arousal: 0.1,
      }),
      memory({
        id: "below-base",
        similarity: 0.69,
      }),
    ]);

    const memories = await retrieveMemories({
      query: "This is a long enough query",
      tokenBudget: 1000,
      limit: 10,
      sessionId: "session-id",
      messageId: "message-id",
    });

    expect(memories.map((item) => item.id).sort()).toEqual([
      "band-aroused",
      "band-important",
      "band-pinned",
      "strong-cue",
    ]);
    expect(mocks.insertMemoryInjectionTraces).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          memoryId: "band-non-salient",
          injected: false,
          suppressionReason: SUPPRESSION_REASON_CUE,
        }),
        expect.objectContaining({
          memoryId: "below-base",
          injected: false,
          suppressionReason: SUPPRESSION_REASON_SIMILARITY_THRESHOLD,
        }),
      ]),
    );
  });

  it("uses the base gate for unresolved open threads and the strong-repeat gate for resolved ones", async () => {
    mocks.retrieveByVector.mockResolvedValue([
      memory({
        id: "open-unresolved",
        kind: "open_thread",
        resolved: false,
        similarity: 0.7,
      }),
      memory({
        id: "open-resolved-low",
        kind: "open_thread",
        resolved: true,
        similarity: 0.77,
      }),
      memory({
        id: "open-resolved-direct",
        kind: "open_thread",
        resolved: true,
        similarity: 0.78,
      }),
    ]);

    const memories = await retrieveMemories({
      query: "This is a long enough query",
      tokenBudget: 1000,
      limit: 10,
      sessionId: "session-id",
      messageId: "message-id",
    });

    expect(memories.map((item) => item.id).sort()).toEqual([
      "open-resolved-direct",
      "open-unresolved",
    ]);
    expect(mocks.insertMemoryInjectionTraces).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          memoryId: "open-resolved-low",
          injected: false,
          suppressionReason: SUPPRESSION_REASON_SIMILARITY_THRESHOLD,
        }),
      ]),
    );
  });
});
