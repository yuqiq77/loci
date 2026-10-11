// MC-117B controlled cache experiment (Scope 3): does adding the
// search_memory tool definition keep a stable prompt-cache identity?
//
// Four arms against the official endpoint, webSearchEnabled pinned false
// (decision 8 — a server tool in the tools array would confound the read):
//   1. on-cold  — expect cache_creation_input_tokens > 0
//   2. on-warm  — identical config; cache_read_input_tokens ≈ prefix is the
//                 BLOCKING condition for enablement
//   3. in-attempt round 2 — the continuation request must read what round 1
//                 wrote (the loop must not self-bust)
//   4. forced-final — warm a long messages prefix with auto, change only
//                 toolChoice to none, then return to auto. Reports cache
//                 token deltas and timings without changing production.
//
// The prefix is synthetic filler — no fixture or owner data ever leaves the
// machine. Usage: npm run tools:cache-probe. Config is fixed per the ticket:
// the CONSOLIDATION_* triple (the official-API fallback in this deployment),
// refused unless it points at the official endpoint. Related:
// scripts/cache-diagnose.mjs is the older general breakpoint probe; this one
// measures the tools field specifically and supersedes it for that question.

import { randomUUID } from "node:crypto";
import { loadEnvConfig } from "@next/env";

import {
  AnthropicChatProvider,
  isOfficialAnthropicEndpoint,
} from "../src/server/chat/anthropic";
import {
  serializeToolDefinition,
  toolSchemaHash,
} from "../src/server/chat/tool-registry";
import { searchMemoryTool } from "../src/server/chat/tools/search-memory";
import type {
  AssistantContentBlock,
  ChatChunk,
  ChatRequest,
} from "../src/server/chat/types";
import { getConsolidationEnv } from "../src/server/env";

loadEnvConfig(process.cwd());

// Comfortably above every model's minimum cacheable prefix length, and
// deterministic so warm reads see identical bytes.
function syntheticPrefix(): string {
  const sentences: string[] = [];
  for (let index = 0; index < 220; index += 1) {
    sentences.push(
      `Reference paragraph ${index}: the probe corpus enumerates neutral facts about fictional lighthouse ${index}, whose lamp rotates every ${(index % 9) + 2} seconds and whose keeper logs ${(index % 5) + 1} entries per tide cycle.`,
    );
  }
  return `You are a terse assistant used for a caching probe. Answer in one short sentence.\n\n${sentences.join(" ")}`;
}

type Usage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
};

async function runArm(
  provider: AnthropicChatProvider,
  request: ChatRequest,
): Promise<{
  usage: Usage;
  blocks: AssistantContentBlock[];
  text: string;
  elapsedMs: number;
  providerFirstTextMs: number | null;
  finishReason: string | undefined;
}> {
  const startedAt = performance.now();
  // Request start → first provider text chunk, same measurement point as the
  // loop trace. A client-side first-visible-character latency, if ever
  // recorded, is a separate clientFirstTextMs — never this field.
  let providerFirstTextMs: number | null = null;
  let finishReason: string | undefined;
  const usage: Usage = {};
  const blocks: AssistantContentBlock[] = [];
  let text = "";
  for await (const chunk of provider.stream(
    request,
    new AbortController().signal,
  ) as AsyncIterable<ChatChunk>) {
    if (chunk.type === "usage") {
      usage.inputTokens = chunk.inputTokens ?? usage.inputTokens;
      usage.outputTokens = chunk.outputTokens ?? usage.outputTokens;
      usage.cacheCreationInputTokens =
        chunk.cacheCreationInputTokens ?? usage.cacheCreationInputTokens;
      usage.cacheReadInputTokens =
        chunk.cacheReadInputTokens ?? usage.cacheReadInputTokens;
    } else if (chunk.type === "content_block") {
      blocks.push(chunk.block);
    } else if (chunk.type === "text") {
      providerFirstTextMs ??= Math.round(performance.now() - startedAt);
      text += chunk.text;
    } else if (chunk.type === "done") {
      finishReason = chunk.finishReason;
    }
  }
  return {
    usage,
    blocks,
    text,
    elapsedMs: Math.round(performance.now() - startedAt),
    providerFirstTextMs,
    finishReason,
  };
}

function armMetrics(result: Awaited<ReturnType<typeof runArm>>) {
  const { usage, elapsedMs, providerFirstTextMs, finishReason, blocks } = result;
  // The adapter's inputTokens includes uncached input + cache reads + writes.
  const uncachedInputTokens = usage.inputTokens === undefined
    ? null
    : usage.inputTokens - (usage.cacheReadInputTokens ?? 0) -
      (usage.cacheCreationInputTokens ?? 0);
  return {
    ...usage,
    uncachedInputTokens,
    elapsedMs,
    providerFirstTextMs,
    finishReason,
    toolUseCount: blocks.filter((block) => block.type === "tool_use").length,
  };
}

async function main(): Promise<void> {
  const env = getConsolidationEnv();
  const apiKey = env.CONSOLIDATION_API_KEY;
  const baseUrl = env.CONSOLIDATION_BASE_URL;
  const model = env.CONSOLIDATION_MODEL;
  if (!isOfficialAnthropicEndpoint(baseUrl)) {
    throw new Error(
      `The cache probe only runs against the official endpoint (got ${baseUrl}); a relay's cache behavior is not the number this experiment needs.`,
    );
  }

  const provider = new AnthropicChatProvider({
    apiKey,
    baseUrl,
    promptCaching: true,
    // webSearchEnabled pinned false: the provider option is simply omitted.
  });
  const tools = [serializeToolDefinition(searchMemoryTool)];
  const system = syntheticPrefix();
  const baseRequest: ChatRequest = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: "Reply with exactly: OK" },
    ],
    maxOutputTokens: 256,
    tools,
    collectBlocks: true,
  };
  const requestBytes = Buffer.byteLength(JSON.stringify(baseRequest));
  const report: Record<string, unknown> = {
    model,
    baseUrl,
    tool_schema_hash: toolSchemaHash(searchMemoryTool),
    request_bytes_estimate: requestBytes,
  };

  console.log("arm 1: on-cold…");
  const cold = await runArm(provider, baseRequest);
  report.arm1_on_cold = cold.usage;

  console.log("arm 2: on-warm (identical config)…");
  const warm = await runArm(provider, baseRequest);
  report.arm2_on_warm = warm.usage;

  console.log("arm 3: in-attempt round 2…");
  // One literal for both rounds: the arrays must stay byte-identical or the
  // arm measures a script-caused miss instead of the loop's behavior.
  const arm3Messages = [
    { role: "system" as const, content: system },
    {
      role: "user" as const,
      content:
        "Call the search_memory tool with query \"lighthouse probe\" before answering.",
    },
  ];
  const round1 = await runArm(provider, {
    ...baseRequest,
    messages: arm3Messages,
  });
  report.arm3_round1 = round1.usage;
  const toolUse = round1.blocks.find(
    (block): block is Extract<AssistantContentBlock, { type: "tool_use" }> =>
      block.type === "tool_use",
  );
  if (!toolUse) {
    report.arm3_note =
      "model did not call the tool; round-2 arm not measured this run";
  } else {
    const round2 = await runArm(provider, {
      ...baseRequest,
      messages: arm3Messages,
      toolTurns: [
        { role: "assistant", blocks: round1.blocks },
        {
          role: "user",
          blocks: [
            {
              type: "tool_result",
              toolUseId: toolUse.id,
              content: JSON.stringify({ items: [] }),
            },
          ],
        },
      ],
    });
    report.arm3_round2 = round2.usage;
  }

  // The ticket's condition is cache_read ≈ prefix, not merely nonzero: a
  // partially-busting identity (tools cached, system re-written) must FAIL.
  const coldCreated =
    (report.arm1_on_cold as Usage).cacheCreationInputTokens ?? 0;
  const warmRead = (report.arm2_on_warm as Usage).cacheReadInputTokens ?? 0;
  report.blocking_condition =
    coldCreated > 0 && warmRead >= coldCreated
      ? `PASS (warm read ${warmRead} of ${coldCreated} created tokens)`
      : `FAIL (cold created ${coldCreated}, warm read ${warmRead} — enablement blocked)`;

  console.log("arm 4: forced-final with a long settled messages prefix…");
  // Arms 1–3 only cache a long SYSTEM prefix. They cannot measure a messages-
  // level miss. A fresh marker keeps prior probe runs from warming this arm's
  // history, while leaving tools + system identical to the earlier arms.
  // The adapter marks the second-to-last history message (the assistant
  // acknowledgement) with cache_control; the current user and replay follow it.
  const forcedFinalRequest: ChatRequest = {
    ...baseRequest,
    toolChoice: "auto",
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: `Synthetic history for probe ${randomUUID()}.\n${syntheticPrefix()}`,
      },
      { role: "assistant", content: "I have read the fictional reference." },
      { role: "user", content: "Check memory, then reply with exactly: OK" },
    ],
    // Fixed synthetic replay isolates the parameter change from model output
    // variation. No database lookup or real tool execution is performed.
    toolTurns: [
      {
        role: "assistant",
        blocks: [{
          type: "tool_use",
          id: "toolu_cache_probe_final",
          name: searchMemoryTool.name,
          input: { query: "lighthouse probe" },
        }],
      },
      {
        role: "user",
        blocks: [{
          type: "tool_result",
          toolUseId: "toolu_cache_probe_final",
          content: JSON.stringify({ items: [], note: "Lookup complete. Reply OK." }),
        }],
      },
    ],
  };
  const autoPrime = armMetrics(await runArm(provider, forcedFinalRequest));
  console.log("arm 4: auto warm…");
  const autoWarm = armMetrics(await runArm(provider, forcedFinalRequest));
  console.log("arm 4: forced none (same history and replay)…");
  const forcedNone = armMetrics(await runArm(provider, {
    ...forcedFinalRequest,
    toolChoice: "none",
  }));
  console.log("arm 4: auto recovery…");
  const autoRecovery = armMetrics(await runArm(provider, forcedFinalRequest));
  const historyWarm =
    (autoPrime.cacheCreationInputTokens ?? 0) > 0 &&
    (autoWarm.cacheReadInputTokens ?? 0) >=
      (autoPrime.cacheReadInputTokens ?? 0) +
      (autoPrime.cacheCreationInputTokens ?? 0);
  report.arm4_forced_final = {
    auto_prime: autoPrime,
    auto_warm: autoWarm,
    forced_none: forcedNone,
    auto_recovery: autoRecovery,
    measurement_valid: historyWarm &&
      [autoWarm, forcedNone, autoRecovery].every((arm) =>
        arm.inputTokens !== undefined && arm.toolUseCount === 0 &&
        arm.finishReason === "end_turn"),
    history_cache_warm: historyWarm,
    none_minus_auto_warm: {
      cacheReadInputTokens: (forcedNone.cacheReadInputTokens ?? 0) -
        (autoWarm.cacheReadInputTokens ?? 0),
      cacheCreationInputTokens: (forcedNone.cacheCreationInputTokens ?? 0) -
        (autoWarm.cacheCreationInputTokens ?? 0),
      uncachedInputTokens: forcedNone.uncachedInputTokens === null ||
        autoWarm.uncachedInputTokens === null ? null :
        forcedNone.uncachedInputTokens - autoWarm.uncachedInputTokens,
      outputTokens: (forcedNone.outputTokens ?? 0) - (autoWarm.outputTokens ?? 0),
      elapsedMs: forcedNone.elapsedMs - autoWarm.elapsedMs,
      providerFirstTextMs: forcedNone.providerFirstTextMs === null || autoWarm.providerFirstTextMs === null
        ? null : forcedNone.providerFirstTextMs - autoWarm.providerFirstTextMs,
    },
    note: "Cost = uncached tokens × input rate + cache writes × 5m write rate + cache reads × read rate; output is separate. Use this model's current rates. Timings are single samples, not a benchmark. Only interpret deltas when measurement_valid is true.",
  };

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
