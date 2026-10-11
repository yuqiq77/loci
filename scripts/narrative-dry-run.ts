import { writeFile } from "node:fs/promises";
import path from "node:path";

import { loadEnvConfig } from "@next/env";

import { estimateTextTokens } from "../src/server/chat/context";
import { closeDatabase } from "../src/server/db/client";
import {
  buildNarrativeConsolidationDryRun,
  generateNarrativeWithProviderFallback,
  type ConsolidationMode,
} from "../src/server/summaries/consolidate-narrative";

loadEnvConfig(process.cwd());

type Options = {
  generate: boolean;
  mode: ConsolidationMode;
  outputPath?: string;
};

function parseArgs(args: string[]): Options {
  let generate = false;
  let mode: ConsolidationMode = "incremental";
  let outputPath: string | undefined;

  for (const arg of args) {
    if (arg === "--generate" || arg === "--rehearse") {
      generate = true;
    } else if (arg === "incremental" || arg === "rebuild") {
      mode = arg;
    } else if (!outputPath) {
      outputPath = arg;
    } else {
      throw new Error(
        "Usage: npm run narrative:dry-run -- [incremental|rebuild] [--generate] [output-path]",
      );
    }
  }

  return { generate, mode, outputPath };
}

function formatSection(title: string, content: string): string {
  return [`## ${title}`, "", content.trim() || "(none)"].join("\n");
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const mode = options.mode;
  const outputPath =
    options.outputPath ??
    path.join(
      "/tmp",
      `loci-narrative-${options.generate ? "rehearsal" : "dry-run"}-${mode}.md`,
    );
  const dryRun = await buildNarrativeConsolidationDryRun(mode);
  const rawTailTimes = dryRun.sources.rawTail.map(
    (message) => message.completedAt,
  );
  const oldestRawTail =
    rawTailTimes.length > 0
      ? new Date(Math.min(...rawTailTimes.map((date) => date.getTime())))
      : null;
  const newestRawTail =
    rawTailTimes.length > 0
      ? new Date(Math.max(...rawTailTimes.map((date) => date.getTime())))
      : null;

  const summary = [
    `# Narrative Consolidation ${options.generate ? "Rehearsal" : "Dry Run"}`,
    "",
    `- Mode: ${dryRun.mode}`,
    `- Provider chain: ${dryRun.candidates
      .map(
        (candidate) =>
          `${candidate.label} (${candidate.model} @ ${hostOf(candidate.baseUrl)})`,
      )
      .join(" → ")}`,
    `- Source through: ${dryRun.sourceThrough.toISOString()}`,
    `- Current watermark: ${dryRun.watermark.toISOString()}`,
    `- Current narrative version: ${dryRun.expectedVersion}`,
    `- Capsule token budget (read limit): ${dryRun.capsuleTokenBudget}`,
    `- Narrative target (setting, stated in the prompt, estimator units): ${dryRun.targetTokens}`,
    `- Narrative write cap (shorten retry and hard trim above this): ${dryRun.capTokens}`,
    `- Max output tokens for real job: ${dryRun.maxOutputTokens}`,
    `- Estimated consolidation prompt tokens: ${dryRun.promptTokensEstimate}`,
    `- Would skip as no-new-material: ${dryRun.wouldSkipNoNewMaterial}`,
    `- Summaries: ${dryRun.sources.summaries.length}`,
    `- Raw tail turns: ${dryRun.sources.rawTail.length}`,
    `- Raw tail window: ${
      oldestRawTail && newestRawTail
        ? `${oldestRawTail.toISOString()} .. ${newestRawTail.toISOString()}`
        : "(none)"
    }`,
    `- Raw tail dropped by the cap: ${
      dryRun.sources.rawTailDropped.length > 0
        ? dryRun.sources.rawTailDropped
            .map(
              (drop) =>
                `${drop.sessionId ?? "whole tail"}: ${drop.turns} turns / ${drop.tokens ?? "uncounted"} tokens`,
            )
            .join("; ")
        : "(none)"
    }`,
    `- Memory rows: ${dryRun.sources.memories.length}`,
    `- Open threads reviewed: ${dryRun.openThreads.length}`,
    `- Estimated review prompt tokens: ${
      dryRun.reviewPromptTokensEstimate ?? "(not built)"
    }`,
    "",
    options.generate
      ? "This command calls the model but does not write narrative versions or advance the watermark."
      : "This command does not call the model, write narrative versions, or advance the watermark.",
  ].join("\n");

  let rehearsal = "";
  if (options.generate && dryRun.wouldSkipNoNewMaterial) {
    rehearsal = formatSection(
      "Model Rehearsal",
      "Skipped: this dry-run has no new material, matching the real job no-op path.",
    );
  } else if (options.generate) {
    // Same pipeline as the real job: provider chain with fallback →
    // generate → strip → shorten-retry over the cap → hard trim at the cap.
    const generation = await generateNarrativeWithProviderFallback({
      prompt: dryRun.prompt,
      targetTokens: dryRun.targetTokens,
      maxOutputTokens: dryRun.maxOutputTokens,
    });
    const { content: candidate, rawOutput, retried } = generation;
    rehearsal = [
      [
        "## Model Rehearsal Summary",
        "",
        `- Winning provider: ${generation.candidate.label} (${generation.candidate.model} @ ${hostOf(generation.candidate.baseUrl)})`,
        `- Raw output estimated tokens: ${estimateTextTokens(rawOutput)}`,
        `- Shorten-retry triggered: ${retried}`,
        `- Candidate estimated tokens after strip/retry/cap: ${estimateTextTokens(candidate)}`,
        `- Raw output contains ## Current: ${/^##\s+Current\b/imu.test(rawOutput)}`,
        `- Raw output contains ## Anchors: ${/^##\s+Anchors\b/imu.test(rawOutput)}`,
        `- Candidate contains ## Current: ${/^##\s+Current\b/imu.test(candidate)}`,
        `- Candidate contains ## Anchors: ${/^##\s+Anchors\b/imu.test(candidate)}`,
      ].join("\n"),
      "",
      formatSection("Raw Model Output", rawOutput),
      "",
      formatSection("Candidate Narrative After Write-Time Cap", candidate),
    ].join("\n");
  }

  const content = [
    summary,
    "",
    rehearsal,
    "",
    formatSection("Consolidation Prompt", dryRun.prompt),
    "",
    formatSection("Resolution Review Prompt", dryRun.reviewPrompt ?? ""),
  ].join("\n");

  await writeFile(outputPath, content, "utf8");

  console.log(summary);
  console.log("");
  console.log(`Wrote: ${outputPath}`);
}

main()
  .catch((error: unknown) => {
    console.error("Narrative dry-run failed.", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabase();
  });
