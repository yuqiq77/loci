import { describe, expect, it } from "vitest";

import { decodeJobError, JOB_ERROR_MAX_LENGTH } from "@/server/jobs/last-error";
import {
  CompressionTerminationError,
  terminationExcerpt,
} from "@/server/summaries/compression";
import { ProviderChainError } from "@/server/summaries/consolidate-narrative";

// The decoder reads what CompressionTerminationError writes today (MC-123
// AC 3): full record, plain text, and a record cut at the column bound.
function termination(model: string, output: string) {
  return new CompressionTerminationError(
    "Compression output ended early (finish reason: max_tokens).",
    {
      reason: "max_tokens",
      finishReason: "max_tokens",
      stage: "generation",
      model,
      cap: 32_000,
      outputTokens: 31_998,
      outputChars: output.length,
      excerpt: terminationExcerpt(output),
    },
  );
}

describe("decodeJobError (MC-123)", () => {
  it("decodes a full termination record", () => {
    const decoded = decodeJobError(termination("chat-test", "cut off").message);

    expect(decoded).toEqual({
      raw: expect.stringContaining("[stage=generation model=chat-test"),
      records: 1,
      partial: false,
      record: {
        stage: "generation",
        model: "chat-test",
        cap: 32_000,
        outputTokens: 31_998,
        outputChars: 7,
        finishReason: "max_tokens",
        excerpt: "cut off",
      },
    });
  });

  it("reads the first record of a provider-chain summary and counts the rest", () => {
    const chain = new ProviderChainError("generation", [
      {
        label: "chat",
        model: "chat-test",
        baseUrl: "https://a",
        terminal: true,
        error: termination("chat-test", "first candidate output"),
      },
      {
        label: "consolidation",
        model: "consolidation-test",
        baseUrl: "https://b",
        terminal: true,
        error: termination("consolidation-test", "second candidate output"),
      },
    ]);
    // What the worker persists: the message plus any cause not already
    // embedded (the chain embeds both, so the message alone is the row).
    const decoded = decodeJobError(chain.message);

    expect(decoded?.records).toBe(2);
    expect(decoded?.partial).toBe(false);
    expect(decoded?.record).toMatchObject({
      stage: "generation",
      model: "chat-test",
      finishReason: "max_tokens",
      excerpt: "first candidate output",
    });
  });

  it("returns raw only for plain-text errors", () => {
    expect(decodeJobError("Provider timeout after 300s.")).toEqual({
      raw: "Provider timeout after 300s.",
      record: null,
      records: 0,
      partial: false,
    });
    expect(decodeJobError(null)).toBeNull();
  });

  it("marks a record cut at the length bound as partial instead of throwing", () => {
    const long = termination("chat-test", "x".repeat(600)).message;
    const insideBracket = long.slice(0, long.indexOf("cap=") + 2);
    expect(decodeJobError(insideBracket)).toMatchObject({
      record: null,
      partial: true,
    });

    const atBound = `${long} ${"y".repeat(JOB_ERROR_MAX_LENGTH)}`.slice(
      0,
      JOB_ERROR_MAX_LENGTH,
    );
    const decoded = decodeJobError(atBound);
    expect(decoded?.partial).toBe(true);
    expect(decoded?.record?.stage).toBe("generation");
    expect(decoded?.raw).toHaveLength(JOB_ERROR_MAX_LENGTH);
  });

  it("treats an absent excerpt as empty", () => {
    const decoded = decodeJobError(
      "Summary was empty. [stage=summary model=m cap=10 chars=0] excerpt: (none)",
    );
    expect(decoded?.record).toMatchObject({
      finishReason: null,
      outputTokens: null,
      excerpt: "",
    });
  });
});
