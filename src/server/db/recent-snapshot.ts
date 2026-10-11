import { eq } from "drizzle-orm";

import { getDatabase } from "./client";
import { recentContinuitySnapshot } from "./schema";

export type RecentSnapshot = {
  content: string;
  version: number;
  asOf: Date;
  stale: boolean;
};

type SnapshotRowInput = {
  content: string;
  version: number;
  updatedAt: Date;
  sourceWindowEnd: Date | null;
  staleAfter: Date | null;
};

// Missing and empty rows still read as null; staleness no longer gates — the
// snapshot renders dated at every age and the first rebuild after a return
// replaces it (MC-113). `stale` is computed for observability only (capsule
// trace); nothing behavioral may branch on it.
export function datedRecentSnapshot(
  row: SnapshotRowInput | null | undefined,
  now = new Date(),
): RecentSnapshot | null {
  const content = row?.content.trim();
  if (!row || !content) {
    return null;
  }
  return {
    content,
    version: row.version,
    // The window end is what the content is "as of"; updated_at is merely
    // when the job ran. Legacy rows without a window fall back to it.
    asOf: row.sourceWindowEnd ?? row.updatedAt,
    stale: Boolean(row.staleAfter && row.staleAfter.getTime() < now.getTime()),
  };
}

export async function getRecentSnapshot(
  now = new Date(),
): Promise<RecentSnapshot | null> {
  const [row] = await getDatabase()
    .select({
      content: recentContinuitySnapshot.content,
      version: recentContinuitySnapshot.version,
      updatedAt: recentContinuitySnapshot.updatedAt,
      sourceWindowEnd: recentContinuitySnapshot.sourceWindowEnd,
      staleAfter: recentContinuitySnapshot.staleAfter,
    })
    .from(recentContinuitySnapshot)
    .where(eq(recentContinuitySnapshot.id, 1))
    .limit(1);

  return datedRecentSnapshot(row, now);
}
