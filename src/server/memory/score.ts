import {
  estimateTextTokens,
  formatAnchorContext,
} from "@/server/chat/context";
import type { RetrievedMemory } from "@/server/db/memories";

// Kind-aware similarity gate. boundary_fact must surface easily because missing
// it causes mistakes; episodic kinds use the normal threshold. Calibrate these
// against real retrieval similarities for the embedding model in use.
export const MIN_MEMORY_SIMILARITY = 0.7;
export const BOUNDARY_MIN_MEMORY_SIMILARITY = 0.55;
export const RECENCY_HALF_LIFE_DAYS = 30;
export const PINNED_REPEAT_SIMILARITY = 0.72;
export const SHARED_MOMENT_STRONG_CUE = 0.73;
export const STRONG_REPEAT_SIMILARITY = 0.78;
export const MEMORY_SALIENCE_THRESHOLD = 0.7;
// Same-kind write-time near-duplicate gate. Calibrated 2026-07-07 against the
// full pairwise same-kind distribution in dev: true rephrasings sit at
// 0.899–0.920, the closest legitimately distinct pairs top out at 0.886 —
// 0.895 splits that gap, erring high because a false block silently drops a
// memory while a missed duplicate is only retrievable noise. (The initial
// 0.95 sat above the all-time pairwise max and never fired.)
export const NEAR_DUPLICATE_SIMILARITY = 0.895;

export const SUPPRESSION_REASON_SESSION_REPEAT = "session_repeat";
export const SUPPRESSION_REASON_SIMILARITY_THRESHOLD =
  "similarity_threshold";
export const SUPPRESSION_REASON_CUE = "cue";
export const SUPPRESSION_REASON_LIMIT = "limit";
export const SUPPRESSION_REASON_TOKEN_BUDGET = "token_budget";

// Threshold-suppressed candidates are traced only when they land within this
// margin of their kind's similarity gate. Near-misses are the diagnostic
// signal; tracing every far-below candidate would grow memory_injections by
// ~20 rows per turn for no insight.
export const THRESHOLD_SUPPRESSION_TRACE_MARGIN = 0.05;

export function minSimilarityForKind(kind: string): number {
  return kind === "boundary_fact"
    ? BOUNDARY_MIN_MEMORY_SIMILARITY
    : MIN_MEMORY_SIMILARITY;
}

export function isMemorySalient(
  memory: Pick<RetrievedMemory, "pinned" | "importance" | "arousal">,
): boolean {
  return (
    memory.pinned ||
    memory.importance >= MEMORY_SALIENCE_THRESHOLD ||
    memory.arousal >= MEMORY_SALIENCE_THRESHOLD
  );
}

export function traceSimilarityGateForMemory(
  memory: Pick<RetrievedMemory, "kind" | "resolved">,
): number {
  if (memory.kind === "shared_moment") {
    return SHARED_MOMENT_STRONG_CUE;
  }
  if (memory.kind === "open_thread" && memory.resolved) {
    return STRONG_REPEAT_SIMILARITY;
  }
  return minSimilarityForKind(memory.kind);
}

export function memorySelectionSuppressionReason(
  memory: Pick<
    RetrievedMemory,
    "kind" | "resolved" | "similarity" | "pinned" | "importance" | "arousal"
  >,
): string | null {
  if (memory.kind === "boundary_fact") {
    return memory.similarity >= BOUNDARY_MIN_MEMORY_SIMILARITY
      ? null
      : SUPPRESSION_REASON_SIMILARITY_THRESHOLD;
  }

  if (memory.kind === "open_thread" && memory.resolved) {
    return memory.similarity >= STRONG_REPEAT_SIMILARITY
      ? null
      : SUPPRESSION_REASON_SIMILARITY_THRESHOLD;
  }

  if (memory.kind === "shared_moment") {
    if (memory.similarity < MIN_MEMORY_SIMILARITY) {
      return SUPPRESSION_REASON_SIMILARITY_THRESHOLD;
    }
    if (
      memory.similarity >= SHARED_MOMENT_STRONG_CUE ||
      isMemorySalient(memory)
    ) {
      return null;
    }
    return SUPPRESSION_REASON_CUE;
  }

  return memory.similarity >= MIN_MEMORY_SIMILARITY
    ? null
    : SUPPRESSION_REASON_SIMILARITY_THRESHOLD;
}

export function shouldTraceSelectionSuppression(
  memory: Pick<RetrievedMemory, "kind" | "resolved" | "similarity">,
): boolean {
  const gate = traceSimilarityGateForMemory(memory);
  return memory.similarity >= gate - THRESHOLD_SUPPRESSION_TRACE_MARGIN;
}

export type ScoredMemory = RetrievedMemory & {
  score: number;
};

export type MemoryInjectionSelectionDecision = {
  memory: ScoredMemory;
  injected: boolean;
  suppressionReason: string | null;
};

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

type DecayInputs = Pick<
  RetrievedMemory,
  "lastRecalledAt" | "createdAt" | "kind" | "pinned" | "resolved" | "arousal"
>;

// Durable kinds, pinned memories, and still-open threads do not fade.
function isDurable(memory: DecayInputs): boolean {
  return (
    memory.pinned ||
    memory.kind === "boundary_fact" ||
    (memory.kind === "open_thread" && !memory.resolved)
  );
}

export function recencyWeight(memory: DecayInputs, now = new Date()): number {
  if (isDurable(memory)) {
    return 1;
  }
  const reference = memory.lastRecalledAt ?? memory.createdAt;
  const ageDays = Math.max(
    0,
    (now.getTime() - reference.getTime()) / (24 * 60 * 60 * 1000),
  );
  // Arousal lengthens the half-life: intense memories fade more slowly.
  const halfLife = RECENCY_HALF_LIFE_DAYS * (1 + memory.arousal);
  return clamp(2 ** (-ageDays / halfLife));
}

export function scoreMemory(
  memory: RetrievedMemory,
  now = new Date(),
): number {
  // Resolved threads sink: still findable on a direct match, otherwise out of
  // the way.
  if (memory.kind === "open_thread" && memory.resolved) {
    return clamp(memory.similarity * 0.6) * 0.1;
  }
  const emotional =
    Math.abs(memory.valence) * 0.4 + memory.arousal * 0.6;
  return clamp(
    memory.similarity * 0.6 +
      memory.importance * 0.2 +
      emotional * 0.1 +
      recencyWeight(memory, now) * 0.1 +
      (memory.pinned ? 0.1 : 0),
  );
}

export function rerankMemories(
  memories: RetrievedMemory[],
  now = new Date(),
): ScoredMemory[] {
  return memories
    .map((memory) => ({ ...memory, score: scoreMemory(memory, now) }))
    .sort((left, right) => right.score - left.score);
}

export function memoryRepeatSuppressionReason(
  memory: Pick<ScoredMemory, "id" | "kind" | "similarity" | "pinned">,
  recentlyInjectedMemoryIds: Set<string>,
): string | null {
  if (!recentlyInjectedMemoryIds.has(memory.id)) {
    return null;
  }
  if (memory.kind === "boundary_fact") {
    return null;
  }
  if (memory.similarity >= STRONG_REPEAT_SIMILARITY) {
    return null;
  }
  if (memory.pinned && memory.similarity >= PINNED_REPEAT_SIMILARITY) {
    return null;
  }
  return SUPPRESSION_REASON_SESSION_REPEAT;
}

export function selectMemoryInjectionDecisions(
  memories: ScoredMemory[],
  tokenBudget: number,
  limit: number,
  recentlyInjectedMemoryIds = new Set<string>(),
): MemoryInjectionSelectionDecision[] {
  const selected: ScoredMemory[] = [];
  const decisions: MemoryInjectionSelectionDecision[] = [];

  for (const memory of memories) {
    const repeatReason = memoryRepeatSuppressionReason(
      memory,
      recentlyInjectedMemoryIds,
    );
    if (repeatReason) {
      decisions.push({
        memory,
        injected: false,
        suppressionReason: repeatReason,
      });
      continue;
    }

    if (selected.length >= limit) {
      decisions.push({
        memory,
        injected: false,
        suppressionReason: SUPPRESSION_REASON_LIMIT,
      });
      continue;
    }

    const candidateContents = [
      ...selected.map((item) => item.content),
      memory.content,
    ];
    const tokens = estimateTextTokens(formatAnchorContext(candidateContents));
    if (tokens > tokenBudget) {
      decisions.push({
        memory,
        injected: false,
        suppressionReason: SUPPRESSION_REASON_TOKEN_BUDGET,
      });
      continue;
    }

    selected.push(memory);
    decisions.push({
      memory,
      injected: true,
      suppressionReason: null,
    });
  }

  return decisions;
}
