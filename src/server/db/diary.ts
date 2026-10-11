import { and, desc, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";

import { getDatabase } from "./client";
import { diaryEntries, diaryState, messages } from "./schema";

export type DiaryEntry = {
  id: string;
  entryDate: string;
  content: string;
  createdAt: Date;
};

// The diary epoch: when migration 0012 ran on this database. Null only on an
// unmigrated database — callers treat that as "no journalable days".
export async function getDiaryEpoch(): Promise<Date | null> {
  const [row] = await getDatabase()
    .select({ epoch: diaryState.epoch })
    .from(diaryState)
    .where(eq(diaryState.id, 1))
    .limit(1);
  return row?.epoch ?? null;
}

export async function journaledDiaryDays(
  dates: string[],
): Promise<Set<string>> {
  if (dates.length === 0) {
    return new Set();
  }
  const rows = await getDatabase()
    .select({ entryDate: diaryEntries.entryDate })
    .from(diaryEntries)
    .where(inArray(diaryEntries.entryDate, dates));
  return new Set(rows.map((row) => row.entryDate));
}

// The diary's source filter (D18: web-search assistant turns never enter the
// diary; the user's own turns stay), shared by the tick's material probe
// below and the job's turn loader (summaries/diary.ts). One definition on
// purpose: the tick must only enqueue days the job would actually write — a
// drifted copy would either re-enqueue a no-op day every tick or silently
// skip journalable ones, and the diary has no watermark to consume the
// window with.
export function diaryMaterialCondition(window: { start: Date; end: Date }) {
  return and(
    eq(messages.status, "complete"),
    inArray(messages.role, ["user", "assistant"]),
    isNotNull(messages.completedAt),
    gte(messages.completedAt, window.start),
    lt(messages.completedAt, window.end),
    sql`not (${messages.role} = 'assistant' and ${messages.usedWebSearch})`,
  );
}

export async function diaryWindowHasMaterial(window: {
  start: Date;
  end: Date;
}): Promise<boolean> {
  const [row] = await getDatabase()
    .select({ id: messages.id })
    .from(messages)
    .where(diaryMaterialCondition(window))
    .limit(1);
  return row !== undefined;
}

// Append-only write: on conflict the existing entry wins — a concurrent
// duplicate job (stale-lease recovery) must never overwrite a written day.
// Returns false when the row already existed.
export async function insertDiaryEntry(input: {
  entryDate: string;
  content: string;
  // Carrier provenance (MC-115 E), recorded at generation time; manual
  // backfills may omit it.
  provenance?: { provider: string; model: string; host: string };
}): Promise<boolean> {
  const inserted = await getDatabase()
    .insert(diaryEntries)
    .values({
      entryDate: input.entryDate,
      content: input.content,
      ...(input.provenance ?? {}),
    })
    .onConflictDoNothing({ target: diaryEntries.entryDate })
    .returning({ id: diaryEntries.id });
  return inserted.length > 0;
}

const entryMonth = sql<string>`to_char(${diaryEntries.entryDate}, 'YYYY-MM')`;

export async function listDiaryEntries(input: {
  limit: number;
  offset: number;
  month?: string;
}): Promise<DiaryEntry[]> {
  return getDatabase()
    .select({
      id: diaryEntries.id,
      entryDate: diaryEntries.entryDate,
      content: diaryEntries.content,
      createdAt: diaryEntries.createdAt,
    })
    .from(diaryEntries)
    .where(input.month ? eq(entryMonth, input.month) : undefined)
    .orderBy(desc(diaryEntries.entryDate))
    .limit(input.limit)
    .offset(input.offset);
}

// The months that hold entries, newest first. One entry per day, so a
// month's count is at most 31.
export async function listDiaryMonths(): Promise<
  { month: string; count: number }[]
> {
  return getDatabase()
    .select({ month: entryMonth, count: sql<number>`count(*)::int` })
    .from(diaryEntries)
    .groupBy(entryMonth)
    .orderBy(desc(entryMonth));
}

export async function countDiaryEntries(): Promise<number> {
  const [row] = await getDatabase()
    .select({ count: sql<number>`count(*)::int` })
    .from(diaryEntries);
  return row.count;
}
