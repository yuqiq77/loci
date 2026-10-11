import { estimateTextTokens } from "@/server/chat/context";
import { modelSupportsTemperature } from "@/server/chat/models";
import { ProviderError } from "@/server/chat/provider-error";
import type { ChatProvider, ModelMessage } from "@/server/chat/types";

// One output cap for every compression writer (MC-118, 2026-09-06). A
// runaway guard, not an editorial target: length lives in each writer's
// prompt and its post-generation count/trim. The seven per-writer caps this
// replaces (title 256 … extraction/snapshot 8000) were each sized for the
// expected text and each truncated legitimate output — reasoning shares
// max_tokens on models that reason by default (deepseek-v4-flash, the
// 5-series), CJK runs 1–2 tokens per character, rich windows overshoot. The
// five-minute per-request timeout stays the time protection.
export const COMPRESSION_MAX_OUTPUT_TOKENS = 32_000;

// Why a model-output request ended without a usable document: a non-end_turn
// finish reason straight from the provider (`max_tokens`, …), `empty` for a
// stream that never completed or completed with no text, `not_json` /
// `bad_shape` for a complete response the writer cannot parse.
export type CompressionTerminationDetails = {
  reason: string;
  finishReason: string | null;
  // Which call inside a job ("diary", "narrative_review", …) — one job may
  // chain several.
  stage: string;
  model?: string;
  cap?: number;
  inputTokens?: number;
  outputTokens?: number;
  outputChars: number;
  excerpt: string;
};

const EXCERPT_EDGE_CHARS = 200;

// Diagnostic only — a bounded head + tail of what arrived, never persisted
// as content. The head shows a prose preamble before JSON; the tail tells a
// long legitimate document from a repetition loop.
export function terminationExcerpt(output: string): string {
  const collapsed = output.replace(/\s+/g, " ").trim();
  if (collapsed.length <= EXCERPT_EDGE_CHARS * 2) {
    return collapsed;
  }
  return `${collapsed.slice(0, EXCERPT_EDGE_CHARS)} … ${collapsed.slice(
    -EXCERPT_EDGE_CHARS,
  )}`;
}

function formatTermination(details: CompressionTerminationDetails): string {
  const fields = [
    `stage=${details.stage}`,
    details.model ? `model=${details.model}` : null,
    details.cap !== undefined ? `cap=${details.cap}` : null,
    details.outputTokens !== undefined
      ? `output_tokens=${details.outputTokens}`
      : null,
    `chars=${details.outputChars}`,
  ].filter((field): field is string => field !== null);
  return `[${fields.join(" ")}] excerpt: ${details.excerpt || "(none)"}`;
}

// The one error class for "the model's output is unusable" (MC-118 scope 3):
// the worker classifies by it — such a request is never re-sent unchanged
// within the job — and its record is what lands in jobs.last_error. Retrying
// the identical request has too little expected value to pay for, whatever
// the temperature.
export class CompressionTerminationError extends Error {
  constructor(
    message: string,
    readonly details: CompressionTerminationDetails,
  ) {
    super(`${message} ${formatTermination(details)}`);
    this.name = "CompressionTerminationError";
  }
}

// Parse failures of a complete (end_turn) response share the class: the
// parser only knows the text, the caller adds the model when it has one.
export function parseTerminationError(
  message: string,
  input: {
    reason: "not_json" | "bad_shape";
    stage: string;
    model?: string;
    output: string;
  },
): CompressionTerminationError {
  return new CompressionTerminationError(message, {
    reason: input.reason,
    finishReason: "end_turn",
    stage: input.stage,
    model: input.model,
    outputChars: input.output.length,
    excerpt: terminationExcerpt(input.output),
  });
}

// Shared stream-and-accumulate loop for compression-side jobs (summary,
// recent snapshot, later narrative consolidation). Throws when the stream
// ends without a done chunk, with empty text, or with a finish reason other
// than a natural end (e.g. max_tokens) — a truncated document must reach the
// job retry machinery, never a writer (2026-07-07 extraction incident:
// truncation read as success silently corrupts what gets persisted).
export async function streamCompressionText(input: {
  provider: ChatProvider;
  model: string;
  prompt: string;
  // Names the call in the termination record (one job may chain several).
  stage: string;
  // Identity frame for the call. Without it the model reads as a clerk
  // summarizing someone else's transcript and flattens the register the
  // sources have. Writers of the assistant's own memory pass the identity
  // frame; mechanical jobs may omit it.
  system?: string;
  temperature: number;
  maxOutputTokens: number;
  // Off/undefined = provider default (all live compression jobs). The MC-115
  // thinking replay arm is the only caller that sets it; the provider layer
  // already drops temperature when thinking is on.
  thinkingEnabled?: boolean;
  emptyErrorMessage: string;
}): Promise<string> {
  const messages: ModelMessage[] = [
    ...(input.system
      ? [{ role: "system", content: input.system } as ModelMessage]
      : []),
    { role: "user", content: input.prompt },
  ];
  let output = "";
  let completed = false;
  let finishReason: string | null = null;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;

  for await (const chunk of input.provider.stream(
    {
      model: input.model,
      messages,
      // Same gate as the chat route: 4.7+/5-series models reject sampling
      // params with a 400, so temperature is only sent to the allow-listed
      // legacy models and omitted otherwise.
      temperature: modelSupportsTemperature(input.model)
        ? input.temperature
        : undefined,
      maxOutputTokens: input.maxOutputTokens,
      thinkingEnabled: input.thinkingEnabled,
    },
    new AbortController().signal,
  )) {
    if (chunk.type === "text") {
      output += chunk.text;
    } else if (chunk.type === "usage") {
      inputTokens = chunk.inputTokens ?? inputTokens;
      outputTokens = chunk.outputTokens ?? outputTokens;
    } else if (chunk.type === "done") {
      completed = true;
      finishReason = chunk.finishReason ?? null;
      break;
    }
  }

  const terminate = (message: string, reason: string) =>
    new CompressionTerminationError(message, {
      reason,
      finishReason,
      stage: input.stage,
      model: input.model,
      cap: input.maxOutputTokens,
      inputTokens,
      outputTokens,
      outputChars: output.length,
      excerpt: terminationExcerpt(output),
    });

  if (completed && finishReason !== "end_turn") {
    throw terminate(
      `Compression output ended early (finish reason: ${
        finishReason ?? "none"
      }).`,
      finishReason ?? "none",
    );
  }

  const normalized = output.trim();
  if (!completed || !normalized) {
    throw terminate(input.emptyErrorMessage, "empty");
  }
  // One line per successful model call (the real-token diagnostic MC-121
  // deferred, without count_tokens): the provider's own billed counts from
  // the stream beside the stored text's estimator size; the termination path
  // above carries the same counts in its error record. Thinking bills as
  // output (adaptive by default on the 5-series and DeepSeek), so the visible
  // text's own tokens are outputEstimatorTokens divided by the writer's
  // measured estimator ratio (2026-10-02: Claude 4.7+/5-series ≈ 1.0 on
  // English, Claude 4.6 ≈ 1.34, DeepSeek v4 ≈ 1.5) and the rest of
  // outputTokens is reasoning — a raw difference is only right on the
  // 5-series.
  console.info("compression_usage", {
    stage: input.stage,
    model: input.model,
    inputTokens,
    outputTokens,
    outputChars: normalized.length,
    outputEstimatorTokens: estimateTextTokens(normalized),
  });
  return normalized;
}

function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current = error;
  while (current && chain.length < 10) {
    chain.push(current);
    current =
      current && typeof current === "object" && "cause" in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return chain;
}

// The termination anywhere in a wrapper chain (the narrative stage wrapper
// keeps it as `cause`); undefined when the failure is not a model-output one.
export function findTermination(
  error: unknown,
): CompressionTerminationError | undefined {
  return causeChain(error).find(
    (entry): entry is CompressionTerminationError =>
      entry instanceof CompressionTerminationError,
  );
}

export function isHostSuspended(error: unknown): boolean {
  return causeChain(error).some(
    (entry) => entry instanceof ProviderError && entry.code === "HOST_SUSPENDED",
  );
}
