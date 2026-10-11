import { describe, expect, it } from "vitest";

import { retryDelayMs } from "@/server/db/jobs";
import {
  buildSummaryPrompt,
  selectMessagesToSummarize,
  type SummaryMessage,
} from "@/server/summaries/summarize";
import {
  PERSON_REFERENCE_RULE,
  SOURCE_LANGUAGE_RULE,
} from "@/server/summaries/writer-voice";

function message(
  id: string,
  role: "user" | "assistant",
  content: string,
): SummaryMessage {
  return {
    id,
    role,
    content,
    createdAt: new Date(`2026-06-15T12:00:0${id}Z`),
  };
}

describe("conversation summaries", () => {
  it("summarizes an older contiguous range and preserves the newest pair", () => {
    const messages = [
      message("1", "user", "a".repeat(30)),
      message("2", "assistant", "b".repeat(30)),
      message("3", "user", "c".repeat(30)),
      message("4", "assistant", "d".repeat(30)),
      message("5", "user", "e".repeat(30)),
      message("6", "assistant", "f".repeat(30)),
    ];

    expect(selectMessagesToSummarize(messages, 20)).toEqual(
      messages.slice(0, 4),
    );
  });

  it("always leaves the newest conversation group unsummarized", () => {
    const messages = [
      message("1", "user", "a".repeat(30)),
      message("2", "assistant", "b".repeat(30)),
    ];

    expect(selectMessagesToSummarize(messages, 0)).toEqual([]);
  });

  it("builds a cumulative prompt with the old summary and selected messages", () => {
    const prompt = buildSummaryPrompt({
      existingSummary: "The owner prefers concise answers.",
      messages: [
        message("1", "user", "Remember the sample project deadline."),
        message("2", "assistant", "The deadline is Friday."),
      ],
    });

    expect(prompt).toContain("The owner prefers concise answers.");
    expect(prompt).toContain("USER: Remember the sample project deadline.");
    expect(prompt).toContain("ASSISTANT: The deadline is Friday.");
    expect(prompt).toContain("Return only the replacement summary");
    expect(prompt).toContain(PERSON_REFERENCE_RULE);
    expect(prompt).toContain(SOURCE_LANGUAGE_RULE);
  });

  it("uses the documented bounded retry delays: first, +1m, +10m", () => {
    expect(retryDelayMs(1)).toBe(60_000);
    expect(retryDelayMs(2)).toBe(10 * 60_000);
    expect(retryDelayMs(3)).toBe(10 * 60_000);
    expect(retryDelayMs(99)).toBe(10 * 60_000);
  });
});
