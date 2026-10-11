import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  advisoryCheckIds,
  buildMinimalDiaryPrompt,
  type DiaryFixtureLabels,
  type DiaryFixtureSources,
  DIARY_REPLAY_SYSTEM_FRAME_V1,
  diaryReplayMaxOutputTokens,
  type ExtractionCandidateFile,
  type ExtractionFixtureLabels,
  type ExtractionFixtureSources,
  extractionReplayWindows,
  findSkeletonSeries,
  hardFailedCheckIds,
  type NarrativeFixtureLabels,
  type NarrativeFixtureSources,
  narrativeReplayMaxOutputTokens,
  parseCenterJudgeResult,
  parseDifferentialJudgeResult,
  parseDiaryFixtureContamination,
  parseExtractionGeometry,
  parseFactualityJudgeResult,
  renderPromptTemplate,
  requireDiaryNextDayProbe,
  runDiaryMechanicalChecks,
  runExtractionChecks,
  runNarrativeMechanicalChecks,
  toPreRecentCarryPrompt,
  toPreRecentCarryShortenPrompt,
} from "@/server/evals/content-discipline";
import {
  buildConsolidationPrompt,
  buildShortenRetryPrompt,
} from "@/server/summaries/consolidate-narrative";
import { buildDiaryPrompt, diaryDayWindow } from "@/server/summaries/diary";

const evalRoot = path.join(process.cwd(), "evals", "content-discipline");
const root = path.join(evalRoot, "fixtures");

function text(...parts: string[]): string {
  return readFileSync(path.join(root, ...parts), "utf8");
}

function json<T>(...parts: string[]): T {
  return JSON.parse(text(...parts)) as T;
}

const failed = hardFailedCheckIds;
const advisories = advisoryCheckIds;

// The manifest is the only place a fixture is named. Every case carries the
// frozen mechanical expectations the runner compares against; the optional
// shape pins let a case freeze what its sources look like (probe present,
// how many sessions, how many turns) without the test naming a day or a
// session. The private and the synthetic fixture sets share this test.
type ManifestCase = {
  id: string;
  kind: "diary" | "narrative" | "extraction";
  fixture: string;
  candidate: string;
  expectedFailedChecks: string[];
  expectedAdvisories?: string[];
  contamination?: DiaryFixtureSources["contamination"];
  nextDayProbe?: boolean;
  sourceSessionCount?: number;
  turnCount?: number;
  baselineSource?: DiaryFixtureSources["baseline"]["source"];
  baselineProvenance?: string;
  expectedMetrics?: Record<string, number>;
};

const manifest = JSON.parse(
  readFileSync(path.join(evalRoot, "manifest.json"), "utf8"),
) as { schemaVersion: 1; cases: ManifestCase[] };

function casesOf(kind: ManifestCase["kind"]): ManifestCase[] {
  return manifest.cases.filter((item) => item.kind === kind);
}

function fixtureParts(item: ManifestCase): string[] {
  return item.fixture.split("/");
}

function diarySources(item: ManifestCase): DiaryFixtureSources {
  return json<DiaryFixtureSources>(...fixtureParts(item), "sources.json");
}

function diaryLabels(item: ManifestCase): DiaryFixtureLabels {
  return json<DiaryFixtureLabels>(...fixtureParts(item), "labels.json");
}

function candidateText(item: ManifestCase): string {
  return text(...fixtureParts(item), item.candidate);
}

// Every diary fixture directory on disk, whether or not the manifest freezes
// a candidate for it: the contamination and baseline pins apply to all of
// them (a prompt-example day may exist only to calibrate detectors).
function diaryFixtureDirs(): string[] {
  const diaryRoot = path.join(root, "diary");
  if (!existsSync(diaryRoot)) {
    return [];
  }
  return readdirSync(diaryRoot)
    .filter((entry) => existsSync(path.join(diaryRoot, entry, "sources.json")))
    .sort();
}

// A calibration pair is one fixture with a known-bad candidate (at least
// one hard check fires) and a clean reference (nothing fires); the detector
// tests below are anchored on it.
function calibrationPair(): { bad: ManifestCase; clean: ManifestCase } | null {
  const byFixture = new Map<string, ManifestCase[]>();
  for (const item of casesOf("diary")) {
    byFixture.set(item.fixture, [...(byFixture.get(item.fixture) ?? []), item]);
  }
  for (const items of byFixture.values()) {
    const bad = items.find((item) => item.expectedFailedChecks.length > 0);
    const clean = items.find(
      (item) =>
        item.expectedFailedChecks.length === 0 &&
        (item.expectedAdvisories ?? []).length === 0,
    );
    if (bad && clean) {
      return { bad, clean };
    }
  }
  return null;
}

const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("MC-114 diary detector calibration", () => {
  const pair = calibrationPair();
  const sources = pair ? diarySources(pair.bad) : null;
  const labels = pair ? diaryLabels(pair.bad) : null;

  it("gives diary replay headroom without lowering a larger live cap", () => {
    expect(diaryReplayMaxOutputTokens(3_000)).toBe(8_000);
    expect(diaryReplayMaxOutputTokens(10_000)).toBe(10_000);
  });

  it("has a calibration pair: one known-bad candidate and one clean reference on the same day", () => {
    expect(pair).not.toBeNull();
  });

  it.skipIf(!pair)("keeps the pinned failures firing on the known-bad candidate", () => {
    const checks = runDiaryMechanicalChecks({
      entry: candidateText(pair!.bad),
      sources: sources!,
      labels: labels!,
    });

    // Chronicle and center-starvation were demoted to advisories in MC-115
    // (they fired on owner-judged best entries); whatever the manifest pins
    // for this candidate must keep firing exactly.
    expect(failed(checks)).toEqual(pair!.bad.expectedFailedChecks);
    expect(advisories(checks)).toEqual(pair!.bad.expectedAdvisories ?? []);
  });

  it.skipIf(!pair)("clears the mechanical flags on the clean reference", () => {
    const checks = runDiaryMechanicalChecks({
      entry: candidateText(pair!.clean),
      sources: sources!,
      labels: labels!,
    });

    expect(failed(checks)).toEqual([]);
    expect(advisories(checks)).toEqual([]);
  });

  it.skipIf(!pair)("operationalizes prompt anchoring as an explicit failure", () => {
    const entry = `A held-out entry copied this: ${labels!.forbiddenPromptPhrases[0]}`;
    const checks = runDiaryMechanicalChecks({
      entry,
      sources: sources!,
      labels: labels!,
    });
    expect(failed(checks)).toContain("prompt-anchor-reuse");
  });

  it.skipIf(!pair)("ignores punctuation-only threshold-ending markers", () => {
    // Normalization strips punctuation, so "……" becomes an empty needle —
    // without the guard, endsWith("") flags every entry.
    const checks = runDiaryMechanicalChecks({
      entry: "今天只是安静地聊了聊天气……",
      sources: sources!,
      labels: {
        ...labels!,
        thresholdEndingMarkers: ["……"],
        plainDeltaMarkers: [],
      },
    });
    expect(failed(checks)).not.toContain("threshold-stop");
  });

  it.skipIf(!pair)("flags a one-paragraph multi-topic chronology and measures its center locally", () => {
    // Built from the fixture's own labels: one connective-led sentence per
    // labeled topic, then the center as a single short sentence at the end
    // — a chronicle by construction, with the center starved by construction.
    // Topic markers that are also center markers would widen the center's
    // ±1 window, so they stay out of the topic sentences.
    const centerMarkers = labels!.center.markers;
    const overlapsCenter = (marker: string) =>
      centerMarkers.some((c) => c.includes(marker) || marker.includes(c));
    const connectives = ["早上", "然后", "后来", "接着", "之后", "最后"];
    const topicSentences = labels!.topics
      .map((topic) =>
        topic.markers.filter((marker) => !overlapsCenter(marker)).slice(0, 3),
      )
      .filter((markers) => markers.length > 0)
      .map(
        (markers, index) =>
          `${connectives[index % connectives.length]}${markers.join("，")}。`,
      );
    const entry = [...topicSentences, `${centerMarkers[0]}。`].join("");

    expect(
      advisories(
        runDiaryMechanicalChecks({ entry, sources: sources!, labels: labels! }),
      ),
    ).toEqual(expect.arrayContaining(["chronicle", "center-starvation"]));
  });

  it("pins baselines and records contamination without consulting live versions", () => {
    const dirs = diaryFixtureDirs();
    expect(dirs.length).toBeGreaterThan(0);
    const contaminations = new Set<string>();
    for (const dir of dirs) {
      const pinned = json<DiaryFixtureSources>("diary", dir, "sources.json");
      // Throws unless the field is explicit: no fixture is held-out by
      // default.
      contaminations.add(parseDiaryFixtureContamination(pinned.contamination));
      if (pinned.baseline.source !== "none") {
        expect(pinned.baseline.content).toBeTruthy();
      }
    }
    // A set with no held-out day cannot demonstrate generalization.
    expect(contaminations.has("held-out")).toBe(true);
  });

  for (const item of casesOf("diary")) {
    it(`freezes ${item.id}`, () => {
      const itemSources = diarySources(item);
      const checks = runDiaryMechanicalChecks({
        entry: candidateText(item),
        sources: itemSources,
        labels: diaryLabels(item),
      });
      expect(failed(checks)).toEqual(item.expectedFailedChecks);
      if (item.expectedAdvisories) {
        expect(advisories(checks)).toEqual(item.expectedAdvisories);
      }

      if (item.contamination) {
        expect(itemSources.contamination).toBe(item.contamination);
      }
      if (item.nextDayProbe !== undefined) {
        expect(itemSources.nextDayProbe !== null).toBe(item.nextDayProbe);
      }
      if (item.sourceSessionCount !== undefined) {
        expect(itemSources.sourceSessionIds).toHaveLength(
          item.sourceSessionCount,
        );
        for (const id of itemSources.sourceSessionIds ?? []) {
          expect(id).toMatch(UUID_SHAPE);
        }
      }
      if (item.turnCount !== undefined) {
        expect(itemSources.turns).toHaveLength(item.turnCount);
      }
      if (item.baselineSource) {
        expect(itemSources.baseline.source).toBe(item.baselineSource);
      }
      if (item.baselineProvenance) {
        expect(itemSources.baseline.provenance).toContain(
          item.baselineProvenance,
        );
      }
    });
  }
});

describe("MC-114 narrative replay", () => {
  const narrativeCases = casesOf("narrative");
  const first = narrativeCases[0] ?? null;
  const sources = first
    ? json<NarrativeFixtureSources>(...fixtureParts(first), "sources.json")
    : null;
  const labels = first
    ? json<NarrativeFixtureLabels>(...fixtureParts(first), "labels.json")
    : null;

  it("gives replay-only headroom without lowering a larger pinned cap", () => {
    expect(narrativeReplayMaxOutputTokens(5_900)).toBe(8_000);
    expect(narrativeReplayMaxOutputTokens(10_000)).toBe(10_000);
  });

  for (const item of narrativeCases) {
    it(`reproduces the pinned finding on ${item.id}`, () => {
      const checks = runNarrativeMechanicalChecks({
        candidate: candidateText(item),
        sources: json<NarrativeFixtureSources>(
          ...fixtureParts(item),
          "sources.json",
        ),
        labels: json<NarrativeFixtureLabels>(
          ...fixtureParts(item),
          "labels.json",
        ),
      });

      expect(failed(checks)).toEqual(item.expectedFailedChecks);
    });
  }

  it.skipIf(!first)("flags date-headed diary form inside a narrative", () => {
    const checks = runNarrativeMechanicalChecks({
      candidate: `${candidateText(first!)}\n\n### July 15th\nA day entry.`,
      sources: sources!,
      labels: labels!,
    });
    expect(failed(checks)).toContain("date-headed-entries");
  });

  it.skipIf(!first)("builds the pinned historical prompt by removing only the recent carry amendment", () => {
    const current = buildConsolidationPrompt({
      mode: "incremental",
      currentRecord: sources!.currentRecord,
      tokenBudget: sources!.tokenBudget,
      sources: {
        rawTailDropped: [],
        summaries: sources!.sources.summaries.map((row) => ({
          ...row,
          cursorCompletedAt: new Date(row.cursorCompletedAt),
        })),
        rawTail: sources!.sources.rawTail.map((row) => ({
          ...row,
          createdAt: new Date(row.createdAt),
          completedAt: new Date(row.completedAt),
        })),
        memories: sources!.sources.memories.map((row) => ({
          ...row,
          updatedAt: new Date(row.updatedAt),
        })),
      },
    });
    const historical = toPreRecentCarryPrompt(current);

    expect(current).toContain("Rewrite recent by carrying it forward");
    expect(historical).not.toContain("Rewrite recent by carrying it forward");
    expect(historical).toContain("let episodic detail fade — it stays");
    expect(historical).toContain(sources!.sources.rawTail[0].content);

    const historicalShorten = toPreRecentCarryShortenPrompt(
      buildShortenRetryPrompt({ record: "record", tokenBudget: 2950 }),
    );
    expect(historicalShorten).not.toContain("dropping a stretch of");
    expect(historicalShorten).toContain("rather than deleting a layer");
  });
});

describe("MC-114 differential judge contract", () => {
  it("pins a chat response frame rather than the private-memory writer frame", () => {
    expect(DIARY_REPLAY_SYSTEM_FRAME_V1).toContain(
      "Respond directly and naturally",
    );
    expect(DIARY_REPLAY_SYSTEM_FRAME_V1).not.toContain(
      "writing your own private memory",
    );
  });

  it("requires fixture contamination to be explicit", () => {
    expect(parseDiaryFixtureContamination("held-out")).toBe("held-out");
    expect(parseDiaryFixtureContamination("prompt-example")).toBe(
      "prompt-example",
    );
    expect(() => parseDiaryFixtureContamination(undefined)).toThrow(
      "explicitly set",
    );
    expect(() => parseDiaryFixtureContamination("unknown")).toThrow(
      "explicitly set",
    );
  });

  const withoutProbe =
    casesOf("diary").find((item) => item.nextDayProbe === false) ?? null;

  it.skipIf(!withoutProbe)("rejects differential replay before generation when no real probe exists", () => {
    expect(() => requireDiaryNextDayProbe(diarySources(withoutProbe!))).toThrow(
      "has no real D+1 opening",
    );
  });

  it("versions renderable prompts without unresolved placeholders", () => {
    const template = "entry={{DIARY_ENTRY}} probe={{PROBE}}";
    expect(
      renderPromptTemplate(template, {
        DIARY_ENTRY: "memory",
        PROBE: "opening",
      }),
    ).toBe("entry=memory probe=opening");
    expect(() =>
      renderPromptTemplate(template, { DIARY_ENTRY: "memory" }),
    ).toThrow("Unresolved prompt placeholders");
  });

  it("accepts only a logically consistent judge result", () => {
    expect(
      parseDifferentialJudgeResult(
        '{"with_entry_uses_delta":true,"without_entry_uses_delta":false,"materially_different":true,"pass":true,"reason":"The stance changed."}',
      ),
    ).toMatchObject({ pass: true, materiallyDifferent: true });
    expect(() =>
      parseDifferentialJudgeResult(
        '{"with_entry_uses_delta":false,"without_entry_uses_delta":false,"materially_different":false,"pass":true,"reason":"inconsistent"}',
      ),
    ).toThrow("inconsistent pass");
  });
});

describe("MC-115 factuality/center judge contracts and skeleton series", () => {
  it("accepts a factuality result only when pass matches the error count", () => {
    expect(
      parseFactualityJudgeResult(
        '{"hard_errors":[],"pass":true,"note":""}',
      ),
    ).toEqual({ hardErrors: [], pass: true, note: "" });

    const withError = parseFactualityJudgeResult(
      JSON.stringify({
        hard_errors: [
          {
            class: "attribution",
            diary_quote: "她说雾必须留下",
            source_evidence: "[turn 12] ASSISTANT: 雾必须留下",
            explanation: "The line was the assistant's, not the person's.",
          },
        ],
        pass: false,
        note: "",
      }),
    );
    expect(withError.pass).toBe(false);
    expect(withError.hardErrors[0].class).toBe("attribution");

    expect(() =>
      parseFactualityJudgeResult(
        '{"hard_errors":[],"pass":false,"note":""}',
      ),
    ).toThrow("inconsistent pass");
    expect(() =>
      parseFactualityJudgeResult(
        '{"hard_errors":[{"class":"style","diary_quote":"a","source_evidence":"b","explanation":"c"}],"pass":false,"note":""}',
      ),
    ).toThrow("malformed");
  });

  it("takes the last JSON block when the judge deliberates and self-revises", () => {
    // Observed live: prose plus two fenced blocks, the second the verdict.
    const output = [
      "```json",
      '{"hard_errors":[{"class":"chronology","diary_quote":"a","source_evidence":"b","explanation":"c"}],"pass":false,"note":""}',
      "```",
      "",
      "After careful final review, correcting my analysis:",
      "",
      "```json",
      '{"hard_errors":[],"pass":true,"note":"withdrawn on re-reading"}',
      "```",
    ].join("\n");
    expect(parseFactualityJudgeResult(output)).toEqual({
      hardErrors: [],
      pass: true,
      note: "withdrawn on re-reading",
    });
  });

  it("accepts a center result only when it partitions the recognition details", () => {
    const details = ["the backup hazer", "the first no"];
    const valid = parseCenterJudgeResult(
      JSON.stringify({
        center_bucket: "paragraph",
        center_evidence: "…",
        selectivity: "selective",
        selectivity_note: "Weight follows the collapse and correction.",
        recognition_retained: ["the first no"],
        recognition_missing: ["the backup hazer"],
        pass: true,
        reason: "The correction carries a full passage.",
      }),
      details,
    );
    expect(valid.centerBucket).toBe("paragraph");
    expect(valid.recognitionMissing).toEqual(["the backup hazer"]);

    expect(() =>
      parseCenterJudgeResult(
        JSON.stringify({
          center_bucket: "passing",
          center_evidence: "",
          selectivity: "even-replay",
          selectivity_note: "",
          recognition_retained: ["the first no"],
          recognition_missing: [],
          pass: false,
          reason: "",
        }),
        details,
      ),
    ).toThrow("partition");

    expect(() =>
      parseCenterJudgeResult(
        JSON.stringify({
          center_bucket: "passing",
          center_evidence: "",
          selectivity: "selective",
          selectivity_note: "",
          recognition_retained: details,
          recognition_missing: [],
          pass: true,
          reason: "",
        }),
        details,
      ),
    ).toThrow("inconsistent pass");
  });

  it("finds a cross-entry phrase that no day's sources contain", () => {
    const entries = [
      {
        id: "a",
        entry: "今天的中心是雾机。彩排前它坏了。",
        sourceText: "雾机坏了 彩排前",
      },
      {
        id: "b",
        entry: "今天的中心是她第一次说不。别的都轻。",
        sourceText: "第一次说不 导演",
      },
    ];
    expect(findSkeletonSeries(entries)).toEqual([
      { phrase: "今天的中心是", entryIds: ["a", "b"] },
    ]);
  });

  it("ignores shared phrases that come from a day's own sources", () => {
    const entries = [
      {
        id: "a",
        entry: "今天的中心是雾机。",
        sourceText: "她问：今天的中心是什么呢",
      },
      {
        id: "b",
        entry: "今天的中心是她第一次说不。",
        sourceText: "第一次说不",
      },
    ];
    expect(findSkeletonSeries(entries)).toEqual([]);
  });

  it("respects the minimum length", () => {
    const entries = [
      { id: "a", entry: "今天的中心是雾机。", sourceText: "x" },
      { id: "b", entry: "今天的中心是她第一次说不。", sourceText: "y" },
    ];
    expect(findSkeletonSeries(entries, { minLength: 8 })).toEqual([]);
  });
});

describe("MC-115 minimal diary prompt (the great-deletion arm)", () => {
  const window = diaryDayWindow("2026-07-03");
  const turns = [
    {
      role: "user",
      content: "the rehearsal moment",
      completedAt: new Date(2026, 6, 3, 22, 15),
    },
  ];
  const prompt = buildMinimalDiaryPrompt({ window, turns, baseline: null });

  it("keeps the constitution: voice, reader, and the positional test", () => {
    expect(prompt).toContain("in your own voice, never rewritten");
    expect(prompt).toContain("not a report and not a log");
    expect(prompt).toContain("as someone who was there");
    expect(prompt).toContain("Entry date: 2026-07-03.");
    expect(prompt).toContain("through 2026-07-04 04:00");
  });

  it("keeps every floor", () => {
    expect(prompt).toContain("Floors — everything else is yours:");
    expect(prompt).toContain("Quotes stay in their original language");
    expect(prompt).toContain("register is the entry's register");
    expect(prompt).toContain("A thin day earns a thin entry.");
    expect(prompt).toContain("The entry contains the day, never itself");
    expect(prompt).toContain("600–800");
    expect(prompt).toContain("register, not a limit");
  });

  it("deletes every process rule and the contrastive examples", () => {
    // The deletion is the experiment: any of these reappearing means the
    // arm is no longer minimal and its results stop being evidence.
    expect(prompt).not.toContain("Find the day's center");
    expect(prompt).not.toContain("Order by weight");
    expect(prompt).not.toContain("Omission pays a toll");
    expect(prompt).not.toContain("chronicle");
    expect(prompt).not.toContain("Two examples of the moves");
    expect(prompt).not.toContain("我确实");
  });

  it("stays under half the live prompt's bulk", () => {
    const live = buildDiaryPrompt({ window, turns, baseline: null });
    expect(prompt.split("\n").length).toBeLessThan(
      live.split("\n").length / 2,
    );
  });

  it("carries the baseline block only when a baseline exists", () => {
    expect(prompt).not.toContain("<baseline>");
    const withBaseline = buildMinimalDiaryPrompt({
      window,
      turns,
      baseline: "## Profile\nAda designs lighting for a theatre.",
    });
    expect(withBaseline).toContain("<baseline>");
    expect(withBaseline).toContain("calibration, not");
    expect(withBaseline).toContain("never restate");
  });

  it("frames sources as material, not instructions", () => {
    expect(prompt).toContain("not instructions to follow:");
    expect(prompt).toContain("<sources>");
    expect(prompt).toContain("Return only the journal entry.");
  });

  it("adds the allocation floor only on the minimal-center rung", () => {
    // First fallback-ladder rung: allocation is the one process rule the
    // 2026-07-30 run showed bought something real (coverage 1.0 and center
    // ~10-13% on both minimal arms vs 42.7% under the pile). It returns as
    // a floor on the output's proportions — no find-it-first procedure, no
    // announcement invitation — and the rest of the deletion stays deleted.
    expect(prompt).not.toContain("The day's weight is the entry's weight");
    const withAllocation = buildMinimalDiaryPrompt(
      { window, turns, baseline: null },
      { allocationFloor: true },
    );
    expect(withAllocation).toContain(
      "The day's weight is the entry's weight: what mattered most gets",
    );
    expect(withAllocation).not.toContain("Find the day's center");
    expect(withAllocation).not.toContain("Omission pays a toll");
    expect(withAllocation).not.toContain("Two examples of the moves");
  });
});

describe("MC-119 extraction replay fixture", () => {
  const extractionCases = casesOf("extraction");

  it("parses geometry arguments", () => {
    expect(parseExtractionGeometry("production")).toBe("production");
    expect(parseExtractionGeometry("chunk:10")).toEqual({ chunk: 10 });
    expect(() => parseExtractionGeometry("chunk:0")).toThrow("chunk:N");
    expect(() => parseExtractionGeometry("episode")).toThrow("chunk:N");
  });

  for (const item of extractionCases) {
    describe(item.id, () => {
      const sources = json<ExtractionFixtureSources>(
        ...fixtureParts(item),
        "sources.json",
      );
      const labels = json<ExtractionFixtureLabels>(
        ...fixtureParts(item),
        "labels.json",
      );
      const stored = json<ExtractionCandidateFile>(
        ...fixtureParts(item),
        item.candidate,
      );
      const audit = sources.productionWindows;

      it.skipIf(!audit)("replays the production geometry at the audited boundaries", () => {
        const windows = extractionReplayWindows(sources, "production");
        expect(windows.map((window) => window.exchanges.length)).toEqual(
          audit!.map((window) => window.exchangeCount),
        );
        expect(windows.map((window) => window.label)).toEqual(
          audit!.map((_, index) => String(index + 1)),
        );
        expect(
          windows.flatMap((window) => window.exchanges).length,
        ).toBe(sources.exchanges.length);
      });

      it.skipIf(!audit)("chunks each production window, never across an episode boundary", () => {
        const chunk = 10;
        const chunkSizes = (count: number): number[] => {
          const sizes: number[] = [];
          for (let left = count; left > 0; left -= chunk) {
            sizes.push(Math.min(chunk, left));
          }
          return sizes;
        };
        const windows = extractionReplayWindows(sources, { chunk });
        expect(windows.map((window) => window.exchanges.length)).toEqual(
          audit!.flatMap((window) => chunkSizes(window.exchangeCount)),
        );
        if (audit!.length > 1) {
          const firstWindowChunks = chunkSizes(audit![0].exchangeCount).length;
          expect(windows[firstWindowChunks].label).toBe("2.1");
        }
      });

      it.skipIf(!audit)("rejects an audit row whose count disagrees with the pairing", () => {
        const wrong = audit![0].exchangeCount - 1;
        const tampered = {
          ...sources,
          productionWindows: audit!.map((window, index) =>
            index === 0 ? { ...window, exchangeCount: wrong } : window,
          ),
        };
        expect(() => extractionReplayWindows(tampered, "production")).toThrow(
          `audit row says ${wrong}`,
        );
      });

      it("freezes the candidate's coverage verdict", () => {
        const checks = runExtractionChecks({
          candidates: stored.candidates,
          labels,
        });
        expect(failed(checks)).toEqual(item.expectedFailedChecks);
        expect(checks[0].metrics).toMatchObject({
          expected: labels.expected.length,
          candidates: stored.candidates.length,
          ...(item.expectedMetrics ?? {}),
        });
      });

      it("passes a candidate set that carries a marker for enough expected items", () => {
        const candidates = labels.expected.map((entry) => ({
          content: `They said something about ${entry.markers[0]} tonight.`,
          kind: "shared_moment",
          importance: 0.7,
        }));
        expect(failed(runExtractionChecks({ candidates, labels }))).toEqual([]);
      });
    });
  }
});
