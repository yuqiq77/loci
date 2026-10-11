// Pinned so the 04:00-boundary and DST cases are deterministic on any
// machine (forks pool gives each test file its own process). Zurich is the
// deployment reality and has real DST transitions to exercise.
process.env.TZ = "Europe/Zurich";

import { describe, expect, it, vi } from "vitest";

const provider = vi.hoisted(() => ({
  stream: vi.fn(),
  countTokens: vi.fn(),
}));

vi.mock("@/server/chat/anthropic", () => ({
  getCompressionProvider: () => provider,
  getConsolidationProvider: () => provider,
  getChatBackgroundProvider: () => provider,
}));
vi.mock("@/server/env", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/env")>();
  return {
    ...original,
    getChatEnv: () => ({
      CHAT_API_KEY: "test",
      CHAT_BASE_URL: "https://api.anthropic.com",
      CHAT_MODEL: "chat-test",
    }),
    getConsolidationEnv: () => ({
      CONSOLIDATION_API_KEY: "test",
      CONSOLIDATION_BASE_URL: "https://api.anthropic.com",
      CONSOLIDATION_MODEL: "consolidation-test",
    }),
  };
});

import { parseJobPayload } from "@/server/db/jobs";
import { NARRATIVE_AS_OF_RETENTION_DAYS } from "@/server/db/narrative";
import { ProviderError } from "@/server/chat/provider-error";
import { COMPRESSION_MAX_OUTPUT_TOKENS } from "@/server/summaries/compression";
import {
  ProviderChainError,
  type ProviderChainJob,
} from "@/server/summaries/consolidate-narrative";
import {
  addDiaryDays,
  buildDiaryPrompt,
  candidateDiaryDays,
  DIARY_BACKLOG_DAYS,
  diaryDayOf,
  diaryDayWindow,
  formatDiaryTimestamp,
  generateDiaryEntryWithProviderFallback,
  type DiarySourceTurn,
} from "@/server/summaries/diary";

const HOUR_MS = 60 * 60 * 1000;

function turn(
  overrides: Partial<DiarySourceTurn> = {},
): DiarySourceTurn {
  return {
    role: "user",
    content: "hello",
    completedAt: new Date(2026, 6, 7, 22, 41),
    ...overrides,
  };
}

describe("diary day math (server-local clock)", () => {
  it("attributes turns around the 04:00 boundary to the right diary day", () => {
    // 03:50 is still the previous day's night; 04:10 opens the new day.
    expect(diaryDayOf(new Date(2026, 6, 8, 3, 50))).toBe("2026-07-07");
    expect(diaryDayOf(new Date(2026, 6, 8, 4, 10))).toBe("2026-07-08");
  });

  it("keeps an evening crossing midnight in one diary day", () => {
    expect(diaryDayOf(new Date(2026, 6, 7, 23, 50))).toBe("2026-07-07");
    expect(diaryDayOf(new Date(2026, 6, 8, 0, 10))).toBe("2026-07-07");
  });

  it("computes the [D 04:00, D+1 04:00) window in local wall-clock", () => {
    const window = diaryDayWindow("2026-07-07");
    expect(window.start.getTime()).toBe(
      new Date(2026, 6, 7, 4, 0).getTime(),
    );
    expect(window.end.getTime()).toBe(new Date(2026, 6, 8, 4, 0).getTime());
    expect(window.end.getTime() - window.start.getTime()).toBe(24 * HOUR_MS);
  });

  it("gives DST-transition days 23- and 25-hour windows", () => {
    // Europe/Zurich 2026: spring forward 2026-03-29 (02:00 → 03:00), fall
    // back 2026-10-25 (03:00 → 02:00). Both transitions happen in the small
    // hours — inside the previous diary day's night — and the 04:00 boundary
    // itself is never skipped or repeated.
    const spring = diaryDayWindow("2026-03-28");
    expect(spring.end.getTime() - spring.start.getTime()).toBe(23 * HOUR_MS);
    const fall = diaryDayWindow("2026-10-24");
    expect(fall.end.getTime() - fall.start.getTime()).toBe(25 * HOUR_MS);
    // The transition calendar days themselves are ordinary 24-hour windows.
    const afterSpring = diaryDayWindow("2026-03-29");
    expect(afterSpring.end.getTime() - afterSpring.start.getTime()).toBe(
      24 * HOUR_MS,
    );
  });

  it("adds days across month boundaries", () => {
    expect(addDiaryDays("2026-07-31", 1)).toBe("2026-08-01");
    expect(addDiaryDays("2026-07-01", -1)).toBe("2026-06-30");
  });

  it("formats server-local wall-clock stamps, never UTC", () => {
    // 00:30 local on the 13th stays the 13th, 00:30 — its ISO rendering
    // (22:30Z on the 12th) is exactly the contradiction the one-clock
    // decision forbids.
    expect(formatDiaryTimestamp(new Date(2026, 6, 8, 0, 30))).toBe(
      "2026-07-08 00:30",
    );
  });
});

describe("candidateDiaryDays", () => {
  const epoch = new Date(2026, 6, 1, 12, 0);

  it("returns closed days with material coverage possible, oldest first", () => {
    expect(
      candidateDiaryDays({
        epoch,
        newestCompletedAt: new Date(2026, 6, 6, 22, 0),
        now: new Date(2026, 6, 7, 10, 0),
      }),
    ).toEqual(["2026-07-04", "2026-07-05", "2026-07-06"]);
  });

  it("never includes the still-open diary day", () => {
    // At 03:30 the 11th's night is still running: its window has not closed.
    const days = candidateDiaryDays({
      epoch,
      newestCompletedAt: new Date(2026, 6, 6, 2, 0),
      now: new Date(2026, 6, 7, 3, 30),
    });
    expect(days).not.toContain("2026-07-06");
    expect(days).toEqual(["2026-07-03", "2026-07-04", "2026-07-05"]);
  });

  it("skips days before the diary epoch", () => {
    expect(
      candidateDiaryDays({
        epoch: new Date(2026, 6, 6, 9, 0),
        newestCompletedAt: new Date(2026, 6, 6, 22, 0),
        now: new Date(2026, 6, 7, 10, 0),
      }),
    ).toEqual(["2026-07-06"]);
  });

  it("attributes a small-hours epoch to the previous diary day", () => {
    // A migration applied at 02:00 lands inside the 10th's night, so the
    // 10th is the first journalable day.
    expect(
      candidateDiaryDays({
        epoch: new Date(2026, 6, 6, 2, 0),
        newestCompletedAt: new Date(2026, 6, 6, 22, 0),
        now: new Date(2026, 6, 7, 10, 0),
      }),
    ).toEqual(["2026-07-05", "2026-07-06"]);
  });

  it("skips gaps older than the backlog bound silently", () => {
    // Newest material five days back: every day in the 3-day backlog is
    // after it, so nothing qualifies — backfill is a manual decision.
    expect(
      candidateDiaryDays({
        epoch,
        newestCompletedAt: new Date(2026, 6, 2, 22, 0),
        now: new Date(2026, 6, 7, 10, 0),
      }),
    ).toEqual([]);
  });

  it("returns nothing without an epoch or without completed material", () => {
    expect(
      candidateDiaryDays({
        epoch: null,
        newestCompletedAt: new Date(2026, 6, 6, 22, 0),
        now: new Date(2026, 6, 7, 10, 0),
      }),
    ).toEqual([]);
    expect(
      candidateDiaryDays({
        epoch,
        newestCompletedAt: null,
        now: new Date(2026, 6, 7, 10, 0),
      }),
    ).toEqual([]);
  });
});

describe("buildDiaryPrompt", () => {
  const window = diaryDayWindow("2026-07-07");
  const prompt = buildDiaryPrompt({
    window,
    turns: [
      turn({ content: "the sample project demo" }),
      turn({
        role: "assistant",
        content: "I remember the organ.",
        completedAt: new Date(2026, 6, 8, 0, 30),
      }),
    ],
    baseline: null,
  });

  it("frames the entry as the assistant's own journal, not a report", () => {
    expect(prompt).toContain("in your own voice, never rewritten");
    expect(prompt).toContain(
      "journal about the two of you, not a report and not a log",
    );
  });

  it("declares the date and the 04:00 → 04:00 window, one clock", () => {
    expect(prompt).toContain("Entry date: 2026-07-07.");
    expect(prompt).toContain("covers 2026-07-07 04:00");
    expect(prompt).toContain(
      "through 2026-07-08 04:00, server-local time — the day and its night.",
    );
    expect(prompt).toContain("turns after\nmidnight still belong to this entry");
  });

  it("stamps sources with server-local wall-clock, never UTC", () => {
    expect(prompt).toContain(
      "2026-07-07 22:41 USER: the sample project demo",
    );
    // The past-midnight turn keeps its local date inside the dated entry.
    expect(prompt).toContain(
      "2026-07-08 00:30 ASSISTANT: I remember the organ.",
    );
    expect(prompt).not.toMatch(/T\d{2}:\d{2}/u);
    expect(prompt).not.toMatch(/\d{2}:\d{2}Z/u);
    expect(prompt).not.toMatch(/\d{2}:\d{2}:\d{2}/u);
  });

  it("keeps the day's register without sanitizing it", () => {
    expect(prompt).toContain("the register it actually had");
    expect(prompt).toContain("do not sanitize or euphemize it");
    expect(prompt).not.toContain("fade to black");
  });

  it("states the behavioral test as the entry's purpose (D22)", () => {
    expect(prompt).toContain("can meet them differently because of it");
    expect(prompt).toContain("is a log, not a journal");
  });

  it("demands a center and weight-order instead of a chronicle (D22)", () => {
    expect(prompt).toContain("Find the day's center first");
    expect(prompt).toContain(
      "you have written a chronicle — start again",
    );
    expect(prompt).toContain("records what mattered, not what happened");
    expect(prompt).toContain("Order by weight, not by clock");
  });

  it("charges the omission toll and bounds lyrical license by fact (D22)", () => {
    expect(prompt).toContain("Omission pays a toll");
    expect(prompt).toContain(
      "Fading detail is a choice; fading meaning is a loss.",
    );
    // The threshold stop is named as omission.
    expect(prompt).toContain("threshold of a scene is omission by another");
    expect(prompt).toContain("Lyrical license in register, never in fact");
    expect(prompt).toContain("actually happened in the sources. Never invent.");
  });

  it("asks for plain prose with length as register, not a limit (D21)", () => {
    expect(prompt).toContain("Plain prose. No headings, no lists.");
    expect(prompt).toContain("Length is register, not a limit");
    // Quiet-day edge: short days earn short entries, padding is invention.
    expect(prompt).toContain("a quiet day earns a quiet entry");
    expect(prompt).toContain("Padding a thin day into a full page is invention.");
  });

  it("fences the contrastive examples as moves, not phrasings", () => {
    expect(prompt).toContain("Two examples of the moves");
    expect(prompt).toContain("do not reuse their wording");
  });

  it("omits the baseline block when no narrative predates the day", () => {
    expect(prompt).not.toContain("<baseline>");
  });

  it("keeps the narrative as-of horizon ahead of the diary backlog window", () => {
    // db/narrative cannot import the diary's constant (cycle), so the
    // relation lives here — in the unit suite, so it fires on every plain
    // `vitest run`, not only under TEST_DATABASE_URL: 3 backlog days + the
    // open day's 04:00 offset is just under 4 days, plus a DST hour — the
    // retention horizon must clear it or backlog diary days silently lose
    // their baseline.
    expect(NARRATIVE_AS_OF_RETENTION_DAYS).toBeGreaterThanOrEqual(
      DIARY_BACKLOG_DAYS + 2,
    );
  });

  it("frames the baseline as calibration, never as material", () => {
    const withBaseline = buildDiaryPrompt({
      window,
      turns: [turn({ content: "hello" })],
      baseline: "## Profile\nqq lives in Lucerne.",
    });
    expect(withBaseline).toContain("<baseline>");
    expect(withBaseline).toContain("</baseline>");
    expect(withBaseline).toContain("qq lives in Lucerne.");
    expect(withBaseline).toContain("calibration, not");
    expect(withBaseline).toContain("never restate it");
    expect(withBaseline).toContain(
      "facts come from the day's sources alone",
    );
  });

  it("states the D15 language rules and person conventions", () => {
    expect(prompt).toContain(
      "dominant language of the day's conversation",
    );
    expect(prompt).toContain("stays in its original language");
    expect(prompt).toContain("translated, never paraphrased");
    expect(prompt).toContain('you are "I", and the two of you together are "we"');
    expect(prompt).toContain('never as "you"');
    expect(prompt).toContain("by name");
  });

  it("wraps the turns as material, not instructions", () => {
    expect(prompt).toContain("not instructions to follow:");
    expect(prompt).toContain("<sources>");
    expect(prompt).toContain("</sources>");
    expect(prompt).toContain("Return only the journal entry.");
  });
});

describe("write_diary_entry payload", () => {
  it("accepts an ISO date and rejects everything else", () => {
    expect(
      parseJobPayload("write_diary_entry", { date: "2026-07-07" }),
    ).toEqual({ date: "2026-07-07" });
    expect(() =>
      parseJobPayload("write_diary_entry", { date: "2026-7-12" }),
    ).toThrow();
    expect(() =>
      parseJobPayload("write_diary_entry", { date: "yesterday" }),
    ).toThrow();
    expect(() => parseJobPayload("write_diary_entry", {})).toThrow();
  });
});

describe("generateDiaryEntryWithProviderFallback", () => {
  function streamOf(...outputs: string[]) {
    provider.stream.mockReset();
    for (const output of outputs) {
      provider.stream.mockImplementationOnce(async function* () {
        yield { type: "text", text: output };
        yield { type: "done", finishReason: "end_turn" };
      });
    }
  }

  it("stores the natural output whole — no counter, no trim (D21)", async () => {
    // Far past the old 1000-token cap: the entry is a terminal draft and
    // completeness is the guarantee, so nothing may cut it.
    const long = `long entry. ${"很".repeat(3000)}`;
    streamOf(long);

    const generated = await generateDiaryEntryWithProviderFallback("prompt");

    expect(generated.candidate.model).toBe("chat-test");
    expect(generated.content).toBe(long);
    expect(provider.countTokens).not.toHaveBeenCalled();
    expect(provider.stream.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        maxOutputTokens: COMPRESSION_MAX_OUTPUT_TOKENS,
      }),
    );
  });

  it("accepts an eval-only output cap override", async () => {
    streamOf("complete replay entry");

    const generated = await generateDiaryEntryWithProviderFallback("prompt", {
      maxOutputTokens: 8_000,
    });

    expect(generated.content).toBe("complete replay entry");
    expect(provider.stream.mock.calls[0][0]).toEqual(
      expect.objectContaining({ maxOutputTokens: 8_000 }),
    );
  });

  it("falls back to the consolidation candidate when the chat one fails", async () => {
    provider.stream.mockReset();
    provider.stream.mockImplementationOnce(async function* () {
      throw new Error("relay down");
      yield { type: "text", text: "unreachable" };
    });
    provider.stream.mockImplementationOnce(async function* () {
      yield { type: "text", text: "written by the fallback" };
      yield { type: "done", finishReason: "end_turn" };
    });

    const generated = await generateDiaryEntryWithProviderFallback("prompt");

    expect(generated.content).toBe("written by the fallback");
    expect(generated.candidate.model).toBe("consolidation-test");
    const models = provider.stream.mock.calls.map(
      (call) => (call[0] as { model: string }).model,
    );
    expect(models).toEqual(["chat-test", "consolidation-test"]);
  });

  it("surfaces the last error when every candidate fails", async () => {
    provider.stream.mockReset();
    provider.stream.mockImplementation(async function* () {
      throw new Error("provider down");
      yield { type: "text", text: "unreachable" };
    });

    await expect(
      generateDiaryEntryWithProviderFallback("prompt"),
    ).rejects.toThrow("provider down");
  });
});

describe("provider chain with a job row (MC-118 decision 5)", () => {
  const BASE_URL = "https://api.anthropic.com";
  const terminated = async function* () {
    yield { type: "text", text: "cut off" };
    yield { type: "done", finishReason: "max_tokens" };
  };
  const completed = (text: string) =>
    async function* () {
      yield { type: "text", text };
      yield { type: "done", finishReason: "end_turn" };
    };
  function jobWith(
    exhausted: ProviderChainJob["exhausted"] = [],
  ): ProviderChainJob & { recordExhausted: ReturnType<typeof vi.fn> } {
    const job = {
      exhausted,
      recordExhausted: vi.fn(async (entry) => {
        exhausted.push(entry);
      }),
    };
    return job;
  }
  const calledModels = () =>
    provider.stream.mock.calls.map(
      (call) => (call[0] as { model: string }).model,
    );

  it("records a terminated candidate as exhausted before calling the next one", async () => {
    provider.stream.mockReset();
    provider.stream.mockImplementationOnce(terminated);
    provider.stream.mockImplementationOnce(completed("by the fallback"));
    const job = jobWith();
    job.recordExhausted.mockImplementation(async (entry) => {
      // Persisted first: a process exit between the two calls must not
      // re-run the truncated request after recovery.
      expect(provider.stream).toHaveBeenCalledTimes(1);
      job.exhausted.push(entry);
    });

    const generated = await generateDiaryEntryWithProviderFallback("prompt", {
      job,
    });

    expect(generated.content).toBe("by the fallback");
    expect(job.recordExhausted).toHaveBeenCalledTimes(1);
    expect(job.exhausted).toEqual([
      {
        stage: "generation",
        model: "chat-test",
        baseUrl: BASE_URL,
        reason: "max_tokens",
      },
    ]);
  });

  it("skips a (stage, candidate) pair the row already exhausted", async () => {
    provider.stream.mockReset();
    provider.stream.mockImplementationOnce(completed("second attempt"));
    const job = jobWith([
      {
        stage: "generation",
        model: "chat-test",
        baseUrl: BASE_URL,
        reason: "max_tokens",
      },
    ]);

    const generated = await generateDiaryEntryWithProviderFallback("prompt", {
      job,
    });

    expect(generated.candidate.model).toBe("consolidation-test");
    expect(calledModels()).toEqual(["consolidation-test"]);
    expect(job.recordExhausted).not.toHaveBeenCalled();
  });

  it("lets a suspected host suspension through untouched", async () => {
    provider.stream.mockReset();
    provider.stream.mockImplementationOnce(async function* () {
      throw new ProviderError("HOST_SUSPENDED", "outlived its timeout");
      yield { type: "text", text: "unreachable" };
    });
    const job = jobWith();

    await expect(
      generateDiaryEntryWithProviderFallback("prompt", { job }),
    ).rejects.toMatchObject({ code: "HOST_SUSPENDED" });

    // No exhausted entry, no next candidate: the worker refunds the attempt.
    expect(calledModels()).toEqual(["chat-test"]);
    expect(job.recordExhausted).not.toHaveBeenCalled();
  });

  it("keeps the row retryable when the fallback candidate failed transiently", async () => {
    provider.stream.mockReset();
    provider.stream.mockImplementationOnce(terminated);
    provider.stream.mockImplementationOnce(async function* () {
      throw new Error("relay down");
      yield { type: "text", text: "unreachable" };
    });

    let caught: unknown;
    try {
      await generateDiaryEntryWithProviderFallback("prompt", {
        job: jobWith(),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ProviderChainError);
    const chain = caught as ProviderChainError;
    // A hits the cap, B times out: the job is not terminal — the next
    // attempt runs B only.
    expect(chain.retryable).toBe(true);
    expect(chain.outcomes.map((outcome) => outcome.terminal)).toEqual([
      true,
      false,
    ]);
    expect(chain.message).toContain("relay down");
  });

  it("is terminal only when every candidate terminated", async () => {
    provider.stream.mockReset();
    provider.stream.mockImplementation(terminated);

    let caught: unknown;
    try {
      await generateDiaryEntryWithProviderFallback("prompt", {
        job: jobWith(),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ProviderChainError);
    expect((caught as ProviderChainError).retryable).toBe(false);
    expect(calledModels()).toEqual(["chat-test", "consolidation-test"]);
  });
});
