import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadEnvConfig } from "@next/env";

import {
  getCompressionProvider,
  getConsolidationProvider,
  getExtractionProvider,
} from "../src/server/chat/anthropic";
import { closeDatabase } from "../src/server/db/client";
import {
  getCompressionEnv,
  getConsolidationEnv,
  getExtractionEnv,
} from "../src/server/env";
import {
  advisoryCheckIds,
  buildMinimalDiaryPrompt,
  type CenterJudgeResult,
  type DiaryFixtureLabels,
  type DiaryFixtureSources,
  DIARY_REPLAY_SYSTEM_FRAME_V1,
  diaryReplayMaxOutputTokens,
  type DifferentialJudgeResult,
  type ExtractionCandidateFile,
  type ExtractionFixtureLabels,
  type ExtractionFixtureSources,
  type ExtractionGeometry,
  extractionReplayWindows,
  type FactualityJudgeResult,
  findSkeletonSeries,
  hardFailedCheckIds,
  type MechanicalCheck,
  type NarrativeFixtureLabels,
  type NarrativeFixtureSources,
  narrativeReplayMaxOutputTokens,
  parseCenterJudgeResult,
  parseDifferentialJudgeResult,
  parseExtractionGeometry,
  parseFactualityJudgeResult,
  renderPromptTemplate,
  requireDiaryNextDayProbe,
  runDiaryMechanicalChecks,
  runExtractionChecks,
  runNarrativeMechanicalChecks,
  toPreRecentCarryPrompt,
  toPreRecentCarryShortenPrompt,
} from "../src/server/evals/content-discipline";
import {
  EXTRACTION_MAX_ITEMS_PER_CALL,
  type ExtractionPromptVersion,
  type MemoryCandidate,
  parseExtractionOutput,
  requestExtractionOutput,
  selectMemoryCandidates,
} from "../src/server/memory/extract";
import {
  buildConsolidationPrompt,
  buildShortenRetryPrompt,
  generateNarrativeWithProviderFallback,
  runWithProviderFallback,
  type ConsolidationSources,
} from "../src/server/summaries/consolidate-narrative";
import {
  COMPRESSION_MAX_OUTPUT_TOKENS,
  findTermination,
  streamCompressionText,
} from "../src/server/summaries/compression";
import {
  buildDiaryPrompt,
  diaryDayWindow,
  generateDiaryEntryWithProviderFallback,
} from "../src/server/summaries/diary";

loadEnvConfig(process.cwd());

const EVAL_ROOT = path.join(process.cwd(), "evals", "content-discipline");

type ManifestCase = {
  id: string;
  kind: "diary" | "narrative" | "extraction";
  fixture: string;
  candidate: string;
  expectedFailedChecks: string[];
  // Advisory detectors (chronicle, center-starvation) stay pinned here so
  // the frozen calibration keeps meaning after their demotion from gates.
  expectedAdvisories?: string[];
};

type Manifest = { schemaVersion: 1; cases: ManifestCase[] };

type ExtractionCarrier = "compression" | "consolidation" | "extraction";

type SingleOptions = {
  kind: "diary" | "narrative" | "extraction";
  fixture: string;
  candidatePath?: string;
  generate: boolean;
  // "current" is always the live prompt of the fixture's writer. Diary:
  // "legacy" is the retired D22 rule-pile prompt (the live one until
  // 2026-08-30), "minimal" the great-deletion arm without the allocation
  // floor, "minimal-center" the arm that was promoted (== current, kept as
  // a name so old reports and preference files still read). Narrative:
  // "pre-amendment". Extraction: "legacy" is the prompt live until the v2
  // adoption (2026-10-07), sent unframed as it was; "framed" is that same
  // prompt under the writer identity frame.
  prompt:
    | "current"
    | "legacy"
    | "pre-amendment"
    | "minimal"
    | "minimal-center"
    | "framed";
  judge: boolean;
  contentJudge: boolean;
  thinking: boolean;
  // Extraction replay arms (MC-119): which configured provider triple sends
  // the request, and how the session is cut into requests.
  carrier: ExtractionCarrier;
  geometry: ExtractionGeometry;
  // "fixed" = the live 5-per-call cap; "scaled" = 5 per ten exchanges of the
  // window, at most 15 — the alternative to chunking for long episodes.
  cap: "fixed" | "scaled";
  outputPath?: string;
};

function extractionCapFor(cap: "fixed" | "scaled", exchangeCount: number): number {
  return cap === "fixed"
    ? EXTRACTION_MAX_ITEMS_PER_CALL
    : Math.min(15, EXTRACTION_MAX_ITEMS_PER_CALL * Math.ceil(exchangeCount / 10));
}

type DifferentialReplay = {
  provider: string;
  model: string;
  withEntry: string;
  withoutEntry: string;
  judge: DifferentialJudgeResult;
};

type GenerationMetadata = {
  provider: string;
  model: string;
  host: string;
  maxOutputTokens: number;
  defaultMaxOutputTokens: number;
  defaultMaxOutputTokensLabel: "fixture" | "live";
  thinking: "enabled" | "provider default";
};

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

function fixtureDir(relative: string): string {
  return path.join(EVAL_ROOT, "fixtures", relative);
}

// Accept raw entries and frozen replay reports alike: a report carries its
// entry after the "## Candidate" heading.
function candidateTextOf(raw: string): string {
  const marker = "\n## Candidate\n";
  const markerIndex = raw.indexOf(marker);
  return markerIndex >= 0 ? raw.slice(markerIndex + marker.length) : raw;
}

function formatChecks(checks: MechanicalCheck[]): string {
  return checks
    .map(
      (check) =>
        `- ${check.passed ? "PASS" : check.advisory ? "ADVISORY" : "FLAG"} ${check.id}: ${check.summary}\n  ${JSON.stringify(check.metrics ?? {})}`,
    )
    .join("\n");
}

async function inspectDiary(
  directory: string,
  entry: string,
): Promise<{
  sources: DiaryFixtureSources;
  labels: DiaryFixtureLabels;
  checks: MechanicalCheck[];
}> {
  const [sources, labels] = await Promise.all([
    readJson<DiaryFixtureSources>(path.join(directory, "sources.json")),
    readJson<DiaryFixtureLabels>(path.join(directory, "labels.json")),
  ]);
  return {
    sources,
    labels,
    checks: runDiaryMechanicalChecks({ entry, sources, labels }),
  };
}

async function inspectNarrative(
  directory: string,
  candidate: string,
): Promise<{
  sources: NarrativeFixtureSources;
  labels: NarrativeFixtureLabels;
  checks: MechanicalCheck[];
}> {
  const [sources, labels] = await Promise.all([
    readJson<NarrativeFixtureSources>(path.join(directory, "sources.json")),
    readJson<NarrativeFixtureLabels>(path.join(directory, "labels.json")),
  ]);
  return {
    sources,
    labels,
    checks: runNarrativeMechanicalChecks({ candidate, sources, labels }),
  };
}

function parseExtractionCandidate(raw: string): ExtractionCandidateFile {
  const parsed = JSON.parse(candidateTextOf(raw)) as ExtractionCandidateFile;
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.candidates)) {
    throw new Error("An extraction candidate is a schemaVersion 1 JSON file with a candidates array.");
  }
  return parsed;
}

async function inspectExtraction(
  directory: string,
  candidate: ExtractionCandidateFile,
): Promise<{
  sources: ExtractionFixtureSources;
  labels: ExtractionFixtureLabels;
  checks: MechanicalCheck[];
}> {
  const [sources, labels] = await Promise.all([
    readJson<ExtractionFixtureSources>(path.join(directory, "sources.json")),
    readJson<ExtractionFixtureLabels>(path.join(directory, "labels.json")),
  ]);
  return {
    sources,
    labels,
    checks: runExtractionChecks({ candidates: candidate.candidates, labels }),
  };
}

async function runSuite(): Promise<void> {
  const manifest = await readJson<Manifest>(path.join(EVAL_ROOT, "manifest.json"));
  let calibrated = true;
  for (const item of manifest.cases) {
    const directory = fixtureDir(item.fixture);
    const candidate = await readFile(path.join(directory, item.candidate), "utf8");
    const checks =
      item.kind === "diary"
        ? (await inspectDiary(directory, candidate)).checks
        : item.kind === "extraction"
          ? (await inspectExtraction(directory, parseExtractionCandidate(candidate))).checks
          : (await inspectNarrative(directory, candidate)).checks;
    const actual = hardFailedCheckIds(checks).sort();
    const expected = [...item.expectedFailedChecks].sort();
    const actualAdvisories = advisoryCheckIds(checks).sort();
    const expectedAdvisories = item.expectedAdvisories
      ? [...item.expectedAdvisories].sort()
      : undefined;
    const matches =
      JSON.stringify(actual) === JSON.stringify(expected) &&
      (!expectedAdvisories ||
        JSON.stringify(actualAdvisories) ===
          JSON.stringify(expectedAdvisories));
    calibrated &&= matches;
    console.log(`${matches ? "PASS" : "FAIL"} ${item.id}`);
    console.log(`  expected flags: ${expected.join(", ") || "(none)"}`);
    console.log(`  actual flags:   ${actual.join(", ") || "(none)"}`);
    if (expectedAdvisories) {
      console.log(
        `  expected advisories: ${expectedAdvisories.join(", ") || "(none)"}`,
      );
      console.log(
        `  actual advisories:   ${actualAdvisories.join(", ") || "(none)"}`,
      );
    }
  }
  if (!calibrated) {
    process.exitCode = 1;
  }
}

function parseSingleOptions(args: string[]): SingleOptions {
  const kind = args.shift();
  const fixture = args.shift();
  if (
    (kind !== "diary" && kind !== "narrative" && kind !== "extraction") ||
    !fixture
  ) {
    throw new Error(
      "Usage: npm run eval:content -- [diary|narrative] FIXTURE [--candidate path | --generate] [--prompt current|legacy|pre-amendment|minimal|minimal-center] [--thinking] [--judge] [--content-judge] [--output path]\n" +
        "       npm run eval:content -- extraction FIXTURE [--candidate path | --generate] [--prompt current|legacy|framed] [--carrier compression|consolidation|extraction] [--geometry production|chunk:N] [--output path]\n" +
        "       npm run eval:content -- skeleton FIXTURE:CANDIDATE_PATH FIXTURE:CANDIDATE_PATH [...] [--min-length n]",
    );
  }
  const options: SingleOptions = {
    kind,
    fixture,
    generate: false,
    prompt: "current",
    judge: false,
    contentJudge: false,
    thinking: false,
    carrier: "extraction",
    geometry: "production",
    cap: "fixed",
  };
  let extractionArm = false;
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--generate") {
      options.generate = true;
    } else if (arg === "--carrier") {
      const carrier = args.shift();
      if (
        carrier !== "compression" &&
        carrier !== "consolidation" &&
        carrier !== "extraction"
      ) {
        throw new Error(
          "--carrier must be compression, consolidation, or extraction.",
        );
      }
      options.carrier = carrier;
      extractionArm = true;
    } else if (arg === "--geometry") {
      const geometry = args.shift();
      if (!geometry) throw new Error("--geometry needs a value.");
      options.geometry = parseExtractionGeometry(geometry);
      extractionArm = true;
    } else if (arg === "--cap") {
      const cap = args.shift();
      if (cap !== "fixed" && cap !== "scaled") {
        throw new Error("--cap must be fixed or scaled.");
      }
      options.cap = cap;
      extractionArm = true;
    } else if (arg === "--judge") {
      options.judge = true;
    } else if (arg === "--content-judge") {
      options.contentJudge = true;
    } else if (arg === "--thinking") {
      options.thinking = true;
    } else if (arg === "--candidate") {
      options.candidatePath = args.shift();
      if (!options.candidatePath) throw new Error("--candidate needs a path.");
    } else if (arg === "--prompt") {
      const prompt = args.shift();
      if (
        prompt !== "current" &&
        prompt !== "legacy" &&
        prompt !== "pre-amendment" &&
        prompt !== "minimal" &&
        prompt !== "minimal-center" &&
        prompt !== "framed"
      ) {
        throw new Error(
          "--prompt must be current, legacy, pre-amendment, minimal, minimal-center, or framed.",
        );
      }
      options.prompt = prompt;
    } else if (arg === "--output") {
      options.outputPath = args.shift();
      if (!options.outputPath) throw new Error("--output needs a path.");
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (options.generate === Boolean(options.candidatePath)) {
    throw new Error("Choose exactly one of --generate or --candidate.");
  }
  if (options.kind === "diary" && options.prompt === "pre-amendment") {
    throw new Error("The pre-amendment prompt option applies only to narrative.");
  }
  if (
    options.kind === "narrative" &&
    (options.prompt === "legacy" ||
      options.prompt === "minimal" ||
      options.prompt === "minimal-center")
  ) {
    throw new Error(`The ${options.prompt} prompt option applies only to diary.`);
  }
  if (options.kind !== "extraction" && options.prompt === "framed") {
    throw new Error(`The ${options.prompt} prompt option applies only to extraction.`);
  }
  if (options.prompt !== "current" && !options.generate) {
    throw new Error(`--prompt ${options.prompt} requires --generate.`);
  }
  if (options.kind === "narrative" && options.judge) {
    throw new Error("The differential judge applies only to diary fixtures.");
  }
  if (options.kind === "narrative" && options.contentJudge) {
    throw new Error(
      "The factuality/center judges apply only to diary fixtures.",
    );
  }
  if (options.thinking && (options.kind !== "diary" || !options.generate)) {
    throw new Error("--thinking requires a diary fixture with --generate.");
  }
  if (extractionArm && (options.kind !== "extraction" || !options.generate)) {
    throw new Error(
      "--carrier, --geometry, and --cap apply only to an extraction fixture with --generate.",
    );
  }
  if (
    options.kind === "extraction" &&
    ((options.prompt !== "current" &&
      options.prompt !== "legacy" &&
      options.prompt !== "framed") ||
      options.judge ||
      options.contentJudge)
  ) {
    throw new Error(
      "Extraction fixtures take --prompt current|legacy|framed and no judges.",
    );
  }
  return options;
}

function reviveNarrativeSources(
  fixture: NarrativeFixtureSources,
): ConsolidationSources {
  return {
    summaries: fixture.sources.summaries.map((row) => ({
      ...row,
      cursorCompletedAt: new Date(row.cursorCompletedAt),
    })),
    rawTail: fixture.sources.rawTail.map((row) => ({
      ...row,
      createdAt: new Date(row.createdAt),
      completedAt: new Date(row.completedAt),
    })),
    memories: fixture.sources.memories.map((row) => ({
      ...row,
      updatedAt: new Date(row.updatedAt),
    })),
    // A fixture is the selection as captured; the capture script says so
    // when the cap dropped anything at capture time.
    rawTailDropped: [],
  };
}

async function generateDiaryCandidate(
  sources: DiaryFixtureSources,
  promptVersion: SingleOptions["prompt"],
  thinking: boolean,
): Promise<{ content: string; metadata: GenerationMetadata }> {
  process.env.TZ = sources.timezone;
  const promptInput = {
    window: diaryDayWindow(sources.date),
    turns: sources.turns.map((turn) => ({
      ...turn,
      completedAt: new Date(turn.completedAt),
    })),
    baseline: sources.baseline.content,
  };
  // "current" is the live prompt (minimal-center since 2026-08-30); the D22
  // rule-pile prompt is replayable only as "legacy" (renamed 2026-09-12 —
  // before that the arm was called "current", so reports and preference
  // files dated before then read "current" as the legacy prompt).
  const prompt =
    promptVersion === "legacy"
      ? buildDiaryPrompt(promptInput)
      : buildMinimalDiaryPrompt(promptInput, {
          allocationFloor: promptVersion !== "minimal",
        });
  const maxOutputTokens = diaryReplayMaxOutputTokens(
    COMPRESSION_MAX_OUTPUT_TOKENS,
  );
  const generated = await generateDiaryEntryWithProviderFallback(prompt, {
    maxOutputTokens,
    ...(thinking ? { thinkingEnabled: true } : {}),
  });
  return {
    content: generated.content,
    metadata: {
      provider: generated.candidate.label,
      model: generated.candidate.model,
      host: new URL(generated.candidate.baseUrl).host,
      maxOutputTokens,
      defaultMaxOutputTokens: COMPRESSION_MAX_OUTPUT_TOKENS,
      defaultMaxOutputTokensLabel: "live",
      thinking: thinking ? "enabled" : "provider default",
    },
  };
}

async function generateNarrativeCandidate(
  fixture: NarrativeFixtureSources,
  promptVersion: SingleOptions["prompt"],
): Promise<{ content: string; metadata: GenerationMetadata }> {
  let prompt = buildConsolidationPrompt({
    mode: fixture.mode,
    currentRecord: fixture.currentRecord,
    tokenBudget: fixture.tokenBudget,
    sources: reviveNarrativeSources(fixture),
  });
  if (promptVersion === "pre-amendment") {
    prompt = toPreRecentCarryPrompt(prompt);
  }
  const maxOutputTokens = narrativeReplayMaxOutputTokens(
    fixture.maxOutputTokens,
  );
  const generated = await generateNarrativeWithProviderFallback({
    prompt,
    targetTokens: fixture.tokenBudget,
    maxOutputTokens,
    ...(promptVersion === "pre-amendment"
      ? {
          buildShortenPrompt: (input: {
            record: string;
            tokenBudget: number;
          }) =>
            toPreRecentCarryShortenPrompt(
              buildShortenRetryPrompt(input),
            ),
        }
      : {}),
  });
  return {
    content: generated.content,
    metadata: {
      provider: generated.candidate.label,
      model: generated.candidate.model,
      host: new URL(generated.candidate.baseUrl).host,
      maxOutputTokens,
      defaultMaxOutputTokens: fixture.maxOutputTokens,
      defaultMaxOutputTokensLabel: "fixture",
      thinking: "provider default",
    },
  };
}

type ExtractionWindowReplay = {
  label: string;
  exchangeCount: number;
  raw: MemoryCandidate[];
  kept: MemoryCandidate[];
  error?: string;
};

function extractionCarrier(carrier: ExtractionCarrier): {
  provider: ReturnType<typeof getExtractionProvider>;
  model: string;
  host: string;
} {
  if (carrier === "compression") {
    const env = getCompressionEnv();
    return {
      provider: getCompressionProvider(),
      model: env.COMPRESSION_MODEL,
      host: new URL(env.COMPRESSION_BASE_URL).host,
    };
  }
  if (carrier === "consolidation") {
    const env = getConsolidationEnv();
    return {
      provider: getConsolidationProvider(),
      model: env.CONSOLIDATION_MODEL,
      host: new URL(env.CONSOLIDATION_BASE_URL).host,
    };
  }
  const env = getExtractionEnv();
  return {
    provider: getExtractionProvider(),
    model: env.EXTRACTION_MODEL,
    host: new URL(env.EXTRACTION_BASE_URL).host,
  };
}

// One request per replay window, the live request shape verbatim. A window
// whose output terminates (max_tokens, unparseable) is recorded as such and
// the other windows still run — the loss is the finding.
async function generateExtractionCandidate(
  sources: ExtractionFixtureSources,
  carrier: ExtractionCarrier,
  geometry: ExtractionGeometry,
  prompt: "current" | "legacy" | "framed",
  cap: "fixed" | "scaled",
): Promise<{
  candidate: ExtractionCandidateFile;
  windows: ExtractionWindowReplay[];
  metadata: GenerationMetadata;
}> {
  const target = extractionCarrier(carrier);
  const windows: ExtractionWindowReplay[] = [];
  for (const window of extractionReplayWindows(sources, geometry)) {
    const replay: ExtractionWindowReplay = {
      label: window.label,
      exchangeCount: window.exchanges.length,
      raw: [],
      kept: [],
    };
    const maxItems = extractionCapFor(cap, window.exchanges.length);
    try {
      const output = await requestExtractionOutput({
        provider: target.provider,
        model: target.model,
        exchanges: window.exchanges,
        promptVersion: (prompt === "current"
          ? "current"
          : "legacy") satisfies ExtractionPromptVersion,
        framed: prompt !== "legacy",
        maxItems,
      });
      replay.raw = parseExtractionOutput(output, { model: target.model });
      replay.kept = selectMemoryCandidates(replay.raw, maxItems);
    } catch (error) {
      const termination = findTermination(error);
      if (!termination) {
        throw error;
      }
      replay.error = termination.message;
    }
    windows.push(replay);
    console.log(
      `window ${replay.label}: ${replay.exchangeCount} exchanges → raw ${replay.raw.length}, kept ${replay.kept.length}${replay.error ? ` (terminated: ${replay.error})` : ""}`,
    );
  }
  return {
    candidate: {
      schemaVersion: 1,
      candidates: windows.flatMap((window) => window.kept),
    },
    windows,
    metadata: {
      provider: carrier,
      model: target.model,
      host: target.host,
      maxOutputTokens: COMPRESSION_MAX_OUTPUT_TOKENS,
      defaultMaxOutputTokens: COMPRESSION_MAX_OUTPUT_TOKENS,
      defaultMaxOutputTokensLabel: "live",
      thinking: "provider default",
    },
  };
}

function formatExtractionWindows(windows: ExtractionWindowReplay[]): string {
  return windows
    .map((window) =>
      [
        `### Window ${window.label} (${window.exchangeCount} exchanges)`,
        "",
        `- Raw candidates: ${window.raw.length}; kept: ${window.kept.length}${window.error ? `; terminated: ${window.error}` : ""}`,
        "",
        "```json",
        JSON.stringify(window.raw, null, 2),
        "```",
      ].join("\n"),
    )
    .join("\n\n");
}

async function runDifferentialJudge(input: {
  entry: string;
  sources: DiaryFixtureSources;
  labels: DiaryFixtureLabels;
}): Promise<DifferentialReplay> {
  const nextDayProbe = requireDiaryNextDayProbe(input.sources);
  const [armTemplate, judgeTemplate] = await Promise.all([
    readFile(path.join(EVAL_ROOT, "prompts", "diary-replay-arm-v1.md"), "utf8"),
    readFile(
      path.join(EVAL_ROOT, "prompts", "diary-differential-judge-v1.md"),
      "utf8",
    ),
  ]);
  const probe = nextDayProbe.userTurn.content;
  const delta = input.labels.center.description;
  return runWithProviderFallback(
    "content_discipline_differential_provider_failed",
    async (candidate) => {
      const runArm = (entry: string) =>
        streamCompressionText({
          provider: candidate.provider,
          model: candidate.model,
          system: DIARY_REPLAY_SYSTEM_FRAME_V1,
          stage: "eval_differential_arm",
          prompt: renderPromptTemplate(armTemplate, {
            DIARY_ENTRY: entry || "(none)",
            PROBE: probe,
          }),
          temperature: 0.2,
          maxOutputTokens: 1_000,
          emptyErrorMessage: "Differential replay arm returned no response.",
        });
      const withEntry = await runArm(input.entry);
      const withoutEntry = await runArm("");
      const judgeOutput = await streamCompressionText({
        provider: candidate.provider,
        model: candidate.model,
        prompt: renderPromptTemplate(judgeTemplate, {
          LABELED_DELTA: delta,
          DIARY_ENTRY: input.entry,
          PROBE: probe,
          WITH_ENTRY_RESPONSE: withEntry,
          WITHOUT_ENTRY_RESPONSE: withoutEntry,
        }),
        stage: "eval_differential_judge",
        temperature: 0.2,
        maxOutputTokens: 1_000,
        emptyErrorMessage: "Differential judge returned no result.",
      });
      return {
        provider: candidate.label,
        model: candidate.model,
        withEntry,
        withoutEntry,
        judge: parseDifferentialJudgeResult(judgeOutput),
      };
    },
  );
}

type ContentJudgeReplay = {
  provider: string;
  model: string;
  factuality: FactualityJudgeResult;
  center: CenterJudgeResult;
};

function numberedSourceTurns(sources: DiaryFixtureSources): string {
  return sources.turns
    .map(
      (turn, index) =>
        `[turn ${index}] ${turn.completedAt} ${turn.role.toUpperCase()}: ${turn.content}`,
    )
    .join("\n");
}

async function runContentJudges(input: {
  entry: string;
  sources: DiaryFixtureSources;
  labels: DiaryFixtureLabels;
}): Promise<ContentJudgeReplay> {
  const [factualityTemplate, centerTemplate] = await Promise.all([
    readFile(
      path.join(EVAL_ROOT, "prompts", "diary-factuality-judge-v1.md"),
      "utf8",
    ),
    readFile(
      path.join(EVAL_ROOT, "prompts", "diary-center-judge-v1.md"),
      "utf8",
    ),
  ]);
  const recognitionDetails = input.labels.recognitionDetails ?? [];
  return runWithProviderFallback(
    "content_discipline_content_judge_provider_failed",
    async (candidate) => {
      const factualityOutput = await streamCompressionText({
        provider: candidate.provider,
        model: candidate.model,
        prompt: renderPromptTemplate(factualityTemplate, {
          SOURCE_TURNS: numberedSourceTurns(input.sources),
          DIARY_ENTRY: input.entry,
        }),
        stage: "eval_factuality_judge",
        temperature: 0.2,
        // Relay-side reasoning shares max_tokens with the visible answer
        // (same trap as DIARY_REPLAY_MIN_OUTPUT_TOKENS); 2k hit max_tokens
        // in live judge runs.
        maxOutputTokens: 8_000,
        emptyErrorMessage: "Factuality judge returned no result.",
      });
      const centerOutput = await streamCompressionText({
        provider: candidate.provider,
        model: candidate.model,
        prompt: renderPromptTemplate(centerTemplate, {
          CENTER_DESCRIPTION: input.labels.center.description,
          RECOGNITION_DETAILS:
            recognitionDetails.map((detail) => `- ${detail}`).join("\n") ||
            "(none)",
          DIARY_ENTRY: input.entry,
        }),
        stage: "eval_center_judge",
        temperature: 0.2,
        maxOutputTokens: 8_000,
        emptyErrorMessage: "Center judge returned no result.",
      });
      const parseWithRawOnFailure = <T>(
        label: string,
        raw: string,
        parse: () => T,
      ): T => {
        try {
          return parse();
        } catch (error) {
          console.error(`${label} raw output:\n${raw}`);
          throw error;
        }
      };
      return {
        provider: candidate.label,
        model: candidate.model,
        factuality: parseWithRawOnFailure(
          "Factuality judge",
          factualityOutput,
          () => parseFactualityJudgeResult(factualityOutput),
        ),
        center: parseWithRawOnFailure("Center judge", centerOutput, () =>
          parseCenterJudgeResult(centerOutput, recognitionDetails),
        ),
      };
    },
  );
}

async function runSingle(options: SingleOptions): Promise<void> {
  const directory = fixtureDir(options.fixture);
  let candidate: string;
  let generationMetadata: GenerationMetadata | undefined;
  let checks: MechanicalCheck[];
  let differential: DifferentialReplay | undefined;
  let contentJudge: ContentJudgeReplay | undefined;
  let extractionWindows: ExtractionWindowReplay[] | undefined;
  if (options.kind === "extraction") {
    const sources = await readJson<ExtractionFixtureSources>(
      path.join(directory, "sources.json"),
    );
    let parsed: ExtractionCandidateFile;
    if (options.generate) {
      const generated = await generateExtractionCandidate(
        sources,
        options.carrier,
        options.geometry,
        options.prompt as "current" | "legacy" | "framed",
        options.cap,
      );
      parsed = generated.candidate;
      extractionWindows = generated.windows;
      generationMetadata = generated.metadata;
    } else {
      parsed = parseExtractionCandidate(
        await readFile(path.resolve(options.candidatePath!), "utf8"),
      );
    }
    candidate = JSON.stringify(parsed, null, 2);
    checks = (await inspectExtraction(directory, parsed)).checks;
  } else if (options.kind === "diary") {
    const sources = await readJson<DiaryFixtureSources>(
      path.join(directory, "sources.json"),
    );
    if (options.judge) {
      requireDiaryNextDayProbe(sources);
    }
    if (options.generate) {
      const generated = await generateDiaryCandidate(
        sources,
        options.prompt,
        options.thinking,
      );
      candidate = generated.content;
      generationMetadata = generated.metadata;
    } else {
      candidate = candidateTextOf(
        await readFile(path.resolve(options.candidatePath!), "utf8"),
      );
    }
    const inspected = await inspectDiary(directory, candidate);
    checks = inspected.checks;
    if (options.judge) {
      differential = await runDifferentialJudge({
        entry: candidate,
        sources: inspected.sources,
        labels: inspected.labels,
      });
    }
    if (options.contentJudge) {
      contentJudge = await runContentJudges({
        entry: candidate,
        sources: inspected.sources,
        labels: inspected.labels,
      });
    }
  } else {
    const sources = await readJson<NarrativeFixtureSources>(
      path.join(directory, "sources.json"),
    );
    if (options.generate) {
      const generated = await generateNarrativeCandidate(
        sources,
        options.prompt,
      );
      candidate = generated.content;
      generationMetadata = generated.metadata;
    } else {
      candidate = candidateTextOf(
        await readFile(path.resolve(options.candidatePath!), "utf8"),
      );
    }
    checks = (await inspectNarrative(directory, candidate)).checks;
  }

  const report = [
    `# Content-discipline replay: ${options.fixture}`,
    "",
    `- Kind: ${options.kind}`,
    `- Candidate: ${
      options.generate
        ? options.kind === "extraction"
          ? `generated (carrier=${options.carrier}, geometry=${
              options.geometry === "production"
                ? "production"
                : `chunk:${options.geometry.chunk}`
            }, prompt=${options.prompt}, cap=${options.cap})`
          : `generated (${options.prompt})`
        : path.resolve(options.candidatePath!)
    }`,
    ...(generationMetadata
      ? [
          `- Generated by: ${generationMetadata.provider} (${generationMetadata.model} @ ${generationMetadata.host})`,
          `- Max output tokens: ${generationMetadata.maxOutputTokens} (${generationMetadata.defaultMaxOutputTokensLabel} default: ${generationMetadata.defaultMaxOutputTokens})`,
          `- Thinking: ${generationMetadata.thinking}`,
        ]
      : []),
    `- Flags: ${hardFailedCheckIds(checks).join(", ") || "(none)"}`,
    `- Advisories: ${advisoryCheckIds(checks).join(", ") || "(none)"}`,
    "",
    "## Mechanical checks",
    "",
    formatChecks(checks),
    ...(extractionWindows
      ? ["", "## Windows", "", formatExtractionWindows(extractionWindows)]
      : []),
    ...(contentJudge
      ? [
          "",
          "## Factuality judge",
          "",
          `- Provider: ${contentJudge.provider}`,
          `- Model: ${contentJudge.model}`,
          `- Hard errors: ${contentJudge.factuality.hardErrors.length}`,
          "",
          JSON.stringify(contentJudge.factuality, null, 2),
          "",
          "## Center judge",
          "",
          `- Center bucket: ${contentJudge.center.centerBucket}`,
          `- Selectivity: ${contentJudge.center.selectivity}`,
          `- Recognition retained: ${contentJudge.center.recognitionRetained.length}/${contentJudge.center.recognitionRetained.length + contentJudge.center.recognitionMissing.length}`,
          "",
          JSON.stringify(contentJudge.center, null, 2),
        ]
      : []),
    ...(differential
      ? [
          "",
          "## Differential replay",
          "",
          `- Provider: ${differential.provider}`,
          `- Model: ${differential.model}`,
          "",
          "### With entry",
          "",
          differential.withEntry,
          "",
          "### Without entry",
          "",
          differential.withoutEntry,
          "",
          "### Judge",
          "",
          JSON.stringify(differential.judge, null, 2),
        ]
      : []),
    "",
    "## Candidate",
    "",
    candidate.trim(),
  ].join("\n");
  const outputPath =
    options.outputPath ??
    path.join("/tmp", `loci-content-eval-${options.fixture.replaceAll("/", "-")}.md`);
  await writeFile(outputPath, report, "utf8");
  console.log(report.slice(0, report.indexOf("## Candidate")));
  console.log(`Wrote: ${outputPath}`);
}

// Cross-entry skeleton scan: candidates may be raw entries or the frozen
// replay reports (the text after "## Candidate" is used automatically).
async function runSkeleton(args: string[]): Promise<void> {
  let minLength = 6;
  const pairs: Array<{ fixture: string; candidatePath: string }> = [];
  while (args.length > 0) {
    const arg = args.shift()!;
    if (arg === "--min-length") {
      const value = Number(args.shift());
      if (!Number.isInteger(value) || value < 2) {
        throw new Error("--min-length needs an integer of at least 2.");
      }
      minLength = value;
    } else {
      const separator = arg.indexOf(":");
      if (separator <= 0 || separator === arg.length - 1) {
        throw new Error(
          `Skeleton arguments are FIXTURE:CANDIDATE_PATH pairs; got: ${arg}`,
        );
      }
      pairs.push({
        fixture: arg.slice(0, separator),
        candidatePath: arg.slice(separator + 1),
      });
    }
  }
  if (pairs.length < 2) {
    throw new Error("The skeleton scan needs at least two candidates.");
  }
  const entries = await Promise.all(
    pairs.map(async ({ fixture, candidatePath }) => {
      const sources = await readJson<DiaryFixtureSources>(
        path.join(fixtureDir(fixture), "sources.json"),
      );
      const entry = candidateTextOf(
        await readFile(path.resolve(candidatePath), "utf8"),
      );
      return {
        id: `${fixture}:${path.basename(candidatePath)}`,
        entry,
        sourceText: sources.turns.map((turn) => turn.content).join("\n"),
      };
    }),
  );
  const phrases = findSkeletonSeries(entries, { minLength });
  if (phrases.length === 0) {
    console.log(
      `No cross-entry skeleton phrases (min length ${minLength}, ${entries.length} entries).`,
    );
    return;
  }
  console.log(
    `${phrases.length} cross-entry skeleton phrase(s) absent from every day's sources:`,
  );
  for (const { phrase, entryIds } of phrases) {
    console.log(`- "${phrase}" (${entryIds.join(", ")})`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || (args.length === 1 && args[0] === "--ci")) {
    await runSuite();
    return;
  }
  if (args[0] === "skeleton") {
    await runSkeleton(args.slice(1));
    return;
  }
  await runSingle(parseSingleOptions(args));
}

main()
  .catch((error: unknown) => {
    console.error("Content-discipline eval failed.", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabase();
  });
