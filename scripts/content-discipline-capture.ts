import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadEnvConfig } from "@next/env";
import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
} from "drizzle-orm";

import { closeDatabase, getDatabase } from "../src/server/db/client";
import { messageRoleOrderSql } from "../src/server/db/message-cursor";
import {
  diaryEntries,
  memories,
  memoryExtractionBackfillWindows,
  messages,
  relationshipNarrativeVersions,
  sessions,
  settings,
} from "../src/server/db/schema";
import { diaryMaterialCondition } from "../src/server/db/diary";
import type {
  DiaryFixtureSources,
  ExtractionCandidateFile,
  ExtractionFixtureSources,
  NarrativeFixtureSources,
} from "../src/server/evals/content-discipline";
import { parseDiaryFixtureContamination } from "../src/server/evals/content-discipline";
import { pairExchanges } from "../src/server/memory/extract";
import {
  loadIncrementalNarrativeSourcesForReplay,
} from "../src/server/summaries/consolidate-narrative";
import {
  addDiaryDays,
  buildDiaryEntryDryRun,
  diaryDayWindow,
} from "../src/server/summaries/diary";

loadEnvConfig(process.cwd());

async function writeNew(filePath: string, content: string): Promise<void> {
  await writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
}

async function captureDiary(
  date: string,
  contamination: DiaryFixtureSources["contamination"],
  outputDir: string,
  baselineOverride?: { content: string; provenance: string },
): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
    throw new Error("Diary fixture date must be YYYY-MM-DD.");
  }
  const plan = await buildDiaryEntryDryRun(date);
  // A no-material day short-circuits before the baseline loads, so a fixture
  // written here would pin baseline "none" as if it were a DB fact — and
  // fixtures are write-once. Fail loudly like the live writer skips loudly.
  if (plan.wouldSkipNoMaterial) {
    throw new Error(
      `No diary material for ${date}; refusing to write an empty fixture.`,
    );
  }
  const nextWindow = diaryDayWindow(addDiaryDays(date, 1));
  const [sourceSessions, [nextUser]] = await Promise.all([
    getDatabase()
      .selectDistinct({ sessionId: messages.sessionId })
      .from(messages)
      .where(diaryMaterialCondition(plan.window))
      .orderBy(asc(messages.sessionId)),
    getDatabase()
    .select({
      role: messages.role,
      content: messages.content,
      completedAt: messages.completedAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.status, "complete"),
        eq(messages.role, "user"),
        isNotNull(messages.completedAt),
        gte(messages.completedAt, nextWindow.start),
        lt(messages.completedAt, nextWindow.end),
      ),
    )
    .orderBy(asc(messages.createdAt), asc(messages.id))
    .limit(1),
  ]);
  const [stored] = await getDatabase()
    .select({ content: diaryEntries.content })
    .from(diaryEntries)
    .where(eq(diaryEntries.entryDate, date))
    .limit(1);
  const sources: DiaryFixtureSources = {
    schemaVersion: 1,
    kind: "diary",
    id: `diary-${date}`,
    date,
    capturedAt: new Date().toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    contamination,
    sourceSessionIds: sourceSessions.map((row) => row.sessionId),
    baseline: {
      asOf: plan.window.start.toISOString(),
      source: baselineOverride ? "version" : plan.baselineSource,
      content: baselineOverride?.content ?? plan.baseline,
      ...(baselineOverride
        ? { provenance: baselineOverride.provenance }
        : {}),
    },
    turns: plan.turns.map((turn) => ({
      ...turn,
      completedAt: turn.completedAt.toISOString(),
    })),
    nextDayProbe:
      nextUser?.completedAt === null || nextUser === undefined
        ? null
        : {
            windowStart: nextWindow.start.toISOString(),
            userTurn: {
              role: nextUser.role,
              content: nextUser.content,
              completedAt: nextUser.completedAt.toISOString(),
            },
          },
  };
  await mkdir(outputDir, { recursive: true });
  await writeNew(
    path.join(outputDir, "sources.json"),
    `${JSON.stringify(sources, null, 2)}\n`,
  );
  if (stored) {
    await writeNew(path.join(outputDir, "stored.md"), `${stored.content}\n`);
  }
  console.log(`Captured diary fixture ${date}: ${outputDir}`);
  console.log(
    `turns=${sources.turns.length} baseline=${sources.baseline.source} probe=${sources.nextDayProbe ? "yes" : "no"} stored=${stored ? "yes" : "no"}`,
  );
}

async function captureNarrative(
  priorVersion: number,
  candidateVersion: number,
  watermark: Date,
  sourceThrough: Date,
  outputDir: string,
): Promise<void> {
  const versions = await getDatabase()
    .select({
      version: relationshipNarrativeVersions.version,
      content: relationshipNarrativeVersions.content,
    })
    .from(relationshipNarrativeVersions)
    .where(
      // Two point reads would be clearer than broad historical inference;
      // filtering in memory keeps this capture helper independent of OR SQL.
      gte(relationshipNarrativeVersions.version, priorVersion),
    );
  const prior = versions.find((row) => row.version === priorVersion);
  const candidate = versions.find((row) => row.version === candidateVersion);
  if (!prior || !candidate) {
    throw new Error("Requested narrative versions are not retained.");
  }
  const [configuration] = await getDatabase()
    .select({
      narrativeTargetTokens: settings.narrativeTargetTokens,
      summaryTriggerTokens: settings.summaryTriggerTokens,
    })
    .from(settings)
    .where(eq(settings.id, 1))
    .limit(1);
  if (!configuration) {
    throw new Error("Settings row is missing.");
  }
  const selected = await loadIncrementalNarrativeSourcesForReplay({
    watermark,
    sourceThrough,
    rawBudget: configuration.summaryTriggerTokens,
  });
  if (selected.rawTailDropped.length > 0) {
    // The fixture freezes an incomplete source window; say so where the
    // capture is read, not only in the job log.
    console.warn(
      `capture: the raw-tail cap dropped ${selected.rawTailDropped
        .map(
          (drop) =>
            `${drop.turns} turns / ${drop.tokens ?? "uncounted"} tokens (${drop.sessionId ?? "whole tail"})`,
        )
        .join(", ")}; the fixture's sources are not the whole window.`,
    );
  }
  // The target the live prompt stated (MC-121); replay derives the cap.
  const tokenBudget = configuration.narrativeTargetTokens;
  const sources: NarrativeFixtureSources = {
    schemaVersion: 1,
    kind: "narrative",
    id: `narrative-v${priorVersion}-to-v${candidateVersion}`,
    capturedAt: new Date().toISOString(),
    mode: "incremental",
    watermark: watermark.toISOString(),
    sourceThrough: sourceThrough.toISOString(),
    watermarkProvenance:
      "Recovered from the prior consolidation job creation time; no messages or memory updates occur in the sub-minute gap before its exact sourceThrough.",
    tokenBudget,
    maxOutputTokens: tokenBudget * 2,
    currentRecord: prior.content,
    sources: {
      summaries: selected.summaries.map((row) => ({
        ...row,
        cursorCompletedAt: row.cursorCompletedAt.toISOString(),
      })),
      rawTail: selected.rawTail.map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
        completedAt: row.completedAt.toISOString(),
      })),
      memories: selected.memories.map((row) => ({
        ...row,
        updatedAt: row.updatedAt.toISOString(),
      })),
    },
  };
  await mkdir(outputDir, { recursive: true });
  await writeNew(
    path.join(outputDir, "sources.json"),
    `${JSON.stringify(sources, null, 2)}\n`,
  );
  await writeNew(path.join(outputDir, "stored.md"), `${candidate.content}\n`);
  console.log(
    `Captured narrative fixture v${priorVersion} → v${candidateVersion}: ${outputDir}`,
  );
  console.log(
    `summaries=${sources.sources.summaries.length} rawTail=${sources.sources.rawTail.length} memories=${sources.sources.memories.length}`,
  );
}

// MC-119: one session, paired exactly as the live extraction job pairs it,
// with the windows production actually cut (the repair audit rows, when the
// session has them) and the rows production wrote as the frozen candidate.
async function captureExtraction(
  sessionId: string,
  outputDir: string,
): Promise<void> {
  const database = getDatabase();
  const [session] = await database
    .select({ id: sessions.id, title: sessions.title })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!session) {
    throw new Error(`Session ${sessionId} does not exist.`);
  }
  const rows = await database
    .select({
      id: messages.id,
      role: messages.role,
      content: messages.content,
      usedWebSearch: messages.usedWebSearch,
      createdAt: messages.createdAt,
      completedAt: messages.completedAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, session.id),
        eq(messages.status, "complete"),
        inArray(messages.role, ["user", "assistant"]),
      ),
    )
    .orderBy(asc(messages.createdAt), messageRoleOrderSql(), asc(messages.id));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const exchanges = pairExchanges(rows).map((exchange) => {
    const user = byId.get(exchange.userMessageId)!;
    const assistant = byId.get(exchange.assistantMessageId)!;
    return {
      ...exchange,
      userCreatedAt: user.createdAt.toISOString(),
      assistantCompletedAt: (
        assistant.completedAt ?? assistant.createdAt
      ).toISOString(),
    };
  });
  if (exchanges.length === 0) {
    throw new Error("The session has no extractable exchanges.");
  }
  const windows = await database
    .select({
      segment: memoryExtractionBackfillWindows.segment,
      throughMessageId: memoryExtractionBackfillWindows.throughMessageId,
      exchangeCount: memoryExtractionBackfillWindows.exchangeCount,
      candidateCount: memoryExtractionBackfillWindows.candidateCount,
      writtenCount: memoryExtractionBackfillWindows.writtenCount,
    })
    .from(memoryExtractionBackfillWindows)
    .where(
      and(
        eq(memoryExtractionBackfillWindows.sessionId, session.id),
        eq(memoryExtractionBackfillWindows.status, "complete"),
      ),
    )
    .orderBy(asc(memoryExtractionBackfillWindows.segment));
  const stored = await database
    .select({
      content: memories.content,
      kind: memories.kind,
      importance: memories.importance,
    })
    .from(memories)
    .where(
      and(
        eq(memories.sourceSessionId, session.id),
        isNull(memories.deletedAt),
      ),
    )
    .orderBy(asc(memories.createdAt));
  const sources: ExtractionFixtureSources = {
    schemaVersion: 1,
    kind: "extraction",
    id: `extraction-${path.basename(outputDir)}`,
    sessionId: session.id,
    sessionTitle: session.title,
    capturedAt: new Date().toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    exchanges,
    productionWindows: windows.length > 0 ? windows : null,
  };
  const candidate: ExtractionCandidateFile = {
    schemaVersion: 1,
    candidates: stored,
  };
  await mkdir(outputDir, { recursive: true });
  await writeNew(
    path.join(outputDir, "sources.json"),
    `${JSON.stringify(sources, null, 2)}\n`,
  );
  await writeNew(
    path.join(outputDir, "stored.json"),
    `${JSON.stringify(candidate, null, 2)}\n`,
  );
  console.log(`Captured extraction fixture ${session.id}: ${outputDir}`);
  console.log(
    `exchanges=${exchanges.length} productionWindows=${
      windows.map((window) => window.exchangeCount).join("/") || "none"
    } stored=${stored.length}`,
  );
}

async function main(): Promise<void> {
  const [kind, ...args] = process.argv.slice(2);
  if (kind === "extraction" && args.length === 2) {
    await captureExtraction(args[0], path.resolve(args[1]));
    return;
  }
  if (
    kind === "diary" &&
    (args.length === 3 ||
      (args.length === 5 && args[3] === "--baseline-fixture"))
  ) {
    const baselinePath = args[4];
    await captureDiary(
      args[0],
      parseDiaryFixtureContamination(args[1]),
      path.resolve(args[2]),
      baselinePath
        ? {
            content: (await readFile(path.resolve(baselinePath), "utf8")).trim(),
            provenance: `Pinned from repository fixture ${baselinePath}; the historical version row was pruned before capture.`,
          }
        : undefined,
    );
    return;
  }
  if (kind === "narrative" && args.length === 5) {
    const priorVersion = Number(args[0]);
    const candidateVersion = Number(args[1]);
    const watermark = new Date(args[2]);
    const sourceThrough = new Date(args[3]);
    if (
      !Number.isInteger(priorVersion) ||
      !Number.isInteger(candidateVersion) ||
      Number.isNaN(watermark.getTime()) ||
      Number.isNaN(sourceThrough.getTime())
    ) {
      throw new Error("Invalid narrative capture arguments.");
    }
    await captureNarrative(
      priorVersion,
      candidateVersion,
      watermark,
      sourceThrough,
      path.resolve(args[4]),
    );
    return;
  }
  throw new Error(
    [
      "Usage:",
      "  npm run eval:content:capture -- diary YYYY-MM-DD held-out|prompt-example output-dir [--baseline-fixture path]",
      "  npm run eval:content:capture -- narrative PRIOR_VERSION CANDIDATE_VERSION WATERMARK SOURCE_THROUGH output-dir",
      "  npm run eval:content:capture -- extraction SESSION_ID output-dir",
    ].join("\n"),
  );
}

main()
  .catch((error: unknown) => {
    console.error("Content-discipline fixture capture failed.", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabase();
  });
