import { and, desc, eq, inArray, isNull, lt, lte, sql } from "drizzle-orm";

import { getDatabase } from "./client";
import {
  memories,
  relationshipNarrative,
  relationshipNarrativeVersions,
} from "./schema";

export type NarrativeMode = "incremental" | "rebuild" | "manual";

export type RelationshipNarrative = {
  content: string;
  version: number;
  updatedAt: Date;
  consolidatedThrough: Date;
};

// Most recent versions retained in the side table (spec §2.2): drift is the
// top risk and version history is cheap insurance. Count alone is not the
// whole rule — see the time floor in writeNarrativeVersion.
export const NARRATIVE_VERSION_RETENTION = 7;

// As-of horizon the version table must stay answerable for. The diary
// journals up to DIARY_BACKLOG_DAYS (3) closed days back, so the oldest
// window.start a tick can ask about is just under 4 days ago (3 backlog
// days plus the open day's 04:00 offset), plus a possible DST hour; 5
// rounds up with margin. Deliberately a local constant rather than an
// import: summaries/diary.ts imports this module, so importing the diary's
// constant here would be a cycle — the relation is asserted in
// tests/unit/diary.test.ts instead (unit, so it runs on every plain
// `vitest run`, not only under TEST_DATABASE_URL).
export const NARRATIVE_AS_OF_RETENTION_DAYS = 5;

export class NarrativeVersionConflictError extends Error {
  constructor() {
    super("Narrative version changed while consolidation was running.");
  }
}

export async function getRelationshipNarrative(): Promise<RelationshipNarrative | null> {
  const [row] = await getDatabase()
    .select({
      content: relationshipNarrative.content,
      version: relationshipNarrative.version,
      updatedAt: relationshipNarrative.updatedAt,
      consolidatedThrough: relationshipNarrative.consolidatedThrough,
    })
    .from(relationshipNarrative)
    .where(eq(relationshipNarrative.id, 1))
    .limit(1);

  return row ?? null;
}

// Capsule source selection (read order on the chat path) and the D11 seed
// rule, in one place: before any version has been written (version 0, the
// migration seed row) the retained standing-context field is authoritative;
// once a version exists the narrative is — including a deliberately blanked
// one, so the owner can clear the always-on context and an empty save does
// not silently resurrect the old seed.
export function effectiveStandingContext(
  narrative: { content: string; version: number } | null,
  standingContext: string,
): string {
  if (!narrative || narrative.version === 0) {
    return standingContext;
  }
  return narrative.content.trim();
}

// The narrative as it stood at a given instant — the newest version written
// strictly before it. The diary's calibration baseline reads this: the entry
// for day D measures the day against who the two were when D began, never
// against a same-day consolidation that already narrates D (feeding that
// version would invite the diary to paraphrase the narrative instead of the
// day's own turns). Null when no version predates the instant (fresh
// install); callers omit their baseline block, and diary_entry_written logs
// baselineSource: "none" as the tripwire. Answerability inside the as-of
// horizon is a retention guarantee, not luck: count-based pruning alone
// would let a burst of manual /profile saves evict the day-start version —
// see the time floor and anchor rule in writeNarrativeVersion (owner review
// 2026-07-17). Ordered by createdAt (version as tiebreak) to match the
// filter: keying the order on version would silently assume version order
// equals time order, which a backwards clock step between writes breaks.
export async function getNarrativeContentAsOf(
  instant: Date,
): Promise<string | null> {
  const [row] = await getDatabase()
    .select({ content: relationshipNarrativeVersions.content })
    .from(relationshipNarrativeVersions)
    .where(lt(relationshipNarrativeVersions.createdAt, instant))
    .orderBy(
      desc(relationshipNarrativeVersions.createdAt),
      desc(relationshipNarrativeVersions.version),
    )
    .limit(1);
  return row?.content ?? null;
}

// An incremental run that found nothing to fold in still consumes its source
// window: without this the tick predicate ("completed material exists past
// the watermark") stays true forever when the only new material was filtered
// out (D18 web-search turns), and a no-op job is re-enqueued every tick.
export async function advanceConsolidationWatermark(
  consolidatedThrough: Date,
): Promise<void> {
  await getDatabase()
    .update(relationshipNarrative)
    .set({ consolidatedThrough })
    .where(eq(relationshipNarrative.id, 1));
}

// Writes the new current narrative and its version row, prunes retention, and
// folds in consolidation side effects — watermark advance and open-thread
// resolution flips — in one transaction, so a failed write leaves narrative,
// watermark, and threads untouched together.
export async function writeNarrativeVersion(input: {
  content: string;
  mode: NarrativeMode;
  // Advances the source watermark; consolidation runs pass their job-start
  // sourceThrough. Manual edits omit it, so the watermark never moves and
  // material between an auto run and a manual edit is never skipped.
  consolidatedThrough?: Date;
  // Optimistic guard for job writes: the version read at job start. A manual
  // edit landing during the model call fails the job (retry re-reads) instead
  // of being silently rewritten away.
  expectedVersion?: number;
  resolvedThreadIds?: string[];
  // Carrier provenance (MC-115 E), recorded at generation time; manual
  // edits omit it and the columns stay null.
  provenance?: { provider: string; model: string; host: string };
}): Promise<RelationshipNarrative> {
  const now = new Date();

  return getDatabase().transaction(async (tx) => {
    const [current] = await tx
      .update(relationshipNarrative)
      .set({
        content: input.content,
        version: sql`${relationshipNarrative.version} + 1`,
        updatedAt: now,
        ...(input.consolidatedThrough
          ? { consolidatedThrough: input.consolidatedThrough }
          : {}),
      })
      .where(
        and(
          eq(relationshipNarrative.id, 1),
          input.expectedVersion === undefined
            ? undefined
            : eq(relationshipNarrative.version, input.expectedVersion),
        ),
      )
      .returning({
        content: relationshipNarrative.content,
        version: relationshipNarrative.version,
        updatedAt: relationshipNarrative.updatedAt,
        consolidatedThrough: relationshipNarrative.consolidatedThrough,
      });
    if (!current) {
      throw new NarrativeVersionConflictError();
    }

    await tx.insert(relationshipNarrativeVersions).values({
      content: input.content,
      version: current.version,
      mode: input.mode,
      ...(input.provenance ?? {}),
      createdAt: now,
    });
    // Retention: newest 7 by count, with a time floor (owner review
    // 2026-07-17 — count alone cannot promise as-of coverage: a burst of
    // manual /profile saves would evict the day-start version and the
    // diary's baseline would silently degrade to null). A version is pruned
    // only when it is (a) beyond the count window, (b) older than the as-of
    // horizon, and (c) older by version than the anchor — the pre-cutoff
    // row the as-of reader itself would resolve to (newest by createdAt,
    // version tiebreak, so a clock step cannot make pruner and reader
    // disagree). Bursts can transiently hold more than 7 rows; they
    // re-prune on the next write once they age past the horizon (a terminal
    // burst with no later write persists — accepted, rows are small). When
    // nothing predates the cutoff the anchor subquery is NULL and the
    // comparison prunes nothing (young store). The horizon bounds instants
    // asked about at normal execution time; a job surviving multi-day
    // downtime (or a manual backfill) can still ask outside it and gets
    // the baselineSource: "none" degraded mode.
    const asOfCutoff = new Date(
      now.getTime() - NARRATIVE_AS_OF_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    const anchor = tx
      .select({ version: relationshipNarrativeVersions.version })
      .from(relationshipNarrativeVersions)
      .where(lt(relationshipNarrativeVersions.createdAt, asOfCutoff))
      .orderBy(
        desc(relationshipNarrativeVersions.createdAt),
        desc(relationshipNarrativeVersions.version),
      )
      .limit(1);
    await tx
      .delete(relationshipNarrativeVersions)
      .where(
        and(
          lte(
            relationshipNarrativeVersions.version,
            current.version - NARRATIVE_VERSION_RETENTION,
          ),
          lt(relationshipNarrativeVersions.createdAt, asOfCutoff),
          sql`${relationshipNarrativeVersions.version} < ${anchor}`,
        ),
      );

    if (input.resolvedThreadIds && input.resolvedThreadIds.length > 0) {
      // Stamped with the job-start sourceThrough, not commit time: a flip
      // stamped after the watermark would re-enter the next incremental run's
      // "updated since watermark" sources forever.
      await tx
        .update(memories)
        .set({ resolved: true, updatedAt: input.consolidatedThrough ?? now })
        .where(
          and(
            inArray(memories.id, input.resolvedThreadIds),
            eq(memories.kind, "open_thread"),
            eq(memories.resolved, false),
            isNull(memories.deletedAt),
          ),
        );
    }

    return current;
  });
}
