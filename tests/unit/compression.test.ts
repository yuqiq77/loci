import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatChunk, ChatProvider } from "@/server/chat/types";
import {
  CompressionTerminationError,
  parseTerminationError,
  streamCompressionText,
} from "@/server/summaries/compression";

function providerYielding(chunks: ChatChunk[]): ChatProvider {
  return {
    stream: async function* () {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

const baseInput = {
  model: "compression-test",
  prompt: "Compress this.",
  stage: "test",
  temperature: 0.2,
  maxOutputTokens: 600,
  emptyErrorMessage: "Compression model returned an empty result.",
};

describe("streamCompressionText", () => {
  it("accumulates text and returns on a natural end", async () => {
    await expect(
      streamCompressionText({
        ...baseInput,
        provider: providerYielding([
          { type: "text", text: "Hello " },
          { type: "text", text: "world." },
          { type: "done", finishReason: "end_turn" },
        ]),
      }),
    ).resolves.toBe("Hello world.");
  });

  it("throws when the stream finishes early instead of returning truncated text", async () => {
    await expect(
      streamCompressionText({
        ...baseInput,
        provider: providerYielding([
          { type: "text", text: "Truncated docu" },
          { type: "done", finishReason: "max_tokens" },
        ]),
      }),
    ).rejects.toThrow("ended early (finish reason: max_tokens)");
  });

  it("throws the empty message when the stream never completes", async () => {
    await expect(
      streamCompressionText({
        ...baseInput,
        provider: providerYielding([{ type: "text", text: "partial" }]),
      }),
    ).rejects.toThrow(baseInput.emptyErrorMessage);
  });

  it("throws the empty message on completed-but-empty output", async () => {
    await expect(
      streamCompressionText({
        ...baseInput,
        provider: providerYielding([
          { type: "text", text: "   " },
          { type: "done", finishReason: "end_turn" },
        ]),
      }),
    ).rejects.toThrow(baseInput.emptyErrorMessage);
  });
});

describe("CompressionTerminationError", () => {
  it("records stage, model, cap, usage, and a bounded excerpt on an early finish", async () => {
    const long = `${"prefix ".repeat(60)}MIDDLE${" suffix".repeat(60)}`;
    let caught: unknown;
    try {
      await streamCompressionText({
        ...baseInput,
        stage: "diary",
        provider: providerYielding([
          { type: "usage", inputTokens: 1200, outputTokens: undefined },
          { type: "text", text: long },
          { type: "usage", inputTokens: undefined, outputTokens: 600 },
          { type: "done", finishReason: "max_tokens" },
        ]),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CompressionTerminationError);
    const details = (caught as CompressionTerminationError).details;
    expect(details).toMatchObject({
      reason: "max_tokens",
      finishReason: "max_tokens",
      stage: "diary",
      model: "compression-test",
      cap: 600,
      inputTokens: 1200,
      outputTokens: 600,
      outputChars: long.length,
    });
    expect(details.excerpt.length).toBeLessThan(long.length);
    expect(details.excerpt.startsWith("prefix prefix")).toBe(true);
    expect(details.excerpt.endsWith("suffix suffix")).toBe(true);
    expect(details.excerpt).toContain(" … ");
    expect((caught as Error).message).toContain(
      "[stage=diary model=compression-test cap=600 output_tokens=600 chars=",
    );
  });

  it("records the empty reason for a stream that never completes", async () => {
    await expect(
      streamCompressionText({
        ...baseInput,
        provider: providerYielding([{ type: "text", text: "partial" }]),
      }),
    ).rejects.toMatchObject({
      name: "CompressionTerminationError",
      details: { reason: "empty", finishReason: null, excerpt: "partial" },
    });
  });

  it("builds a parse termination for a complete but unusable response", () => {
    const error = parseTerminationError("Output is not valid JSON.", {
      reason: "not_json",
      stage: "narrative_review",
      model: "chat-test",
      output: "Looking at the threads…\n{",
    });
    expect(error.details).toEqual({
      reason: "not_json",
      finishReason: "end_turn",
      stage: "narrative_review",
      model: "chat-test",
      outputChars: 25,
      excerpt: "Looking at the threads… {",
    });
    expect(error.message).toBe(
      "Output is not valid JSON. [stage=narrative_review model=chat-test chars=25] excerpt: Looking at the threads… {",
    );
  });
});

describe("compression usage log", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs the provider's billed counts beside the stored size on every success", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    await streamCompressionText({
      ...baseInput,
      stage: "narrative_generation",
      provider: providerYielding([
        { type: "usage", inputTokens: 1200 },
        { type: "text", text: " Short record. " },
        // Thinking bills as output: the count runs past the visible text.
        { type: "usage", outputTokens: 950 },
        { type: "done", finishReason: "end_turn" },
      ]),
    });

    expect(info).toHaveBeenCalledWith("compression_usage", {
      stage: "narrative_generation",
      model: "compression-test",
      inputTokens: 1200,
      outputTokens: 950,
      outputChars: 13,
      outputEstimatorTokens: 5,
    });
  });

  it("leaves a terminated call to the error record", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    await expect(
      streamCompressionText({
        ...baseInput,
        provider: providerYielding([
          { type: "usage", inputTokens: 10, outputTokens: 600 },
          { type: "text", text: "Cut off" },
          { type: "done", finishReason: "max_tokens" },
        ]),
      }),
    ).rejects.toBeInstanceOf(CompressionTerminationError);
    expect(info).not.toHaveBeenCalledWith("compression_usage", expect.anything());
  });
});
