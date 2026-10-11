import { describe, expect, it, vi } from "vitest";

import { estimateTextTokens } from "@/server/chat/context";
import {
  compressionTokenCounter,
  trimNarrativeSectionToTokenBudget,
  trimTextToTokenBudget,
} from "@/server/summaries/token-budget";

describe("compression token budgeting", () => {
  it("counts with the capsule estimator and nothing else (one accounting domain)", async () => {
    // No provider, no network, no fallback branch: the write-side counter
    // is the same estimator the read-side capsule assembly uses.
    await expect(compressionTokenCounter("你好世界")).resolves.toBe(
      estimateTextTokens("你好世界"),
    );
    await expect(compressionTokenCounter("hello world")).resolves.toBe(
      estimateTextTokens("hello world"),
    );
  });

  it("trims text until the selected counter fits the budget", async () => {
    const counter = vi.fn(async (text: string) => text.length);

    await expect(
      trimTextToTokenBudget({
        text: "abcdef",
        tokenBudget: 3,
        countTokens: counter,
      }),
    ).resolves.toBe("abc");
  });
});

describe("narrative section trimming", () => {
  const counter = async (text: string) => text.length;

  it("returns the document unchanged when it fits", async () => {
    const record = "## Profile\nfacts\n\n## Narrative\nstory\n\n## Anchors\nquote";

    await expect(
      trimNarrativeSectionToTokenBudget({
        text: record,
        tokenBudget: record.length,
        countTokens: counter,
      }),
    ).resolves.toBe(record);
  });

  it("shrinks the ## Narrative section from the end before touching anchors", async () => {
    const record = [
      "## Profile",
      "facts",
      "",
      "## Narrative",
      "recent layer.",
      "",
      "earlier layer.",
      "",
      "long-term layer.",
      "",
      "## Anchors",
      '"verbatim quote"',
    ].join("\n");

    const trimmed = await trimNarrativeSectionToTokenBudget({
      text: record,
      tokenBudget: record.length - 20,
      countTokens: counter,
    });

    expect(trimmed).toContain('"verbatim quote"');
    expect(trimmed).toContain("## Profile");
    expect(trimmed).toContain("recent layer.");
    expect(trimmed).not.toContain("long-term layer.");
  });

  it("falls back to end-trimming when no ## Narrative section exists", async () => {
    const record = "plain text without headings that is far too long";

    const trimmed = await trimNarrativeSectionToTokenBudget({
      text: record,
      tokenBudget: 10,
      countTokens: counter,
    });

    expect(trimmed.length).toBeLessThanOrEqual(10);
    expect(record.startsWith(trimmed)).toBe(true);
  });

  it("keeps trimming past an emptied narrative body when still over budget", async () => {
    const record = [
      "## Profile",
      "a".repeat(50),
      "",
      "## Narrative",
      "story unit.",
      "",
      "## Anchors",
      "b".repeat(50),
    ].join("\n");

    const trimmed = await trimNarrativeSectionToTokenBudget({
      text: record,
      tokenBudget: 40,
      countTokens: counter,
    });

    expect(trimmed.length).toBeLessThanOrEqual(40);
    expect(trimmed).not.toContain("story unit.");
  });
});
