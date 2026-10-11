// Lenient reader for jobs.last_error (MC-123). The worker writes the whole
// cause chain, bounded to JOB_ERROR_MAX_LENGTH, and a model-output
// termination lands inside it in the `CompressionTerminationError` format:
// `<message> [stage=S model=M cap=N output_tokens=N chars=N] excerpt: …`,
// possibly wrapped by a ProviderChainError summary that joins one such
// record per candidate with "; ". This module only reads that format; how
// it is written stays in summaries/compression.ts.

export const JOB_ERROR_MAX_LENGTH = 2_000;

export type JobErrorRecord = {
  stage: string;
  model: string | null;
  cap: number | null;
  outputTokens: number | null;
  outputChars: number;
  // From the "(finish reason: X)" clause preceding the record, when present.
  finishReason: string | null;
  excerpt: string;
};

export type DecodedJobError = {
  raw: string;
  // The first termination record found, or null for plain-text errors.
  record: JobErrorRecord | null;
  // How many records the text carries (one per exhausted candidate).
  records: number;
  // The text hit the length bound or a record's bracket was cut: what
  // parsed is shown, but the record is not the whole story.
  partial: boolean;
};

const RECORD_HEAD = /\[stage=(\S+)((?: \w+=\S+)*)\] excerpt: /g;
// Where one record's excerpt ends: the next candidate's outcome inside a
// ProviderChainError summary (its labels are exactly `chat` and
// `consolidation`), the next cause line, or the next record.
const EXCERPT_END = /; (?:chat|consolidation) \([^)]*\): |\n|\[stage=/;

function numberField(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function decodeJobError(raw: string | null): DecodedJobError | null {
  if (raw === null) {
    return null;
  }
  const heads = [...raw.matchAll(RECORD_HEAD)];
  const unclosed = /\[stage=[^\]]*$/.test(raw);
  const partial = unclosed || raw.length >= JOB_ERROR_MAX_LENGTH;
  const head = heads[0];
  if (!head || head.index === undefined) {
    return { raw, record: null, records: 0, partial };
  }

  const fields = new Map<string, string>();
  for (const pair of head[2].trim().split(" ").filter(Boolean)) {
    const [key, value] = pair.split("=", 2);
    fields.set(key, value);
  }
  const before = raw.slice(0, head.index);
  const finishReason = /finish reason: ([^)]+)\)/.exec(before)?.[1] ?? null;
  const rest = raw.slice(head.index + head[0].length);
  const end = EXCERPT_END.exec(rest);
  const excerpt = (end ? rest.slice(0, end.index) : rest).trim();

  return {
    raw,
    record: {
      stage: head[1],
      model: fields.get("model") ?? null,
      cap: numberField(fields.get("cap")),
      outputTokens: numberField(fields.get("output_tokens")),
      outputChars: numberField(fields.get("chars")) ?? 0,
      finishReason,
      excerpt: excerpt === "(none)" ? "" : excerpt,
    },
    records: heads.length,
    partial,
  };
}
