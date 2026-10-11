import {
  and,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  ne,
  notInArray,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { getDatabase } from "./client";
import { listTracedMemoryIdsForSession } from "./memory-injections";
import { memories } from "./schema";

export type MemoryRecord = typeof memories.$inferSelect;
export type MemoryCandidate = {
  content: string;
  kind: string;
  embedding: number[];
  importance: number;
  valence: number;
  arousal: number;
  resolved: boolean;
  sourceSessionId: string | null;
  sourceMessageId: string | null;
  contentHash: string;
};

export type RetrievedMemory = MemoryRecord & {
  similarity: number;
};

export type MemoryChainLink = {
  id: string;
  content: string;
};

export type MemoryChainLinks = {
  supersededBy: MemoryChainLink | null;
  supersedes: MemoryChainLink[];
};

export type NearDuplicateMemory = {
  id: string;
  similarity: number;
};

export async function insertMemory(
  candidate: MemoryCandidate,
): Promise<MemoryRecord> {
  const [memory] = await getDatabase()
    .insert(memories)
    .values(candidate)
    .returning();
  return memory;
}

export async function retrieveByVector(
  query: number[],
  limit = 20,
  // SQL-side exclusion (MC-117B): rows this request already injected as
  // anchors must not consume ranking slots — a JS post-filter against the
  // internal 20-row cap could starve the requested limit while matching
  // rows exist below the cap.
  excludeIds: readonly string[] = [],
): Promise<RetrievedMemory[]> {
  const vector = JSON.stringify(query);
  const distance = sql<number>`${memories.embedding} <=> ${vector}::vector`;
  return getDatabase()
    .select({
      id: memories.id,
      content: memories.content,
      kind: memories.kind,
      embedding: memories.embedding,
      importance: memories.importance,
      valence: memories.valence,
      arousal: memories.arousal,
      resolved: memories.resolved,
      pinned: memories.pinned,
      supersededBy: memories.supersededBy,
      sourceSessionId: memories.sourceSessionId,
      sourceMessageId: memories.sourceMessageId,
      contentHash: memories.contentHash,
      recallCount: memories.recallCount,
      lastRecalledAt: memories.lastRecalledAt,
      createdAt: memories.createdAt,
      updatedAt: memories.updatedAt,
      deletedAt: memories.deletedAt,
      similarity: sql<number>`1 - (${distance})`,
    })
    .from(memories)
    .where(
      and(
        isNull(memories.deletedAt),
        isNull(memories.supersededBy),
        isNotNull(memories.embedding),
        ...(excludeIds.length > 0
          ? [notInArray(memories.id, [...excludeIds])]
          : []),
      ),
    )
    .orderBy(distance)
    .limit(Math.min(limit, 20));
}

// Structural query surface shared by the database handle and transactions, so
// the near-duplicate check can run inside the extraction transaction.
type MemorySelectExecutor = Pick<ReturnType<typeof getDatabase>, "select">;

export async function findNearestEmbeddedMemory(
  input: {
    kind: string;
    embedding: number[];
    excludeId?: string;
  },
  executor: MemorySelectExecutor = getDatabase(),
): Promise<NearDuplicateMemory | null> {
  const vector = JSON.stringify(input.embedding);
  const distance = sql<number>`${memories.embedding} <=> ${vector}::vector`;
  // Superseded rows are excluded on purpose: superseded means outdated, not
  // banned — content matching only a superseded row must be able to re-enter
  // (e.g. a fact that became true again).
  const [memory] = await executor
    .select({
      id: memories.id,
      similarity: sql<number>`1 - (${distance})`,
    })
    .from(memories)
    .where(
      and(
        eq(memories.kind, input.kind),
        isNull(memories.deletedAt),
        isNull(memories.supersededBy),
        isNotNull(memories.embedding),
        input.excludeId ? ne(memories.id, input.excludeId) : undefined,
      ),
    )
    .orderBy(distance)
    .limit(1);

  return memory ?? null;
}

// Walks the supersededBy chain from startId; true if targetId appears. Used to
// reject supersede edits that would close a cycle (a cycle hides every row in
// it from retrieval with no active replacement). Chains are owner-curated and
// short; past the bound we allow the edit rather than block on pathology.
export async function supersedeChainContains(input: {
  startId: string;
  targetId: string;
}): Promise<boolean> {
  let currentId: string | null = input.startId;
  for (let hop = 0; currentId && hop < 20; hop += 1) {
    if (currentId === input.targetId) {
      return true;
    }
    const [row] = await getDatabase()
      .select({ supersededBy: memories.supersededBy })
      .from(memories)
      .where(eq(memories.id, currentId))
      .limit(1);
    currentId = row?.supersededBy ?? null;
  }
  return false;
}

export async function deleteUnembeddedMemoryIfUnchanged(
  id: string,
  contentHash: string,
): Promise<boolean> {
  const deleted = await getDatabase()
    .delete(memories)
    .where(
      and(
        eq(memories.id, id),
        eq(memories.contentHash, contentHash),
        isNull(memories.embedding),
        isNull(memories.deletedAt),
      ),
    )
    .returning({ id: memories.id });

  return deleted.length > 0;
}

export async function listMemoryChainLinks(
  ids: string[],
): Promise<Map<string, MemoryChainLinks>> {
  const result = new Map<string, MemoryChainLinks>();
  for (const id of ids) {
    result.set(id, { supersededBy: null, supersedes: [] });
  }
  if (ids.length === 0) {
    return result;
  }

  const supersedingMemories = alias(memories, "superseding_memories");
  const supersededByRows = await getDatabase()
    .select({
      id: memories.id,
      supersededById: supersedingMemories.id,
      supersededByContent: supersedingMemories.content,
    })
    .from(memories)
    .leftJoin(
      supersedingMemories,
      eq(memories.supersededBy, supersedingMemories.id),
    )
    .where(inArray(memories.id, ids));

  for (const row of supersededByRows) {
    if (row.supersededById && row.supersededByContent) {
      result.set(row.id, {
        ...(result.get(row.id) ?? { supersededBy: null, supersedes: [] }),
        supersededBy: {
          id: row.supersededById,
          content: row.supersededByContent,
        },
      });
    }
  }

  const supersedesRows = await getDatabase()
    .select({
      id: memories.supersededBy,
      supersededId: memories.id,
      supersededContent: memories.content,
    })
    .from(memories)
    .where(
      and(
        inArray(memories.supersededBy, ids),
        isNull(memories.deletedAt),
      ),
    )
    .orderBy(desc(memories.updatedAt));

  for (const row of supersedesRows) {
    if (!row.id) {
      continue;
    }
    const current = result.get(row.id) ?? {
      supersededBy: null,
      supersedes: [],
    };
    current.supersedes.push({
      id: row.supersededId,
      content: row.supersededContent,
    });
    result.set(row.id, current);
  }

  return result;
}

export async function updateRecall(
  ids: string[],
  options: {
    now?: Date;
    sessionId?: string;
    messageId?: string;
  } = {},
): Promise<void> {
  if (ids.length === 0) {
    return;
  }

  const now = options.now ?? new Date();
  let updateIds = ids;
  if (options.sessionId) {
    const tracedMemoryIds = await listTracedMemoryIdsForSession({
      sessionId: options.sessionId,
      memoryIds: ids,
      excludeMessageId: options.messageId,
    });
    updateIds = ids.filter((id) => !tracedMemoryIds.has(id));
  }
  if (updateIds.length === 0) {
    return;
  }

  await getDatabase()
    .update(memories)
    .set({
      recallCount: sql`${memories.recallCount} + 1`,
      lastRecalledAt: now,
    })
    .where(
      and(
        inArray(memories.id, updateIds),
        isNull(memories.deletedAt),
      ),
    );
}

export async function searchActive(input: {
  query?: string;
  kind?: string;
  limit: number;
  offset: number;
}): Promise<MemoryRecord[]> {
  const query = input.query?.trim();
  return getDatabase()
    .select()
    .from(memories)
    .where(
      and(
        isNull(memories.deletedAt),
        query ? ilike(memories.content, `%${query}%`) : undefined,
        input.kind ? eq(memories.kind, input.kind) : undefined,
      ),
    )
    .orderBy(desc(memories.pinned), desc(memories.createdAt))
    .limit(input.limit)
    .offset(input.offset);
}

export async function countActive(
  query?: string,
  kind?: string,
): Promise<number> {
  const normalizedQuery = query?.trim();
  const [result] = await getDatabase()
    .select({ count: count() })
    .from(memories)
    .where(
      and(
        isNull(memories.deletedAt),
        normalizedQuery
          ? ilike(memories.content, `%${normalizedQuery}%`)
          : undefined,
        kind ? eq(memories.kind, kind) : undefined,
      ),
    );
  return result.count;
}

export async function searchDeleted(input: {
  query?: string;
  kind?: string;
  limit: number;
  offset: number;
}): Promise<MemoryRecord[]> {
  const query = input.query?.trim();
  return getDatabase()
    .select()
    .from(memories)
    .where(
      and(
        isNotNull(memories.deletedAt),
        query ? ilike(memories.content, `%${query}%`) : undefined,
        input.kind ? eq(memories.kind, input.kind) : undefined,
      ),
    )
    .orderBy(desc(memories.deletedAt))
    .limit(input.limit)
    .offset(input.offset);
}

export async function countDeleted(
  query?: string,
  kind?: string,
): Promise<number> {
  const normalizedQuery = query?.trim();
  const [result] = await getDatabase()
    .select({ count: count() })
    .from(memories)
    .where(
      and(
        isNotNull(memories.deletedAt),
        normalizedQuery
          ? ilike(memories.content, `%${normalizedQuery}%`)
          : undefined,
        kind ? eq(memories.kind, kind) : undefined,
      ),
    );
  return result.count;
}

export async function updateMemory(
  id: string,
  input: Partial<
    Pick<
      MemoryRecord,
      | "content"
      | "kind"
      | "importance"
      | "valence"
      | "arousal"
      | "resolved"
      | "pinned"
      | "supersededBy"
    >
  > & { contentHash?: string; clearEmbedding?: boolean },
): Promise<MemoryRecord | null> {
  const { clearEmbedding, ...changes } = input;
  const [memory] = await getDatabase()
    .update(memories)
    .set({
      ...changes,
      ...(clearEmbedding ? { embedding: null } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(memories.id, id),
        isNull(memories.deletedAt),
      ),
    )
    .returning();

  return memory ?? null;
}

export async function updateMemoryEmbedding(
  id: string,
  embedding: number[],
  expectedContentHash?: string,
): Promise<boolean> {
  const updated = await getDatabase()
    .update(memories)
    .set({ embedding, updatedAt: new Date() })
    .where(
      and(
        eq(memories.id, id),
        isNull(memories.deletedAt),
        expectedContentHash
          ? eq(memories.contentHash, expectedContentHash)
          : undefined,
      ),
    )
    .returning({ id: memories.id });
  return updated.length > 0;
}

export async function softDeleteMemory(id: string): Promise<boolean> {
  const deleted = await getDatabase()
    .update(memories)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(memories.id, id),
        isNull(memories.deletedAt),
      ),
    )
    .returning({ id: memories.id });
  return deleted.length > 0;
}

export async function restoreMemory(id: string): Promise<boolean> {
  const restored = await getDatabase()
    .update(memories)
    .set({ deletedAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(memories.id, id),
        isNotNull(memories.deletedAt),
      ),
    )
    .returning({ id: memories.id });
  return restored.length > 0;
}

export async function permanentlyDeleteMemory(id: string): Promise<boolean> {
  const deleted = await getDatabase()
    .delete(memories)
    .where(
      and(
        eq(memories.id, id),
        isNotNull(memories.deletedAt),
      ),
    )
    .returning({ id: memories.id });
  return deleted.length > 0;
}
