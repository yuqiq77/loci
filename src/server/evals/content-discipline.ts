import {
  type MemoryExtractionExchange,
  splitExchangesForExtraction,
} from "@/server/memory/extract";
import { stripJsonCodeFence } from "@/shared/json";

export type PinnedDiaryTurn = {
  role: string;
  content: string;
  completedAt: string;
};

export type DiaryFixtureSources = {
  schemaVersion: 1;
  kind: "diary";
  id: string;
  date: string;
  capturedAt: string;
  timezone: string;
  contamination: "held-out" | "prompt-example";
  // Optional for the MC-114 fixtures captured before source-session
  // provenance was pinned. New captures retain the exact session set so a
  // day fixture can be traced back to the user-selected conversation(s).
  sourceSessionIds?: string[];
  baseline: {
    asOf: string;
    source: "version" | "seed" | "none";
    content: string | null;
    provenance?: string;
  };
  turns: PinnedDiaryTurn[];
  nextDayProbe: {
    windowStart: string;
    userTurn: PinnedDiaryTurn;
  } | null;
};

export type DiaryFixtureLabels = {
  center: {
    description: string;
    markers: string[];
    minEntryShare: number;
  };
  topics: Array<{
    id: string;
    markers: string[];
  }>;
  plainDeltaMarkers: string[];
  thresholdEndingMarkers: string[];
  forbiddenPromptPhrases: string[];
  // Owner-picked concrete details from the day's world (e.g. the backup
  // hazer) whose survival lets the next assistant recognize the user. Small
  // by design — a long list becomes a coverage score and rewards replay.
  recognitionDetails?: string[];
  quietDay: boolean;
  thresholds?: {
    chronicleMinConnectives?: number;
    chronicleMinTopicParagraphRatio?: number;
    quietDayMaxChars?: number;
    quietDayMaxSourceRatio?: number;
  };
};

export type NarrativeFixtureSources = {
  schemaVersion: 1;
  kind: "narrative";
  id: string;
  capturedAt: string;
  mode: "incremental";
  watermark: string;
  sourceThrough: string;
  watermarkProvenance: string;
  tokenBudget: number;
  maxOutputTokens: number;
  currentRecord: string;
  sources: {
    summaries: Array<{
      sessionId: string;
      title: string;
      summary: string;
      cursorCompletedAt: string;
    }>;
    rawTail: Array<{
      id: string;
      sessionId: string;
      sessionTitle: string;
      role: string;
      content: string;
      createdAt: string;
      completedAt: string;
      usedWebSearch: boolean;
    }>;
    memories: Array<{
      id: string;
      content: string;
      kind: string;
      importance: number;
      resolved: boolean;
      pinned: boolean;
      superseded: boolean;
      updatedAt: string;
    }>;
  };
};

export type NarrativeFixtureLabels = {
  keyPhrases: string[];
  stableSections: string[];
  minStableSectionRetention: number;
  maxDayListConnectiveDensity: number;
};

// MC-119 extraction replay: one owner-selected session, paired exactly as the
// live job pairs it, plus the windows production actually cut (from the
// repair audit rows) so the baseline arm replays what production saw.
export type ExtractionFixtureExchange = MemoryExtractionExchange & {
  userCreatedAt: string;
  assistantCompletedAt: string;
};

export type ExtractionFixtureSources = {
  schemaVersion: 1;
  kind: "extraction";
  id: string;
  sessionId: string;
  sessionTitle: string;
  capturedAt: string;
  timezone: string;
  exchanges: ExtractionFixtureExchange[];
  // Null when the session has no audited windows; the production geometry
  // then replays the whole session as one window.
  productionWindows: Array<{
    segment: number;
    throughMessageId: string;
    exchangeCount: number;
    candidateCount: number;
    writtenCount: number;
  }> | null;
};

export type ExtractionFixtureLabels = {
  // Owner-expected memories for the session. An item is covered when any
  // marker appears verbatim in a kept candidate (the diary labels' substring
  // convention, with the same paraphrase blindness — read the candidates,
  // never the number alone).
  expected: Array<{ id: string; markers: string[]; note?: string }>;
  minCoverage: number;
};

// What a replay (or production) would write: the kept candidates only.
export type ExtractionCandidateFile = {
  schemaVersion: 1;
  candidates: Array<{ content: string; kind: string; importance: number }>;
};

export type ExtractionGeometry = "production" | { chunk: number };

export function parseExtractionGeometry(value: string): ExtractionGeometry {
  if (value === "production") {
    return value;
  }
  const match = /^chunk:(\d+)$/u.exec(value);
  const size = match ? Number(match[1]) : Number.NaN;
  if (!Number.isInteger(size) || size < 1) {
    throw new Error("--geometry must be production or chunk:N (N ≥ 1).");
  }
  return { chunk: size };
}

export type ExtractionReplayWindow = {
  label: string;
  exchanges: ExtractionFixtureExchange[];
};

// The windows a geometry sends as separate requests. Production windows are
// cut at the audited boundaries (an audit row's exchange count must match
// the pairing, or the fixture and the audit disagree); the chunk geometry
// splits each production window, which is what a chunked live job would do
// to an episode.
export function extractionReplayWindows(
  sources: ExtractionFixtureSources,
  geometry: ExtractionGeometry,
): ExtractionReplayWindow[] {
  const production: ExtractionReplayWindow[] = [];
  if (sources.productionWindows && sources.productionWindows.length > 0) {
    let start = 0;
    for (const window of sources.productionWindows) {
      const end = sources.exchanges.findIndex(
        (exchange, index) =>
          index >= start &&
          exchange.assistantMessageId === window.throughMessageId,
      );
      if (end < 0) {
        throw new Error(
          `Production window ${window.segment} boundary ${window.throughMessageId} is not an assistant turn in the fixture.`,
        );
      }
      const exchanges = sources.exchanges.slice(start, end + 1);
      if (exchanges.length !== window.exchangeCount) {
        throw new Error(
          `Production window ${window.segment} pairs to ${exchanges.length} exchanges; the audit row says ${window.exchangeCount}.`,
        );
      }
      production.push({ label: String(window.segment), exchanges });
      start = end + 1;
    }
  } else {
    production.push({ label: "1", exchanges: sources.exchanges });
  }
  if (geometry === "production") {
    return production;
  }
  return production.flatMap((window) =>
    splitExchangesForExtraction(window.exchanges, geometry.chunk).map(
      (exchanges, index) => ({
        label: `${window.label}.${index + 1}`,
        exchanges: exchanges as ExtractionFixtureExchange[],
      }),
    ),
  );
}

export function runExtractionChecks(input: {
  candidates: ExtractionCandidateFile["candidates"];
  labels: ExtractionFixtureLabels;
}): MechanicalCheck[] {
  const covered = input.labels.expected.filter((item) =>
    input.candidates.some((candidate) =>
      item.markers.some((marker) => candidate.content.includes(marker)),
    ),
  );
  const missing = input.labels.expected
    .filter((item) => !covered.includes(item))
    .map((item) => item.id);
  const coverage =
    input.labels.expected.length === 0
      ? 1
      : covered.length / input.labels.expected.length;
  return [
    {
      id: "expected-coverage",
      passed: coverage >= input.labels.minCoverage,
      summary: `${covered.length}/${input.labels.expected.length} owner-expected memories covered by ${input.candidates.length} kept candidate(s); floor ${input.labels.minCoverage}.`,
      metrics: {
        expected: input.labels.expected.length,
        covered: covered.length,
        coverage: Number(coverage.toFixed(3)),
        candidates: input.candidates.length,
        missing,
      },
    },
  ];
}

export type MechanicalCheck = {
  id: string;
  passed: boolean;
  // Advisory checks are diagnostics, not gates: they render in reports and
  // are pinned in the manifest, but never count as failures. The MC-115
  // owner-material review demoted chronicle and center-starvation here —
  // both fired on the owner-judged best entries (center_sonnet 08-04/07-10)
  // while missing the entries the owner called chronicle, so their verdicts
  // now belong to the LLM judges and the mechanical numbers stay as hints.
  advisory?: boolean;
  summary: string;
  metrics?: Record<string, number | boolean | string | string[]>;
};

export function hardFailedCheckIds(checks: MechanicalCheck[]): string[] {
  return checks
    .filter((check) => !check.passed && !check.advisory)
    .map((check) => check.id);
}

export function advisoryCheckIds(checks: MechanicalCheck[]): string[] {
  return checks
    .filter((check) => !check.passed && check.advisory)
    .map((check) => check.id);
}

// Replay-only headroom for comparison models whose relay-side reasoning and
// visible answer share max_tokens. Live/default caps stay pinned separately so
// reports can make the intentional eval deviation explicit.
export const DIARY_REPLAY_MIN_OUTPUT_TOKENS = 8_000;
export const NARRATIVE_REPLAY_MIN_OUTPUT_TOKENS = 8_000;

export function diaryReplayMaxOutputTokens(pinned: number): number {
  return Math.max(pinned, DIARY_REPLAY_MIN_OUTPUT_TOKENS);
}

export function narrativeReplayMaxOutputTokens(pinned: number): number {
  return Math.max(pinned, NARRATIVE_REPLAY_MIN_OUTPUT_TOKENS);
}

export const DIARY_REPLAY_SYSTEM_FRAME_V1 = [
  "You are this person's long-term assistant, continuing an established history with them.",
  "Respond directly and naturally to the user's new message as that assistant.",
  "Use any supplied diary entry only as private continuity context; do not write or discuss a diary, memory, evaluation, or analysis unless the user asks.",
].join("\n");

export function parseDiaryFixtureContamination(
  value: string | undefined,
): DiaryFixtureSources["contamination"] {
  if (value === "held-out" || value === "prompt-example") {
    return value;
  }
  throw new Error(
    "Diary fixture contamination must be explicitly set to held-out or prompt-example.",
  );
}

export function requireDiaryNextDayProbe(
  sources: DiaryFixtureSources,
): NonNullable<DiaryFixtureSources["nextDayProbe"]> {
  if (!sources.nextDayProbe) {
    throw new Error(
      `Fixture ${sources.id} has no real D+1 opening; differential judgment is unavailable rather than synthesized.`,
    );
  }
  return sources.nextDayProbe;
}

const CHRONOLOGY_CONNECTIVE =
  /然后|后来|接着|之后|随后|再后来|早上|上午|中午|下午|傍晚|晚上|夜里|最后|\b(?:then|later|afterwards|after that|in the morning|in the afternoon|that evening|finally)\b/giu;
const WITHHOLDING_GESTURE =
  /(?:不(?:想|愿)写(?:更多|下去)?|不写(?:更多|下去)?|写出来.*(?:变小|失真)|无法(?:说|写)|不能(?:说|写)|fade(?:s|d)? to black|leave (?:it|the rest) off the page|too private to write|words (?:would|will) make it smaller)/giu;

function normalized(text: string): string {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, "");
}

function containsMarker(text: string, marker: string): boolean {
  const needle = normalized(marker);
  return needle.length > 0 && normalized(text).includes(needle);
}

function paragraphsOf(text: string): string[] {
  return text
    .trim()
    .split(/\n\s*\n/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

function contentUnitsOf(text: string): string[] {
  return text
    .trim()
    .split(/(?<=[。！？!?；;.])|\n+/u)
    .map((unit) => unit.trim())
    .filter(Boolean);
}

function matchCount(text: string, expression: RegExp): number {
  return [...text.matchAll(expression)].length;
}

function topicParagraphMetric(
  paragraphs: string[],
  topics: DiaryFixtureLabels["topics"],
): { matchedTopics: number; paragraphPerTopicRatio: number } {
  const assignedParagraphs = new Set<number>();
  let matchedTopics = 0;
  for (const topic of topics) {
    const scored = paragraphs
      .map((paragraph, index) => ({
        index,
        markers: topic.markers.filter((marker) =>
          containsMarker(paragraph, marker),
        ).length,
      }))
      .filter(({ markers }) => markers > 0)
      .sort((left, right) => right.markers - left.markers);
    if (scored.length === 0) {
      continue;
    }
    matchedTopics += 1;
    assignedParagraphs.add(scored[0].index);
  }
  return {
    matchedTopics,
    paragraphPerTopicRatio:
      matchedTopics === 0 ? 0 : assignedParagraphs.size / matchedTopics,
  };
}

export function runDiaryMechanicalChecks(input: {
  entry: string;
  sources: DiaryFixtureSources;
  labels: DiaryFixtureLabels;
}): MechanicalCheck[] {
  const paragraphs = paragraphsOf(input.entry);
  const connectiveCount = matchCount(input.entry, CHRONOLOGY_CONNECTIVE);
  const topicMetric = topicParagraphMetric(paragraphs, input.labels.topics);
  const chronicleMinConnectives =
    input.labels.thresholds?.chronicleMinConnectives ?? 3;
  const chronicleMinTopicParagraphRatio =
    input.labels.thresholds?.chronicleMinTopicParagraphRatio ?? 0.6;
  const topicCoverage =
    input.labels.topics.length === 0
      ? 0
      : topicMetric.matchedTopics / input.labels.topics.length;
  const singleParagraphTopicChain =
    paragraphs.length === 1 &&
    topicCoverage >= chronicleMinTopicParagraphRatio;
  const chronicle =
    connectiveCount >= chronicleMinConnectives &&
    (topicMetric.paragraphPerTopicRatio >= chronicleMinTopicParagraphRatio ||
      singleParagraphTopicChain);

  const contentUnits = contentUnitsOf(input.entry);
  const totalChars = contentUnits.reduce(
    (sum, unit) => sum + normalized(unit).length,
    0,
  );
  const centerMarkerIndexes = contentUnits
    .map((unit, index) =>
      input.labels.center.markers.some((marker) => containsMarker(unit, marker))
        ? index
        : -1,
    )
    .filter((index) => index >= 0);
  const centerWindowIndexes = new Set<number>();
  for (const index of centerMarkerIndexes) {
    for (const nearby of [index - 1, index, index + 1]) {
      if (nearby >= 0 && nearby < contentUnits.length) {
        centerWindowIndexes.add(nearby);
      }
    }
  }
  const centerUnits = contentUnits.filter((_, index) =>
    centerWindowIndexes.has(index),
  );
  const centerChars = centerUnits.reduce(
    (sum, unit) => sum + normalized(unit).length,
    0,
  );
  const centerShare = totalChars === 0 ? 0 : centerChars / totalChars;
  const centerStarved =
    centerUnits.length === 0 ||
    centerShare < input.labels.center.minEntryShare;

  const normalizedEntry = normalized(input.entry);
  const thresholdEndingHit = input.labels.thresholdEndingMarkers.find(
    (marker) => {
      // Same empty-needle guard as containsMarker: a punctuation-only marker
      // normalizes to "" and endsWith("") is true for every entry.
      const needle = normalized(marker);
      return needle.length > 0 && normalizedEntry.endsWith(needle);
    },
  );
  const withholdingGesture = WITHHOLDING_GESTURE.test(input.entry);
  WITHHOLDING_GESTURE.lastIndex = 0;
  const plainDeltaHit = input.labels.plainDeltaMarkers.find((marker) =>
    containsMarker(input.entry, marker),
  );
  const thresholdStop =
    (Boolean(thresholdEndingHit) || withholdingGesture) && !plainDeltaHit;

  const sourceChars = input.sources.turns.reduce(
    (sum, turn) => sum + normalized(turn.content).length,
    0,
  );
  const sourceRatio = sourceChars === 0 ? 0 : totalChars / sourceChars;
  const quietMaxChars =
    input.labels.thresholds?.quietDayMaxChars ?? 400;
  const quietMaxSourceRatio =
    input.labels.thresholds?.quietDayMaxSourceRatio ?? 0.35;
  const quietDayInflated =
    input.labels.quietDay &&
    (totalChars > quietMaxChars || sourceRatio > quietMaxSourceRatio);

  const anchorHits = input.labels.forbiddenPromptPhrases.filter((phrase) =>
    containsMarker(input.entry, phrase),
  );

  return [
    {
      id: "chronicle",
      passed: !chronicle,
      advisory: true,
      summary: chronicle
        ? "Clock-order connective density and topic structure crossed the chronicle threshold."
        : "The entry did not cross the chronicle connective/topic-structure criteria.",
      metrics: {
        connectiveCount,
        matchedTopics: topicMetric.matchedTopics,
        topicCoverage,
        paragraphPerTopicRatio: topicMetric.paragraphPerTopicRatio,
        singleParagraphTopicChain,
      },
    },
    {
      id: "center-starvation",
      passed: !centerStarved,
      advisory: true,
      summary: centerStarved
        ? "The owner-labeled center received too little of the entry."
        : "The owner-labeled center received the required share of the entry.",
      metrics: {
        centerMarkerUnits: centerMarkerIndexes.length,
        centerUnits: centerUnits.length,
        centerShare,
        minimum: input.labels.center.minEntryShare,
      },
    },
    {
      id: "threshold-stop",
      passed: !thresholdStop,
      summary: thresholdStop
        ? "The entry withheld or stopped at the threshold without paying the plain-delta toll."
        : "No unpaid withholding/threshold stop was detected.",
      metrics: {
        thresholdEndingHit: thresholdEndingHit ?? "",
        withholdingGesture,
        plainDeltaHit: plainDeltaHit ?? "",
      },
    },
    {
      id: "quiet-day-inflation",
      passed: !quietDayInflated,
      summary: quietDayInflated
        ? "A quiet day was expanded beyond its labeled material allowance."
        : "Quiet-day length is proportionate, or the fixture is not labeled quiet.",
      metrics: { quietDay: input.labels.quietDay, entryChars: totalChars, sourceRatio },
    },
    {
      id: "prompt-anchor-reuse",
      passed: anchorHits.length === 0,
      summary:
        anchorHits.length === 0
          ? "No forbidden prompt-example phrasing was reused."
          : "The candidate reused phrasing from a contaminated prompt example.",
      metrics: { anchorHits },
    },
  ];
}

function markdownSections(text: string): Map<string, string> {
  const sections = new Map<string, string>();
  let heading = "(preamble)";
  let lines: string[] = [];
  const flush = () => {
    if (lines.length > 0 || heading !== "(preamble)") {
      sections.set(heading, lines.join("\n").trim());
    }
  };
  for (const line of text.split("\n")) {
    const match = /^#{2,3}\s+(.+?)\s*$/u.exec(line);
    if (match) {
      flush();
      heading = match[1];
      lines = [];
    } else {
      lines.push(line);
    }
  }
  flush();
  return sections;
}

function ngrams(text: string, size = 3): Set<string> {
  const value = normalized(text);
  const result = new Set<string>();
  if (value.length <= size) {
    if (value) result.add(value);
    return result;
  }
  for (let index = 0; index <= value.length - size; index += 1) {
    result.add(value.slice(index, index + size));
  }
  return result;
}

function retainedNgramRatio(before: string, after: string): number {
  const prior = ngrams(before);
  if (prior.size === 0) return 1;
  const next = ngrams(after);
  let retained = 0;
  for (const gram of prior) {
    if (next.has(gram)) retained += 1;
  }
  return retained / prior.size;
}

export function runNarrativeMechanicalChecks(input: {
  candidate: string;
  sources: NarrativeFixtureSources;
  labels: NarrativeFixtureLabels;
}): MechanicalCheck[] {
  const priorSections = markdownSections(input.sources.currentRecord);
  const candidateSections = markdownSections(input.candidate);
  const sectionRetention: Record<string, number> = {};
  for (const [section, before] of priorSections) {
    sectionRetention[section] = retainedNgramRatio(
      before,
      candidateSections.get(section) ?? "",
    );
  }
  const unstableSections = input.labels.stableSections.filter(
    (section) =>
      (sectionRetention[section] ?? 0) < input.labels.minStableSectionRetention,
  );
  const missingKeyPhrases = input.labels.keyPhrases.filter(
    (phrase) => !containsMarker(input.candidate, phrase),
  );
  const dateHeadings = [
    ...input.candidate.matchAll(
      /^#{2,4}\s+(?:(?:19|20)\d{2}[-/.]\d{1,2}[-/.]\d{1,2}|(?:19|20)\d{2}年\d{1,2}月\d{1,2}日|\d{1,2}月\d{1,2}日|(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)?\s*(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:st|nd|rd|th)?)(?=\s|$|[：:—-])/gimu,
    ),
  ].map((match) => match[0]);
  const narrativeLayers = ["Recent", "Earlier", "Long-term"]
    .map((section) => candidateSections.get(section) ?? "")
    .filter(Boolean)
    .join("\n\n");
  const narrativeText = narrativeLayers || input.candidate;
  const connectiveCount = matchCount(narrativeText, CHRONOLOGY_CONNECTIVE);
  const paragraphCount = Math.max(paragraphsOf(narrativeText).length, 1);
  const dayListConnectiveDensity = connectiveCount / paragraphCount;

  return [
    {
      id: "section-stability",
      passed: unstableSections.length === 0,
      summary:
        unstableSections.length === 0
          ? "Owner-labeled stable sections retained enough prior wording."
          : "One or more sections expected to stay stable churned too far.",
      metrics: {
        unstableSections,
        minimum: input.labels.minStableSectionRetention,
        ...sectionRetention,
      },
    },
    {
      id: "key-phrase-retention",
      passed: missingKeyPhrases.length === 0,
      summary:
        missingKeyPhrases.length === 0
          ? "All owner-labeled recent key phrases survived."
          : "Owner-labeled recent material disappeared from the replacement record.",
      metrics: { missingKeyPhrases },
    },
    {
      id: "date-headed-entries",
      passed: dateHeadings.length === 0,
      summary:
        dateHeadings.length === 0
          ? "No date-headed diary-form entries were found."
          : "The narrative contains date-headed diary-form entries.",
      metrics: { dateHeadings },
    },
    {
      id: "day-list-connectives",
      passed:
        dayListConnectiveDensity <=
        input.labels.maxDayListConnectiveDensity,
      summary:
        dayListConnectiveDensity <= input.labels.maxDayListConnectiveDensity
          ? "Chronological connective density stayed below the day-list threshold."
          : "Chronological connective density crossed the day-list threshold.",
      metrics: {
        connectiveCount,
        paragraphCount,
        dayListConnectiveDensity,
        maximum: input.labels.maxDayListConnectiveDensity,
      },
    },
  ];
}

const RECENT_CARRY_CURRENT = [
  "    append when something changed; let episodic detail fade — fading means",
  "    lower resolution in place, never a dropped stretch of time; the full",
  "    texture stays recoverable in the memory rows and raw history.",
  "  - Rewrite recent by carrying it forward, exactly as you carry earlier and",
  "    long-term: recent is the existing recent — thinned in place as it ages —",
  "    with the new days woven in, not a fresh essay about the newest day.",
  "    Content leaves recent only by graduating to earlier once it is weeks",
  "    old, or by thinning to lower detail in place. Wholesale replacement of",
  "    recent with the latest day is the conveyor error one layer up: a week",
  "    of your history together silently disappears from the record.",
].join("\n");
const RECENT_CARRY_PRE_AMENDMENT = [
  "    append when something changed; let episodic detail fade — it stays",
  "    recoverable in the memory rows and raw history.",
].join("\n");

export function toPreRecentCarryPrompt(prompt: string): string {
  if (!prompt.includes(RECENT_CARRY_CURRENT)) {
    throw new Error(
      "Current narrative prompt no longer matches the pinned pre-amendment transform.",
    );
  }
  return prompt.replace(
    RECENT_CARRY_CURRENT,
    RECENT_CARRY_PRE_AMENDMENT,
  );
}

const SHORTEN_CARRY_CURRENT = [
  "specifics into arcs rather than deleting a layer or dropping a stretch of",
  "time from one. Keep the record's language, voice, and register — do not",
].join("\n");
const SHORTEN_CARRY_PRE_AMENDMENT = [
  "specifics into arcs rather than deleting a layer. Keep the record's",
  "language, voice, and register — do not",
].join("\n");

export function toPreRecentCarryShortenPrompt(prompt: string): string {
  if (!prompt.includes(SHORTEN_CARRY_CURRENT)) {
    throw new Error(
      "Current shorten prompt no longer matches the pinned pre-amendment transform.",
    );
  }
  return prompt.replace(
    SHORTEN_CARRY_CURRENT,
    SHORTEN_CARRY_PRE_AMENDMENT,
  );
}

// The minimal/minimal-center diary prompt won its MC-115 replay and moved
// to summaries/diary.ts as the live prompt (2026-08-30); re-exported here
// so the eval runner and tests keep their import path.
export { buildMinimalDiaryPrompt } from "@/server/summaries/diary";

export function renderPromptTemplate(
  template: string,
  values: Record<string, string>,
): string {
  let rendered = template;
  for (const [name, value] of Object.entries(values)) {
    rendered = rendered.split(`{{${name}}}`).join(value);
  }
  const unresolved = rendered.match(/\{\{[A-Z0-9_]+\}\}/gu);
  if (unresolved) {
    throw new Error(`Unresolved prompt placeholders: ${unresolved.join(", ")}`);
  }
  return rendered;
}

export type DifferentialJudgeResult = {
  withEntryUsesDelta: boolean;
  withoutEntryUsesDelta: boolean;
  materiallyDifferent: boolean;
  pass: boolean;
  reason: string;
};

export function parseDifferentialJudgeResult(
  output: string,
): DifferentialJudgeResult {
  let value: unknown;
  try {
    value = JSON.parse(stripJsonCodeFence(output));
  } catch {
    throw new Error("Differential judge output is not valid JSON.");
  }
  if (!value || typeof value !== "object") {
    throw new Error("Differential judge output does not have the expected shape.");
  }
  const row = value as Record<string, unknown>;
  if (
    typeof row.with_entry_uses_delta !== "boolean" ||
    typeof row.without_entry_uses_delta !== "boolean" ||
    typeof row.materially_different !== "boolean" ||
    typeof row.pass !== "boolean" ||
    typeof row.reason !== "string"
  ) {
    throw new Error("Differential judge output does not have the expected shape.");
  }
  const derivedPass =
    row.with_entry_uses_delta &&
    !row.without_entry_uses_delta &&
    row.materially_different;
  if (row.pass !== derivedPass) {
    throw new Error("Differential judge output has an inconsistent pass value.");
  }
  return {
    withEntryUsesDelta: row.with_entry_uses_delta,
    withoutEntryUsesDelta: row.without_entry_uses_delta,
    materiallyDifferent: row.materially_different,
    pass: row.pass,
    reason: row.reason,
  };
}

// Judge models deliberate and self-revise: observed live output was prose
// plus two fenced JSON blocks, the last one the real verdict. Take the last
// parseable JSON candidate; shape validation still rejects garbage.
function extractFinalJson(output: string): string {
  const fenced = [...output.matchAll(/```(?:json)?\s*([\s\S]*?)```/gu)].map(
    (match) => match[1].trim(),
  );
  const candidates = fenced.length > 0 ? fenced : [stripJsonCodeFence(output)];
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    try {
      JSON.parse(candidates[index]);
      return candidates[index];
    } catch {
      // keep scanning earlier candidates
    }
  }
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return output.slice(start, end + 1);
  }
  return output;
}

// The MC-115 owner-material review reduced every rank-changing diary defect
// to four hard-error classes; the factuality judge is scoped to exactly
// these so it cannot drift into policing compression or style.
const FACTUALITY_ERROR_CLASSES = [
  "attribution",
  "direction",
  "chronology",
  "frame",
] as const;

type FactualityErrorClass = (typeof FACTUALITY_ERROR_CLASSES)[number];

export type FactualityJudgeResult = {
  hardErrors: Array<{
    class: FactualityErrorClass;
    diaryQuote: string;
    sourceEvidence: string;
    explanation: string;
  }>;
  pass: boolean;
  note: string;
};

export function parseFactualityJudgeResult(
  output: string,
): FactualityJudgeResult {
  let value: unknown;
  try {
    value = JSON.parse(extractFinalJson(output));
  } catch {
    throw new Error("Factuality judge output is not valid JSON.");
  }
  if (!value || typeof value !== "object") {
    throw new Error("Factuality judge output does not have the expected shape.");
  }
  const row = value as Record<string, unknown>;
  if (
    !Array.isArray(row.hard_errors) ||
    typeof row.pass !== "boolean" ||
    typeof row.note !== "string"
  ) {
    throw new Error("Factuality judge output does not have the expected shape.");
  }
  const hardErrors = row.hard_errors.map((item) => {
    if (!item || typeof item !== "object") {
      throw new Error("Factuality judge error row is malformed.");
    }
    const error = item as Record<string, unknown>;
    if (
      typeof error.class !== "string" ||
      !FACTUALITY_ERROR_CLASSES.includes(
        error.class as FactualityErrorClass,
      ) ||
      typeof error.diary_quote !== "string" ||
      typeof error.source_evidence !== "string" ||
      typeof error.explanation !== "string"
    ) {
      throw new Error("Factuality judge error row is malformed.");
    }
    return {
      class: error.class as FactualityErrorClass,
      diaryQuote: error.diary_quote,
      sourceEvidence: error.source_evidence,
      explanation: error.explanation,
    };
  });
  if (row.pass !== (hardErrors.length === 0)) {
    throw new Error("Factuality judge output has an inconsistent pass value.");
  }
  return { hardErrors, pass: row.pass, note: row.note };
}

// Bucketed on purpose: under the observed sampling variance an exact center
// share is noise, while absent/passing/paragraph/structural stays stable.
const CENTER_BUCKETS = [
  "absent",
  "passing",
  "paragraph",
  "structural",
] as const;

type CenterBucket = (typeof CENTER_BUCKETS)[number];

export type CenterJudgeResult = {
  centerBucket: CenterBucket;
  centerEvidence: string;
  selectivity: "selective" | "even-replay";
  selectivityNote: string;
  recognitionRetained: string[];
  recognitionMissing: string[];
  pass: boolean;
  reason: string;
};

export function parseCenterJudgeResult(
  output: string,
  expectedRecognitionDetails: string[],
): CenterJudgeResult {
  let value: unknown;
  try {
    value = JSON.parse(extractFinalJson(output));
  } catch {
    throw new Error("Center judge output is not valid JSON.");
  }
  if (!value || typeof value !== "object") {
    throw new Error("Center judge output does not have the expected shape.");
  }
  const row = value as Record<string, unknown>;
  const isStringArray = (item: unknown): item is string[] =>
    Array.isArray(item) && item.every((entry) => typeof entry === "string");
  if (
    typeof row.center_bucket !== "string" ||
    !CENTER_BUCKETS.includes(row.center_bucket as CenterBucket) ||
    typeof row.center_evidence !== "string" ||
    (row.selectivity !== "selective" && row.selectivity !== "even-replay") ||
    typeof row.selectivity_note !== "string" ||
    !isStringArray(row.recognition_retained) ||
    !isStringArray(row.recognition_missing) ||
    typeof row.pass !== "boolean" ||
    typeof row.reason !== "string"
  ) {
    throw new Error("Center judge output does not have the expected shape.");
  }
  const partitioned = [...row.recognition_retained, ...row.recognition_missing]
    .slice()
    .sort();
  const expected = expectedRecognitionDetails.slice().sort();
  if (JSON.stringify(partitioned) !== JSON.stringify(expected)) {
    throw new Error(
      "Center judge output does not partition the recognition details.",
    );
  }
  const derivedPass =
    row.center_bucket === "paragraph" || row.center_bucket === "structural";
  if (row.pass !== derivedPass) {
    throw new Error("Center judge output has an inconsistent pass value.");
  }
  return {
    centerBucket: row.center_bucket as CenterBucket,
    centerEvidence: row.center_evidence,
    selectivity: row.selectivity,
    selectivityNote: row.selectivity_note,
    recognitionRetained: row.recognition_retained,
    recognitionMissing: row.recognition_missing,
    pass: row.pass,
    reason: row.reason,
  };
}

type SkeletonSeriesPhrase = {
  phrase: string;
  entryIds: string[];
};

// Cross-entry template detector: a normalized phrase that recurs in entries
// from different days but appears in none of those days' sources cannot be
// memory — it is prompt skeleton. prompt-anchor-reuse catches known phrases;
// this catches new families the way the first recurring template sentence
// was caught by eye across dates. Phrases are reported in normalized form (lowercased,
// punctuation and whitespace stripped).
export function findSkeletonSeries(
  entries: Array<{ id: string; entry: string; sourceText: string }>,
  options: { minLength?: number } = {},
): SkeletonSeriesPhrase[] {
  const minLength = options.minLength ?? 6;
  const normalizedEntries = entries.map((item) => ({
    id: item.id,
    text: normalized(item.entry),
  }));
  const normalizedSources = entries.map((item) => normalized(item.sourceText));
  const inAnySource = (phrase: string): boolean =>
    normalizedSources.some((source) => source.includes(phrase));
  const found = new Map<string, Set<string>>();

  for (let index = 0; index < normalizedEntries.length; index += 1) {
    const { text } = normalizedEntries[index];
    const others = normalizedEntries.filter((_, other) => other !== index);
    let position = 0;
    while (position + minLength <= text.length) {
      const occursElsewhere = (length: number): boolean => {
        const candidate = text.slice(position, position + length);
        return others.some((other) => other.text.includes(candidate));
      };
      if (!occursElsewhere(minLength)) {
        position += 1;
        continue;
      }
      let low = minLength;
      let high = text.length - position;
      while (low < high) {
        const middle = Math.ceil((low + high + 1) / 2);
        if (occursElsewhere(middle)) {
          low = middle;
        } else {
          high = middle - 1;
        }
      }
      const phrase = text.slice(position, position + low);
      if (!inAnySource(phrase)) {
        const holders = new Set<string>();
        for (const item of normalizedEntries) {
          if (item.text.includes(phrase)) {
            holders.add(item.id);
          }
        }
        if (holders.size >= 2) {
          const existing = found.get(phrase);
          if (existing) {
            for (const id of holders) existing.add(id);
          } else {
            found.set(phrase, holders);
          }
        }
      }
      position += low;
    }
  }

  const phrases = [...found.entries()]
    .map(([phrase, ids]) => ({ phrase, entryIds: [...ids].sort() }))
    .sort(
      (left, right) =>
        right.phrase.length - left.phrase.length ||
        left.phrase.localeCompare(right.phrase),
    );
  const kept: SkeletonSeriesPhrase[] = [];
  for (const candidate of phrases) {
    const subsumed = kept.some(
      (keeper) =>
        keeper.phrase.includes(candidate.phrase) &&
        candidate.entryIds.every((id) => keeper.entryIds.includes(id)),
    );
    if (!subsumed) {
      kept.push(candidate);
    }
  }
  return kept;
}
