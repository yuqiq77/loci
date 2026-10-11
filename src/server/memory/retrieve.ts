import {
  retrieveByVector,
} from "@/server/db/memories";
import {
  insertMemoryInjectionTraces,
  listRecentlyInjectedMemoryIds,
} from "@/server/db/memory-injections";

import { getEmbeddingProvider } from "./embedding";
import {
  memorySelectionSuppressionReason,
  rerankMemories,
  selectMemoryInjectionDecisions,
  shouldTraceSelectionSuppression,
  type ScoredMemory,
} from "./score";

export const SHORT_QUERY_CHARACTER_THRESHOLD = 12;
export const SUMMARY_HEAD_CHARACTER_LIMIT = 500;

function characterCount(text: string): number {
  return Array.from(text.trim()).length;
}

function head(text: string, maxCharacters: number): string {
  return Array.from(text.trim()).slice(0, maxCharacters).join("");
}

export function buildRetrievalQuery(input: {
  query: string;
  previousUserMessage?: string | null;
  sessionSummary?: string | null;
}): string {
  const query = input.query.trim();
  if (characterCount(query) >= SHORT_QUERY_CHARACTER_THRESHOLD) {
    return query;
  }

  const context =
    input.previousUserMessage?.trim() ||
    (input.sessionSummary
      ? head(input.sessionSummary, SUMMARY_HEAD_CHARACTER_LIMIT)
      : "");
  return context ? `${context}\n${query}` : query;
}

export async function retrieveMemories(input: {
  query: string;
  tokenBudget: number;
  limit: number;
  now?: Date;
  sessionId?: string;
  messageId?: string;
  summaryThroughMessageId?: string | null;
  previousUserMessage?: string | null;
  sessionSummary?: string | null;
}): Promise<ScoredMemory[]> {
  if (input.tokenBudget <= 0 || input.limit <= 0) {
    return [];
  }

  const provider = getEmbeddingProvider();
  if (!provider) {
    return [];
  }

  const [queryVector] = await provider.embed([
    buildRetrievalQuery({
      query: input.query,
      previousUserMessage: input.previousUserMessage,
      sessionSummary: input.sessionSummary,
    }),
  ]);
  const ranked = rerankMemories(
    await retrieveByVector(queryVector, 20),
    input.now,
  );
  const gateSuppressed = ranked.flatMap((memory) => {
    const suppressionReason = memorySelectionSuppressionReason(memory);
    if (!suppressionReason || !shouldTraceSelectionSuppression(memory)) {
      return [];
    }
    return [
      {
        memory,
        injected: false,
        suppressionReason,
      },
    ];
  });
  const candidates = ranked.filter(
    (memory) => !memorySelectionSuppressionReason(memory),
  );
  let recentlyInjectedMemoryIds = new Set<string>();
  if (input.sessionId && input.messageId) {
    try {
      recentlyInjectedMemoryIds = await listRecentlyInjectedMemoryIds({
        sessionId: input.sessionId,
        currentMessageId: input.messageId,
        summaryThroughMessageId: input.summaryThroughMessageId ?? null,
      });
    } catch (error) {
      console.error(
        "Memory injection suppression lookup failed.",
        error instanceof Error ? error.name : "UnknownError",
      );
    }
  }

  const decisions = [
    ...selectMemoryInjectionDecisions(
      candidates,
      input.tokenBudget,
      input.limit,
      recentlyInjectedMemoryIds,
    ),
    ...gateSuppressed,
  ];

  if (input.sessionId && input.messageId) {
    try {
      await insertMemoryInjectionTraces(
        decisions.map((decision) => ({
          sessionId: input.sessionId!,
          messageId: input.messageId!,
          memoryId: decision.memory.id,
          kind: decision.memory.kind,
          similarity: decision.memory.similarity,
          score: decision.memory.score,
          injected: decision.injected,
          suppressionReason: decision.suppressionReason,
        })),
      );
    } catch (error) {
      console.error(
        "Memory injection trace write failed.",
        error instanceof Error ? error.name : "UnknownError",
      );
    }
  }

  return decisions
    .filter((decision) => decision.injected)
    .map((decision) => decision.memory);
}
