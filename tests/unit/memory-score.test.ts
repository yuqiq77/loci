import { describe, expect, it } from "vitest";

import {
  memorySelectionSuppressionReason,
  memoryRepeatSuppressionReason,
  MIN_MEMORY_SIMILARITY,
  PINNED_REPEAT_SIMILARITY,
  recencyWeight,
  rerankMemories,
  scoreMemory,
  selectMemoryInjectionDecisions,
  SHARED_MOMENT_STRONG_CUE,
  STRONG_REPEAT_SIMILARITY,
  SUPPRESSION_REASON_CUE,
  SUPPRESSION_REASON_LIMIT,
  SUPPRESSION_REASON_SESSION_REPEAT,
  SUPPRESSION_REASON_SIMILARITY_THRESHOLD,
  SUPPRESSION_REASON_TOKEN_BUDGET,
} from "@/server/memory/score";
import {
  estimateTextTokens,
  formatAnchorContext,
} from "@/server/chat/context";
import type { RetrievedMemory } from "@/server/db/memories";

function memory(
  overrides: Partial<RetrievedMemory> = {},
): RetrievedMemory {
  return {
    id: crypto.randomUUID(),
    content: "A durable memory",
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
    createdAt: new Date("2026-05-16T00:00:00Z"),
    updatedAt: new Date("2026-05-16T00:00:00Z"),
    deletedAt: null,
    similarity: 0.8,
    ...overrides,
  };
}

describe("memory scoring", () => {
  const now = new Date("2026-06-15T00:00:00Z");

  it("uses a 30-day half-life and the documented weighted formula", () => {
    expect(recencyWeight(memory(), now)).toBeCloseTo(0.5);
    // pinned ⇒ no decay (recency weight 1):
    // 0.8*0.6 + 1*0.2 + 0.8*0.1 + 1*0.1 + 0.1 = 0.96
    expect(
      scoreMemory(
        memory({
          importance: 1,
          valence: -0.5,
          arousal: 1,
          pinned: true,
        }),
        now,
      ),
    ).toBeCloseTo(0.96);
  });

  it("does not decay durable kinds or still-open threads", () => {
    expect(recencyWeight(memory({ kind: "boundary_fact" }), now)).toBe(1);
    expect(
      recencyWeight(memory({ kind: "open_thread", resolved: false }), now),
    ).toBe(1);
  });

  it("lets arousal lengthen the half-life", () => {
    // arousal 1 ⇒ half-life 60d; 30 days old ⇒ 2^(-0.5) ≈ 0.707
    expect(recencyWeight(memory({ arousal: 1 }), now)).toBeCloseTo(0.707);
  });

  it("sinks resolved open threads", () => {
    // 0.9*0.6 = 0.54, sunk to 10% ⇒ 0.054
    expect(
      scoreMemory(
        memory({ kind: "open_thread", resolved: true, similarity: 0.9 }),
        now,
      ),
    ).toBeCloseTo(0.054);
  });

  it("keeps the calibrated threshold ordering", () => {
    expect(MIN_MEMORY_SIMILARITY).toBeLessThan(PINNED_REPEAT_SIMILARITY);
    expect(PINNED_REPEAT_SIMILARITY).toBeLessThan(
      SHARED_MOMENT_STRONG_CUE,
    );
    expect(SHARED_MOMENT_STRONG_CUE).toBeLessThan(
      STRONG_REPEAT_SIMILARITY,
    );
  });

  it("applies the shared-moment OR gate", () => {
    expect(
      memorySelectionSuppressionReason(
        memory({ kind: "shared_moment", similarity: 0.69 }),
      ),
    ).toBe(SUPPRESSION_REASON_SIMILARITY_THRESHOLD);
    expect(
      memorySelectionSuppressionReason(
        memory({ kind: "shared_moment", similarity: 0.72 }),
      ),
    ).toBe(SUPPRESSION_REASON_CUE);
    expect(
      memorySelectionSuppressionReason(
        memory({
          kind: "shared_moment",
          similarity: 0.72,
          importance: 0.7,
        }),
      ),
    ).toBeNull();
    expect(
      memorySelectionSuppressionReason(
        memory({
          kind: "shared_moment",
          similarity: 0.72,
          arousal: 0.7,
        }),
      ),
    ).toBeNull();
    expect(
      memorySelectionSuppressionReason(
        memory({
          kind: "shared_moment",
          similarity: 0.72,
          pinned: true,
        }),
      ),
    ).toBeNull();
    expect(
      memorySelectionSuppressionReason(
        memory({ kind: "shared_moment", similarity: 0.73 }),
      ),
    ).toBeNull();
  });

  it("uses the base gate for unresolved open threads and strong-repeat gate for resolved ones", () => {
    expect(
      memorySelectionSuppressionReason(
        memory({
          kind: "open_thread",
          resolved: false,
          similarity: 0.7,
        }),
      ),
    ).toBeNull();
    expect(
      memorySelectionSuppressionReason(
        memory({
          kind: "open_thread",
          resolved: true,
          similarity: 0.77,
        }),
      ),
    ).toBe(SUPPRESSION_REASON_SIMILARITY_THRESHOLD);
    expect(
      memorySelectionSuppressionReason(
        memory({
          kind: "open_thread",
          resolved: true,
          similarity: 0.78,
        }),
      ),
    ).toBeNull();
  });

  it("reranks by score and obeys item and token budgets", () => {
    const ranked = rerankMemories(
      [
        memory({ id: "low", content: "low", similarity: 0.7 }),
        memory({ id: "high", content: "high", similarity: 0.9 }),
      ],
      now,
    );

    expect(ranked.map((item) => item.id)).toEqual(["high", "low"]);
    const oneMemoryBudget = estimateTextTokens(
      formatAnchorContext(["high"]),
    );
    const injected = (decisions: { injected: boolean }[]) =>
      decisions.filter((decision) => decision.injected);
    expect(
      injected(selectMemoryInjectionDecisions(ranked, oneMemoryBudget, 5)),
    ).toHaveLength(1);
    expect(
      injected(selectMemoryInjectionDecisions(ranked, 100, 1)),
    ).toHaveLength(1);
  });

  it("suppresses recent non-boundary repeats unless relevance is strong or pinned", () => {
    const recent = new Set(["repeat"]);

    expect(
      memoryRepeatSuppressionReason(
        memory({ id: "repeat", similarity: 0.77 }),
        recent,
      ),
    ).toBe(SUPPRESSION_REASON_SESSION_REPEAT);
    expect(
      memoryRepeatSuppressionReason(
        memory({
          id: "repeat",
          kind: "boundary_fact",
          similarity: 0.7,
        }),
        recent,
      ),
    ).toBeNull();
    expect(
      memoryRepeatSuppressionReason(
        memory({ id: "repeat", similarity: 0.78 }),
        recent,
      ),
    ).toBeNull();
    expect(
      memoryRepeatSuppressionReason(
        memory({ id: "repeat", pinned: true, similarity: 0.72 }),
        recent,
      ),
    ).toBeNull();
  });

  it("records injection decisions for repeated, limit, and token-budget suppression", () => {
    const ranked = rerankMemories(
      [
        memory({ id: "repeat", content: "repeat", similarity: 0.77 }),
        memory({ id: "selected", content: "selected", similarity: 0.9 }),
        memory({ id: "limited", content: "limited", similarity: 0.88 }),
      ],
      now,
    );

    const decisions = selectMemoryInjectionDecisions(
      ranked,
      100,
      1,
      new Set(["repeat"]),
    );

    expect(
      decisions.map((decision) => ({
        id: decision.memory.id,
        injected: decision.injected,
        reason: decision.suppressionReason,
      })),
    ).toEqual([
      { id: "selected", injected: true, reason: null },
      {
        id: "limited",
        injected: false,
        reason: SUPPRESSION_REASON_LIMIT,
      },
      {
        id: "repeat",
        injected: false,
        reason: SUPPRESSION_REASON_SESSION_REPEAT,
      },
    ]);

    expect(
      selectMemoryInjectionDecisions(
        rerankMemories([memory()], now),
        1,
        5,
      )[0].suppressionReason,
    ).toBe(SUPPRESSION_REASON_TOKEN_BUDGET);
  });
});
