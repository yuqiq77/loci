import {
  CONTINUITY_CAPSULE_CHROME_TOKENS,
  estimateTextTokens,
} from "@/server/chat/context";
import { TOOL_LOOP_CONTEXT_RESERVE_TOKENS } from "@/shared/chat";

// The continuity budget arithmetic, in one client-safe module: the settings
// schema (validated in the browser too), the writers, the manual /profile
// cap, and the tests all read the same numbers. Nothing here touches the
// database or a provider. Every number is in estimator units (D14 as amended
// by MC-121).

// Target of the running thread-state summary: the figure its prompt states.
// It rides in the cached prefix (see context.ts), so it must not grow
// unbounded; the summary writer trims at its write cap below.
export const SUMMARY_TOKEN_BUDGET = 600;

// The narrative target is the owner's setting (narrative_target_tokens): the
// normal size of the long-term record and the figure its prompts state. It
// no longer derives from the capsule — raising the capsule adds margin, not
// record.
export const NARRATIVE_MIN_TARGET = 500;

// Each writer is told its target and writes to its own tokenizer's feel, so
// the stored size in estimator units lands off the stated figure by that
// writer's unit bias. Measured 2026-10-02 against each provider's own count
// on the frozen fixtures: Claude 4.7+/5-series 0.97–1.03× (English), Claude
// 4.6 1.30–1.39×, DeepSeek v4 1.44–1.58× (English and Chinese alike). The
// write caps absorb that bias instead of a per-model conversion: a shorten
// retry or rewrite fires only above the cap and asks for the target again,
// and the hard trim cuts only what still exceeds the cap.
export const NARRATIVE_WRITE_CAP_RATIO = 1.5;
// Snapshot and summary are written by the compression provider (DeepSeek).
export const COMPRESSION_WRITE_CAP_RATIO = 2;

export function narrativeWriteCap(target: number): number {
  return Math.ceil(target * NARRATIVE_WRITE_CAP_RATIO);
}

export function compressionWriteCap(target: number): number {
  return Math.ceil(target * COMPRESSION_WRITE_CAP_RATIO);
}

export type ContinuityBudgetInput = {
  capsuleTokenBudget: number;
  narrativeTargetTokens: number;
  recentSnapshotTokenBudget: number;
};

// The read limit a legal write needs: every section at its write cap plus the
// capsule's fixed text. The estimator rounds up once per text, so
// section-wise bounds sum to a bound on the assembled capsule; at or above
// this, assembly never trims a stored narrative (D20 as amended by MC-121).
export function requiredCapsuleTokens(
  input: Omit<ContinuityBudgetInput, "capsuleTokenBudget">,
): number {
  return (
    narrativeWriteCap(input.narrativeTargetTokens) +
    compressionWriteCap(input.recentSnapshotTokenBudget) +
    compressionWriteCap(SUMMARY_TOKEN_BUDGET) +
    CONTINUITY_CAPSULE_CHROME_TOKENS
  );
}

// The settings-time refusal when the capsule cannot seat every section at its
// write cap, else null — refused where the numbers are set, not at the next
// read.
export function capsuleBudgetRefusal(
  input: ContinuityBudgetInput,
): string | null {
  const required = requiredCapsuleTokens(input);
  if (input.capsuleTokenBudget >= required) {
    return null;
  }
  return `Capsule ${input.capsuleTokenBudget} is below the ${required} a full write needs: narrative cap ${narrativeWriteCap(input.narrativeTargetTokens)} (target ${input.narrativeTargetTokens} × ${NARRATIVE_WRITE_CAP_RATIO}) + snapshot cap ${compressionWriteCap(input.recentSnapshotTokenBudget)} (${input.recentSnapshotTokenBudget} × ${COMPRESSION_WRITE_CAP_RATIO}) + summary cap ${compressionWriteCap(SUMMARY_TOKEN_BUDGET)} (${SUMMARY_TOKEN_BUDGET} × ${COMPRESSION_WRITE_CAP_RATIO}) + chrome ${CONTINUITY_CAPSULE_CHROME_TOKENS}.`;
}

export type ChatWindowBudgetInput = {
  systemPrompt: string;
  maxOutputTokens: number;
  contextTokenBudget: number;
  capsuleTokenBudget: number;
  memoryTokenBudget: number;
  summaryTriggerTokens: number;
  toolsEnabled: boolean;
};

// The MC-108 no-blind-spot invariant, refused where the numbers are set: the
// chat window must seat a whole unsummarized history — up to the summary
// trigger — beside everything assembly spends first (the reply, the tool-loop
// reserve, the system prompt, a full capsule), with the anchors' budget still
// free. Short of it, the oldest unsummarized turns leave the window before any
// summary covers them, and the anchors, selected after history, get nothing.
// Known limits, all on the side of the slack a setting keeps above the
// bound: the current user message is not counted (it rides in the same
// window, and its length is the sender's), transcript stamps add ~7
// estimator tokens per turn on top of the trigger's content count, and a
// summary job lags its trigger by a turn. The reserve counts whenever tools
// are on in the settings; assembly skips it when no tool is actually enabled
// (memory unconfigured), so the rule is at most the reserve stricter than
// the window it guards, never looser.
export function chatWindowRefusal(input: ChatWindowBudgetInput): string | null {
  const reserve = input.toolsEnabled ? TOOL_LOOP_CONTEXT_RESERVE_TOKENS : 0;
  const systemTokens = estimateTextTokens(input.systemPrompt);
  const free =
    input.contextTokenBudget -
    input.maxOutputTokens -
    reserve -
    systemTokens -
    input.capsuleTokenBudget;
  const required = input.summaryTriggerTokens + input.memoryTokenBudget;
  if (free >= required) {
    return null;
  }
  return `Context ${input.contextTokenBudget} leaves ${free} for history and anchors, below the ${required} a full unsummarized history needs: summary threshold ${input.summaryTriggerTokens} + memory ${input.memoryTokenBudget}, after output ${input.maxOutputTokens} + tool reserve ${reserve} + system prompt ${systemTokens} + capsule ${input.capsuleTokenBudget}.`;
}
