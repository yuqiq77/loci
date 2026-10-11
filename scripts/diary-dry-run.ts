import { writeFile } from "node:fs/promises";
import path from "node:path";

import { loadEnvConfig } from "@next/env";

import { estimateTextTokens } from "../src/server/chat/context";
import { closeDatabase } from "../src/server/db/client";
import {
  consolidationProviderCandidates,
} from "../src/server/summaries/consolidate-narrative";
import { COMPRESSION_MAX_OUTPUT_TOKENS } from "../src/server/summaries/compression";
import {
  buildDiaryEntryDryRun,
  generateDiaryEntryWithProviderFallback,
} from "../src/server/summaries/diary";

loadEnvConfig(process.cwd());

type Options = {
  date: string;
  generate: boolean;
  outputPath?: string;
};

function parseArgs(args: string[]): Options {
  let date: string | undefined;
  let generate = false;
  let outputPath: string | undefined;
  for (const arg of args) {
    if (arg === "--generate" || arg === "--rehearse") {
      generate = true;
    } else if (!date) {
      date = arg;
    } else if (!outputPath) {
      outputPath = arg;
    } else {
      throw new Error(
        "Usage: npm run diary:dry-run -- YYYY-MM-DD [--generate] [output-path]",
      );
    }
  }
  if (!date || !/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
    throw new Error(
      "Usage: npm run diary:dry-run -- YYYY-MM-DD [--generate] [output-path]",
    );
  }
  return { date, generate, outputPath };
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
  const dryRun = await buildDiaryEntryDryRun(options.date);
  const outputPath =
    options.outputPath ??
    path.join(
      "/tmp",
      `loci-diary-${options.generate ? "rehearsal" : "dry-run"}-${options.date}.md`,
    );
  const candidates = consolidationProviderCandidates();
  const summary = [
    `# Diary ${options.generate ? "Rehearsal" : "Dry Run"}: ${options.date}`,
    "",
    `- Window: ${dryRun.window.start.toISOString()} .. ${dryRun.window.end.toISOString()}`,
    `- Source turns: ${dryRun.turns.length}`,
    `- Baseline source: ${dryRun.baselineSource}`,
    `- Baseline characters: ${dryRun.baseline?.length ?? 0}`,
    `- Estimated prompt tokens: ${dryRun.prompt ? estimateTextTokens(dryRun.prompt) : "(not built)"}`,
    `- Max output tokens for real job: ${COMPRESSION_MAX_OUTPUT_TOKENS}`,
    `- Would skip as no material: ${dryRun.wouldSkipNoMaterial}`,
    `- Provider chain: ${candidates
      .map(
        (candidate) =>
          `${candidate.label} (${candidate.model} @ ${hostOf(candidate.baseUrl)})`,
      )
      .join(" → ")}`,
    "",
    options.generate
      ? "This command calls the model but never inserts or replaces a diary entry."
      : "This command does not call the model or write a diary entry.",
  ].join("\n");

  let rehearsal = "";
  if (options.generate && dryRun.prompt) {
    const generation = await generateDiaryEntryWithProviderFallback(
      dryRun.prompt,
    );
    rehearsal = [
      "## Model Rehearsal",
      "",
      `- Winning provider: ${generation.candidate.label} (${generation.candidate.model} @ ${hostOf(generation.candidate.baseUrl)})`,
      `- Output characters: ${generation.content.length}`,
      "",
      generation.content,
    ].join("\n");
  } else if (options.generate) {
    rehearsal = "## Model Rehearsal\n\nSkipped: the day has no journalable material.";
  }

  const content = [
    summary,
    rehearsal,
    "## Diary Prompt",
    "",
    dryRun.prompt ?? "(none)",
  ]
    .filter(Boolean)
    .join("\n\n");
  await writeFile(outputPath, content, "utf8");
  console.log(summary);
  console.log("");
  console.log(`Wrote: ${outputPath}`);
}

main()
  .catch((error: unknown) => {
    console.error("Diary dry-run failed.", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabase();
  });
