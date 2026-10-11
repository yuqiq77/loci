// Model-emitted JSON often arrives wrapped in a markdown code fence; strip it
// before parsing. Shared by every job that parses structured model output —
// fence handling is correctness-sensitive (a swallowed parse failure reads as
// "zero results", the 2026-07-07 extraction incident), so it lives in one
// place.
export function stripJsonCodeFence(output: string): string {
  return output
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
}
