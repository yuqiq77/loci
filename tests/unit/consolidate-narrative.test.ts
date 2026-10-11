import { describe, expect, it, vi } from "vitest";

import {
  buildContinuityCapsule,
  CONTINUITY_CAPSULE_CHROME_TOKENS,
  estimateTextTokens,
} from "@/server/chat/context";
import { effectiveStandingContext } from "@/server/db/narrative";
import {
  capsuleBudgetRefusal,
  compressionWriteCap,
  narrativeWriteCap,
  requiredCapsuleTokens,
  SUMMARY_TOKEN_BUDGET,
} from "@/server/summaries/narrative-budget";
import {
  buildConsolidationPrompt,
  buildRawTail,
  buildResolutionReviewPrompt,
  buildShortenRetryPrompt,
  generateBudgetedNarrative,
  parseResolutionReview,
  stripExcludedSections,
  type ConsolidationSources,
  type RawTailMessage,
} from "@/server/summaries/consolidate-narrative";
import { PERSON_REFERENCE_RULE } from "@/server/summaries/writer-voice";

function rawTailMessage(
  overrides: Partial<RawTailMessage> & { id: string },
): RawTailMessage {
  return {
    sessionId: "session-1",
    sessionTitle: "Chat",
    role: "user",
    content: "hello",
    createdAt: new Date("2026-07-07T10:00:00Z"),
    completedAt: new Date("2026-07-07T10:00:00Z"),
    usedWebSearch: false,
    ...overrides,
  };
}

const emptySources: ConsolidationSources = {
  summaries: [],
  rawTail: [],
  memories: [],
  rawTailDropped: [],
};

describe("buildConsolidationPrompt", () => {
  const sources: ConsolidationSources = {
    rawTailDropped: [],
    summaries: [
      {
        sessionId: "session-1",
        title: "Long thread",
        summary: "We worked through the retrieval gates.",
        cursorCompletedAt: new Date("2026-07-07T09:00:00Z"),
      },
    ],
    rawTail: [
      rawTailMessage({
        id: "message-1",
        content: "the sample project demo",
        completedAt: new Date("2026-07-07T10:00:00Z"),
      }),
    ],
    memories: [
      {
        id: "memory-1",
        content: "They described the sample project.",
        kind: "shared_moment",
        importance: 0.8,
        resolved: true,
        pinned: false,
        superseded: false,
        updatedAt: new Date("2026-07-07T10:30:00Z"),
      },
    ],
  };

  it("emits the §4 headings minus ## Current and ## Anchors (D12/D20)", () => {
    const prompt = buildConsolidationPrompt({
      mode: "incremental",
      currentRecord: "## Profile\nRiley manages the sample project.",
      tokenBudget: 2000,
      sources,
    });

    for (const heading of [
      "## Profile",
      "## Principles",
      "## Approach",
      "## Narrative",
    ]) {
      expect(prompt).toContain(heading);
    }
    expect(prompt).toContain("Never output a ## Current section");
    expect(prompt).toContain("Never output a ## Anchors section");
    expect(prompt).toContain("into Narrative by name");
    expect(prompt).not.toMatch(/##\s+(Current|Anchors)\s+—/u);
  });

  it("states the D15 language rules and the voice convention", () => {
    const prompt = buildConsolidationPrompt({
      mode: "incremental",
      currentRecord: "",
      tokenBudget: 2000,
      sources,
    });

    expect(prompt).toContain(
      "Write the record in the language of the current record",
    );
    expect(prompt).toContain(
      "Any verbatim quote you keep stays in its original language",
    );
    expect(prompt).toContain("never translated, never paraphrased");
    expect(prompt).toContain(PERSON_REFERENCE_RULE);
    expect(prompt).toContain('refer to yourself as "I"');
    // No name for the assistant: neither the frame nor the default system
    // prompt assigns one, so Profile/Principles leave it out.
    expect(prompt).toContain("never with \"I\" or a name for yourself");
    expect(prompt).not.toContain("Claude");
  });

  it("asks for a prose Profile and caps P/P/A at a third of the budget", () => {
    const prompt = buildConsolidationPrompt({
      mode: "incremental",
      currentRecord: "",
      tokenBudget: 2000,
      sources,
    });

    expect(prompt).toContain("compact flowing third-person prose");
    expect(prompt).toContain("not a bullet");
    expect(prompt).toContain("this is a person, not a CRM record");
    expect(prompt).toContain("together at most about a");
    expect(prompt).toContain("The budget exists for the Narrative layers.");
  });

  it("encodes the growth trade-off: re-narration gradient, not deletion", () => {
    const prompt = buildConsolidationPrompt({
      mode: "incremental",
      currentRecord: "",
      tokenBudget: 2000,
      sources,
    });

    expect(prompt).toContain("it is a re-narration, not an archive");
    // Graduation is age-triggered, not fold-triggered: the conveyor-belt
    // reading (yesterday demotes on every run) is explicitly forbidden.
    expect(prompt).toContain("stays there until it is weeks old");
    expect(prompt).toContain("come back unchanged");
    expect(prompt).toContain("is an error");
    // Layer order is load-bearing: both trim paths cut the section from the
    // end, so oldest-first trimming requires oldest-last ordering.
    expect(prompt).toContain(
      "in exactly three layers, never a fourth, each anchored to a",
    );
    expect(prompt).toContain("newest at the top, oldest at the bottom");
    // The layer headings are contract, not emergent: the content-discipline
    // section-stability check keys on exactly these three headings.
    expect(prompt).toContain("### Recent, ### Earlier, ### Long-term");
    expect(prompt).toContain("Promote what proved durable into");
    expect(prompt).toContain("replace rather than");
    expect(prompt).toContain(
      "recoverable in the memory rows and raw",
    );
    expect(prompt).toContain("thin the Narrative layers in place");
  });

  it("carries recent forward instead of replacing it with the newest day", () => {
    const prompt = buildConsolidationPrompt({
      mode: "incremental",
      currentRecord: "",
      tokenBudget: 2000,
      sources,
    });

    // Dogfooded (v7 → v8): with earlier/long-term pinned by the
    // age-graduation rule, the model rewrote recent from the new sources
    // alone — the previous recent vanished from the record
    // while every other section came back carried forward. recent needs the
    // same explicit carry rule the other sections have; its only exits are
    // graduation and in-place thinning.
    expect(prompt).toContain("Rewrite recent by carrying it forward");
    expect(prompt).toContain("not a fresh essay about the newest day");
    expect(prompt).toContain("Wholesale replacement");
    expect(prompt).toContain("conveyor error one layer up");
    // The fade license is bounded: lower resolution in place, never a
    // dropped stretch of time.
    expect(prompt).toContain("never a dropped stretch of time");
  });

  it("carries no register instruction beyond the sources", () => {
    const prompt = buildConsolidationPrompt({
      mode: "incremental",
      currentRecord: "",
      tokenBudget: 2000,
      sources,
    });

    expect(prompt).not.toContain("private to the two of you");
    expect(prompt).not.toContain("fade to black");
    expect(prompt).not.toContain("Frank, not gratuitous");
  });

  it("anchors the layers to time horizons and forbids per-day entries (MC-111)", () => {
    const prompt = buildConsolidationPrompt({
      mode: "incremental",
      currentRecord: "",
      tokenBudget: 2000,
      sources,
    });

    // The three layers are defined by time horizon, not fold order — the
    // dogfooded failure mode was a day-granularity conveyor (recent =
    // yesterday, an invented "earlier still" tier, day residue in long-term).
    expect(prompt).toContain("recent (roughly the");
    expect(prompt).toContain("last couple of weeks) first, then earlier (roughly the");
    expect(prompt).toContain("months before that), then long-term (the whole arc of your");
    expect(prompt).toContain("time horizons, not a conveyor of days");
    expect(prompt).toContain("date-headed or per-day entries");
    expect(prompt).toContain("day granularity lives in a separate");
    expect(prompt).toContain("Weave time references into the prose");
  });

  it("wires the current record, token budget, and incremental sources", () => {
    const prompt = buildConsolidationPrompt({
      mode: "incremental",
      currentRecord: "## Profile\nSeed from standing context.",
      tokenBudget: 1500,
      sources,
    });

    expect(prompt).toContain("Seed from standing context.");
    // The target is stated as set, in estimator units (MC-121): no
    // per-model conversion — the write cap absorbs the writer's bias.
    expect(prompt).toContain("~1500 tokens");
    expect(prompt).toContain("We worked through the retrieval gates.");
    expect(prompt).toContain("the sample project demo");
    expect(prompt).toContain("They described the sample project.");
    expect(prompt).toContain("superseded=false");
    expect(prompt).toContain("since the last consolidation");
  });

  it("renders rebuild with an empty record and raw-history labels", () => {
    const prompt = buildConsolidationPrompt({
      mode: "rebuild",
      currentRecord: "",
      tokenBudget: 2000,
      sources: { ...sources, summaries: [] },
    });

    expect(prompt).toContain("<record>\n(none)\n</record>");
    expect(prompt).toContain("Raw conversation history (chronological):");
    expect(prompt).toContain("All memory rows:");
    expect(prompt).not.toContain("Session summaries covering conversation");
  });
});

describe("buildRawTail", () => {
  const budget = 10_000;

  it("drops web-search assistant turns but keeps the user's own turns", () => {
    const search = rawTailMessage({
      id: "message-2",
      role: "assistant",
      usedWebSearch: true,
      content: "search-derived answer",
    });
    const user = rawTailMessage({
      id: "message-1",
      role: "user",
      usedWebSearch: false,
      content: "what changed in the sample project?",
    });
    const userWithSearchFlag = rawTailMessage({
      id: "message-3",
      role: "user",
      usedWebSearch: true,
      content: "flag should not matter for user turns",
    });

    const { tail, dropped } = buildRawTail({
      messages: [user, search, userWithSearchFlag],
      coverageCursors: new Map(),
      budget,
      scope: "total",
    });

    expect(tail.map((message) => message.id)).toEqual([
      "message-1",
      "message-3",
    ]);
    expect(dropped).toEqual([]);
  });

  it("drops turns covered by an included summary, per session", () => {
    const cursor = {
      id: "message-2",
      role: "assistant",
      createdAt: new Date("2026-07-07T10:00:01Z"),
    };
    const covered = rawTailMessage({
      id: "message-1",
      sessionId: "session-1",
      createdAt: new Date("2026-07-07T10:00:00Z"),
    });
    const atCursor = rawTailMessage({
      id: "message-2",
      sessionId: "session-1",
      role: "assistant",
      createdAt: new Date("2026-07-07T10:00:01Z"),
    });
    const afterCursor = rawTailMessage({
      id: "message-3",
      sessionId: "session-1",
      createdAt: new Date("2026-07-07T11:00:00Z"),
    });
    const otherSession = rawTailMessage({
      id: "message-0",
      sessionId: "session-2",
      createdAt: new Date("2026-07-07T09:00:00Z"),
    });

    const { tail } = buildRawTail({
      messages: [otherSession, covered, atCursor, afterCursor],
      coverageCursors: new Map([["session-1", cursor]]),
      budget,
      scope: "total",
    });

    expect(tail.map((message) => message.id)).toEqual([
      "message-0",
      "message-3",
    ]);
  });

  it("caps newest-first so the oldest turns drop, presenting chronologically", () => {
    const oldest = rawTailMessage({
      id: "message-1",
      content: "a".repeat(300),
      createdAt: new Date("2026-07-07T09:00:00Z"),
    });
    const middle = rawTailMessage({
      id: "message-2",
      content: "b".repeat(300),
      createdAt: new Date("2026-07-07T10:00:00Z"),
    });
    const newest = rawTailMessage({
      id: "message-3",
      content: "c".repeat(300),
      createdAt: new Date("2026-07-07T11:00:00Z"),
    });

    // 300 chars ≈ 100 tokens each; a 200-token budget keeps the newest two
    // and reports the one it dropped.
    const { tail, dropped } = buildRawTail({
      messages: [oldest, middle, newest],
      coverageCursors: new Map(),
      budget: 200,
      scope: "total",
    });

    expect(tail.map((message) => message.id)).toEqual([
      "message-2",
      "message-3",
    ]);
    expect(dropped).toEqual([
      { sessionId: null, turns: 1, tokens: estimateTextTokens(oldest.content) },
    ]);
  });

  it("caps each session on its own under session scope and reports per session", () => {
    // 300 chars ≈ 100 tokens each. A 200-token cap per session keeps every
    // turn of session-2 though the day's tail is 500 tokens; session-1 drops
    // only its own oldest turn, and the drop names the session.
    const turn = (id: string, sessionId: string, hour: number) =>
      rawTailMessage({
        id,
        sessionId,
        content: id.repeat(300),
        createdAt: new Date(
          `2026-07-07T${String(hour).padStart(2, "0")}:00:00Z`,
        ),
      });
    const { tail, dropped } = buildRawTail({
      messages: [
        turn("a", "session-1", 8),
        turn("b", "session-2", 9),
        turn("c", "session-1", 10),
        turn("d", "session-2", 11),
        turn("e", "session-1", 12),
      ],
      coverageCursors: new Map(),
      budget: 200,
      scope: "session",
    });

    expect(tail.map((message) => message.id)).toEqual(["b", "c", "d", "e"]);
    expect(dropped).toEqual([
      {
        sessionId: "session-1",
        turns: 1,
        tokens: estimateTextTokens("a".repeat(300)),
      },
    ]);
  });

  it("always keeps the newest turn even when it alone exceeds the budget", () => {
    const { tail, dropped } = buildRawTail({
      messages: [
        rawTailMessage({ id: "message-1", content: "x".repeat(3000) }),
      ],
      coverageCursors: new Map(),
      budget: 10,
      scope: "total",
    });

    expect(tail.map((message) => message.id)).toEqual(["message-1"]);
    expect(dropped).toEqual([]);
  });
});

describe("stripExcludedSections", () => {
  it("removes ## Current and ## Anchors sections wherever they appear", () => {
    const record = [
      "## Profile",
      "Riley manages the sample project.",
      "",
      "## Current",
      "Working on MC-101R this week.",
      "",
      "## Anchors",
      '"measure before optimizing"',
      "",
      "## Narrative",
      "The prototype review closed today.",
    ].join("\n");

    const stripped = stripExcludedSections(record);

    expect(stripped).not.toContain("## Current");
    expect(stripped).not.toContain("Working on MC-101R");
    expect(stripped).not.toContain("## Anchors");
    expect(stripped).not.toContain('"measure before optimizing"');
    expect(stripped).toContain("## Profile");
    expect(stripped).toContain("The prototype review closed today.");
  });

  it("leaves records without excluded sections untouched", () => {
    const record = "## Profile\nRiley manages the sample project.";
    expect(stripExcludedSections(record)).toBe(record);
  });
});

describe("generateBudgetedNarrative", () => {
  function streamOf(...outputs: string[]) {
    const stream = vi.fn();
    for (const output of outputs) {
      stream.mockImplementationOnce(async function* () {
        yield { type: "text", text: output };
        yield { type: "done", finishReason: "end_turn" };
      });
    }
    return stream;
  }
  const countTokens = async (text: string) => text.length;

  it("identifies a max_tokens failure in the initial generation stage", async () => {
    const stream = vi.fn(async function* () {
      yield { type: "text" as const, text: "## Narrative\nTruncated." };
      yield { type: "done" as const, finishReason: "max_tokens" };
    });

    await expect(
      generateBudgetedNarrative({
        provider: { stream },
        model: "consolidation-test",
        prompt: "prompt",
        targetTokens: 1000,
        maxOutputTokens: 2000,
        countTokens,
      }),
    ).rejects.toThrow(
      "Narrative initial generation failed: Compression output ended early (finish reason: max_tokens).",
    );
  });

  it("returns the first output untouched when it fits", async () => {
    const record = "## Narrative\nShort record.";
    const stream = streamOf(record);

    const result = await generateBudgetedNarrative({
      provider: { stream },
      model: "consolidation-test",
      prompt: "prompt",
      targetTokens: 1000,
      maxOutputTokens: 2000,
      countTokens,
    });

    expect(result).toEqual({
      content: record,
      rawOutput: record,
      retried: false,
      hardTrimmed: false,
    });
    expect(stream).toHaveBeenCalledTimes(1);
    // The offline writer carries the writer identity frame — without it the
    // model is a clerk summarizing someone else's transcript.
    const request = stream.mock.calls[0][0] as {
      messages: { role: string; content: string }[];
    };
    expect(request.messages[0].role).toBe("system");
    expect(request.messages[0].content).toContain(
      "your own working memory",
    );
  });

  it("keeps an over-target record inside the cap without a retry", async () => {
    // 130 characters: over the 100 target, inside the 150 cap — the writer's
    // unit bias, not a runaway, so it is stored as written.
    const record = `## Narrative\n${"x".repeat(117)}`;
    const stream = streamOf(record);

    const result = await generateBudgetedNarrative({
      provider: { stream },
      model: "consolidation-test",
      prompt: "prompt",
      targetTokens: 100,
      maxOutputTokens: 2000,
      countTokens,
    });

    expect(result).toMatchObject({
      content: record,
      retried: false,
      hardTrimmed: false,
    });
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it("shorten-retries an over-budget output before the hard trim", async () => {
    const oversized = `## Narrative\n${"recent. ".repeat(40)}`;
    const shortened = "## Narrative\nThinned in place.";
    const stream = streamOf(oversized, shortened);

    const result = await generateBudgetedNarrative({
      provider: { stream },
      model: "consolidation-test",
      prompt: "prompt",
      targetTokens: 100,
      maxOutputTokens: 2000,
      countTokens,
    });

    expect(result.retried).toBe(true);
    expect(result.content).toBe(shortened);
    // Recovered by the retry: the saturation tripwire stays quiet.
    expect(result.hardTrimmed).toBe(false);
    expect(stream).toHaveBeenCalledTimes(2);
    const retryPrompt = (
      stream.mock.calls[1][0] as { messages: { content: string }[] }
    ).messages.at(-1)!.content;
    // Over the cap (100 × 1.5 = 150), so the retry fired; it asks for the
    // target again, not the cap.
    expect(retryPrompt).toContain("~100 tokens");
    expect(retryPrompt).toContain("layer in place");
    expect(retryPrompt).toContain(oversized.trim());
  });

  it("hard-trims as the backstop when the retry still overshoots", async () => {
    const oversized = `## Narrative\n${"recent. ".repeat(40)}`;
    const stillOversized = `## Narrative\n${"arc. ".repeat(40)}`;
    const stream = streamOf(oversized, stillOversized);

    const result = await generateBudgetedNarrative({
      provider: { stream },
      model: "consolidation-test",
      prompt: "prompt",
      targetTokens: 60,
      maxOutputTokens: 2000,
      countTokens,
    });

    expect(result.retried).toBe(true);
    // The trimmer actually cut — at the cap (60 × 1.5 = 90), not the
    // target: the saturation tripwire fires.
    expect(result.hardTrimmed).toBe(true);
    expect(result.content.length).toBeLessThanOrEqual(90);
    expect(result.content.length).toBeGreaterThan(60);
    expect(result.content).toContain("## Narrative");
  });

  it("strips excluded sections from both attempts", async () => {
    const withAnchors = [
      "## Narrative",
      "x".repeat(200),
      "",
      "## Anchors",
      '"quote"',
    ].join("\n");
    const shortenedWithCurrent = [
      "## Narrative",
      "Thin.",
      "",
      "## Current",
      "stale",
    ].join("\n");
    const stream = streamOf(withAnchors, shortenedWithCurrent);

    const result = await generateBudgetedNarrative({
      provider: { stream },
      model: "consolidation-test",
      prompt: "prompt",
      targetTokens: 100,
      maxOutputTokens: 2000,
      countTokens,
    });

    expect(result.content).toBe("## Narrative\nThin.");
    const retryPrompt = (
      stream.mock.calls[1][0] as { messages: { content: string }[] }
    ).messages.at(-1)!.content;
    expect(retryPrompt).not.toContain("## Anchors");
  });
});

describe("buildShortenRetryPrompt", () => {
  it("asks for in-place layer thinning at the budget", () => {
    const prompt = buildShortenRetryPrompt({
      record: "## Narrative\nLong record.",
      tokenBudget: 1500,
    });

    expect(prompt).toContain("~1500 tokens");
    expect(prompt).toContain("oldest first, resolution before");
    expect(prompt).toContain("rather than deleting a layer");
    // Mirrors the main prompt's recent carry rule: shortening may thin a
    // stretch of time, never drop it (dogfooded).
    expect(prompt).toContain("dropping a stretch of");
    expect(prompt).toContain("drop words, never facts");
    expect(prompt).toContain("## Narrative\nLong record.");
  });

  it("matches the consolidation prompt's horizon anchoring (MC-111)", () => {
    const prompt = buildShortenRetryPrompt({
      record: "## Narrative\nLong record.",
      tokenBudget: 1500,
    });

    expect(prompt).toContain("Keep exactly three");
    expect(prompt).toContain("Narrative layers, never a fourth");
    expect(prompt).toContain("recent (weeks) first, then earlier (months), then");
    expect(prompt).toContain("long-term (the whole arc)");
    expect(prompt).toContain("no date-headed or per-day entries");
  });
});

describe("continuity write caps", () => {
  // Every section at its write cap beside the real chrome; CJK bodies so the
  // estimator counts exactly.
  function assembleAtCaps(input: {
    capsuleTokenBudget: number;
    narrativeTargetTokens: number;
    recentSnapshotTokenBudget: number;
  }) {
    return buildContinuityCapsule({
      standingContext: "记".repeat(narrativeWriteCap(input.narrativeTargetTokens)),
      threadState: {
        summary: "线".repeat(compressionWriteCap(SUMMARY_TOKEN_BUDGET)),
      },
      snapshot: {
        content: "快".repeat(compressionWriteCap(input.recentSnapshotTokenBudget)),
        version: 1,
        asOf: new Date(2026, 8, 12),
      },
      tokenBudget: input.capsuleTokenBudget,
    });
  }

  it("caps each writer above its target: narrative × 1.5, snapshot and summary × 2", () => {
    expect(narrativeWriteCap(6400)).toBe(9600);
    expect(narrativeWriteCap(1001)).toBe(1502);
    expect(compressionWriteCap(500)).toBe(1000);
    expect(compressionWriteCap(SUMMARY_TOKEN_BUDGET)).toBe(1200);
  });

  it("owner configuration: target 6400 / snapshot 500 needs 11842, refuses 8000", () => {
    const owner = { narrativeTargetTokens: 6400, recentSnapshotTokenBudget: 500 };
    expect(requiredCapsuleTokens(owner)).toBe(
      9600 + 1000 + 1200 + CONTINUITY_CAPSULE_CHROME_TOKENS,
    );
    expect(capsuleBudgetRefusal({ ...owner, capsuleTokenBudget: 8000 })).toBe(
      "Capsule 8000 is below the 11842 a full write needs: narrative cap 9600 (target 6400 × 1.5) + snapshot cap 1000 (500 × 2) + summary cap 1200 (600 × 2) + chrome 42.",
    );
    expect(
      capsuleBudgetRefusal({ ...owner, capsuleTokenBudget: 11_842 }),
    ).toBeNull();
    const capsule = assembleAtCaps({ ...owner, capsuleTokenBudget: 11_842 });
    expect(capsule.trimmed).toBe("none");
    expect(capsule.narrativeTrimmedChars).toBe(0);
    expect(estimateTextTokens(capsule.text)).toBe(11_842);
  });

  it("never trims a write at its caps across the settings ranges", () => {
    // Target 500–12000 and snapshot 1–2000 are the settings bounds; the
    // capsule bound (24000) seats the worst pair. At exactly the required
    // capsule every section renders in full; one below is refused.
    const targets = [500, 501, 999, 1000, 3333, 6400, 9999, 12_000];
    const snapshots = [1, 100, 400, 500, 999, 1000, 1500, 2000];
    let checked = 0;
    for (const narrativeTargetTokens of targets) {
      for (const recentSnapshotTokenBudget of snapshots) {
        const required = requiredCapsuleTokens({
          narrativeTargetTokens,
          recentSnapshotTokenBudget,
        });
        expect(required).toBeLessThanOrEqual(24_000);
        const input = {
          narrativeTargetTokens,
          recentSnapshotTokenBudget,
          capsuleTokenBudget: required,
        };
        expect(capsuleBudgetRefusal(input)).toBeNull();
        expect(
          capsuleBudgetRefusal({ ...input, capsuleTokenBudget: required - 1 }),
        ).not.toBeNull();
        const capsule = assembleAtCaps(input);
        expect(capsule.trimmed).toBe("none");
        expect(estimateTextTokens(capsule.text)).toBeLessThanOrEqual(required);
        checked += 1;
      }
    }
    expect(checked).toBe(64);
  });
});

describe("resolution review", () => {
  it("builds a conservative prompt over summaries and the raw tail", () => {
    const prompt = buildResolutionReviewPrompt({
      threads: [{ id: "thread-1", content: "Waiting on the prototype decision." }],
      summaries: [],
      rawTail: [
        rawTailMessage({ id: "message-1", content: "The prototype was approved!" }),
      ],
    });

    expect(prompt).toContain("thread-1: Waiting on the prototype decision.");
    expect(prompt).toContain("The prototype was approved!");
    expect(prompt).toContain("Be conservative.");
    expect(prompt).toContain('{"resolved_thread_ids":["<id>"]}');
  });

  it("parses valid output and filters unknown ids", () => {
    const known = new Set(["thread-1", "thread-2"]);

    expect(
      parseResolutionReview(
        '{"resolved_thread_ids":["thread-1","thread-1","thread-9"]}',
        known,
      ),
    ).toEqual(["thread-1"]);
    expect(
      parseResolutionReview(
        '```json\n{"resolved_thread_ids":[]}\n```',
        known,
      ),
    ).toEqual([]);
  });

  it("throws on unreadable or mis-shaped output instead of reading it as zero", () => {
    const known = new Set(["thread-1"]);

    expect(() => parseResolutionReview("not json", known)).toThrow(
      "Resolution review output is not valid JSON.",
    );
    expect(() =>
      parseResolutionReview('{"resolved": ["thread-1"]}', known),
    ).toThrow("Resolution review output does not have the expected shape.");
  });
});

describe("effectiveStandingContext", () => {
  it("treats the narrative as authoritative once a version exists", () => {
    expect(
      effectiveStandingContext(
        { content: "## Profile\nNarrative", version: 3 },
        "Fallback",
      ),
    ).toBe("## Profile\nNarrative");
    // A deliberately blanked narrative stays blank — the owner cleared the
    // always-on context; the old seed must not resurrect.
    expect(
      effectiveStandingContext({ content: "  ", version: 5 }, "Fallback"),
    ).toBe("");
  });

  it("falls back to standing context only before the first version", () => {
    expect(
      effectiveStandingContext({ content: "", version: 0 }, "Fallback"),
    ).toBe("Fallback");
    expect(effectiveStandingContext(null, "Fallback")).toBe("Fallback");
    expect(effectiveStandingContext(null, "")).toBe("");
  });
});

describe("prompt source formatting fallbacks", () => {
  it("renders (none) groups when a source set is empty", () => {
    const prompt = buildConsolidationPrompt({
      mode: "incremental",
      currentRecord: "",
      tokenBudget: 2000,
      sources: emptySources,
    });

    expect(prompt).toContain("(none)");
  });
});
