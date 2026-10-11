import { describe, expect, it } from "vitest";

import {
  settingsSchema,
  type SettingsInput,
} from "@/server/settings/schema";

function validSettings(
  overrides: Partial<SettingsInput> = {},
): SettingsInput {
  return {
    systemPrompt: "You are helpful.",
    temperature: 0.7,
    maxOutputTokens: 2048,
    contextTokenBudget: 96_000,
    recentMessageBudget: 48_000,
    memoryTokenBudget: 2000,
    capsuleTokenBudget: 12_000,
    narrativeTargetTokens: 6400,
    recentSnapshotTokenBudget: 400,
    summaryTriggerTokens: 72_000,
    memoryRetrievalLimit: 5,
    webSearchEnabled: true,
    toolsEnabled: false,
    ...overrides,
  };
}

function fieldIssues(input: SettingsInput): string[] {
  const result = settingsSchema.safeParse(input);
  return result.success
    ? []
    : result.error.issues.map((issue) => issue.path.join("."));
}

describe("settings schema", () => {
  it("accepts a valid complete settings document", () => {
    expect(settingsSchema.safeParse(validSettings()).success).toBe(true);
  });

  it("round-trips the web search toggle", () => {
    expect(settingsSchema.parse(validSettings({ webSearchEnabled: false })))
      .toMatchObject({ webSearchEnabled: false });
  });

  it("round-trips the recent snapshot token budget", () => {
    expect(
      settingsSchema.parse(validSettings({ recentSnapshotTokenBudget: 250 })),
    ).toMatchObject({ recentSnapshotTokenBudget: 250 });
  });

  it("round-trips the continuity capsule token budget", () => {
    // Exactly what the defaults need: 9600 + 800 + 1200 + 42 (MC-121).
    expect(
      settingsSchema.parse(validSettings({ capsuleTokenBudget: 11_642 })),
    ).toMatchObject({ capsuleTokenBudget: 11_642 });
    // The largest capsule needs a wider window to keep the history seat.
    expect(
      settingsSchema.parse(
        validSettings({ capsuleTokenBudget: 24_000, contextTokenBudget: 110_000 }),
      ),
    ).toMatchObject({ capsuleTokenBudget: 24_000 });
  });

  it("round-trips the narrative target independently of the capsule", () => {
    expect(
      settingsSchema.parse(validSettings({ narrativeTargetTokens: 500 })),
    ).toMatchObject({ narrativeTargetTokens: 500, capsuleTokenBudget: 12_000 });
  });

  it.each([
    ["temperature below range", { temperature: -0.1 }, "temperature"],
    ["temperature above range", { temperature: 2.1 }, "temperature"],
    ["output below range", { maxOutputTokens: 255 }, "maxOutputTokens"],
    ["output above range", { maxOutputTokens: 16_385 }, "maxOutputTokens"],
    ["memory budget below range", { memoryTokenBudget: -1 }, "memoryTokenBudget"],
    ["memory budget above range", { memoryTokenBudget: 8001 }, "memoryTokenBudget"],
    [
      "capsule budget below range",
      { capsuleTokenBudget: 1499 },
      "capsuleTokenBudget",
    ],
    [
      "capsule budget above range",
      { capsuleTokenBudget: 24_001 },
      "capsuleTokenBudget",
    ],
    [
      "narrative target below range",
      { narrativeTargetTokens: 499 },
      "narrativeTargetTokens",
    ],
    [
      "narrative target above range",
      { narrativeTargetTokens: 12_001 },
      "narrativeTargetTokens",
    ],
    [
      "recent snapshot budget below range",
      { recentSnapshotTokenBudget: 0 },
      "recentSnapshotTokenBudget",
    ],
    [
      "recent snapshot budget above range",
      { recentSnapshotTokenBudget: 2001 },
      "recentSnapshotTokenBudget",
    ],
    [
      "memory limit below range",
      { memoryRetrievalLimit: -1 },
      "memoryRetrievalLimit",
    ],
    [
      "memory limit above range",
      { memoryRetrievalLimit: 21 },
      "memoryRetrievalLimit",
    ],
    ["empty system prompt", { systemPrompt: " " }, "systemPrompt"],
  ])("rejects %s", (_label, patch, field) => {
    expect(fieldIssues(validSettings(patch))).toContain(field);
  });

  it("requires context budget to reserve output plus 2000 tokens", () => {
    expect(
      fieldIssues(
        validSettings({
          maxOutputTokens: 4000,
          contextTokenBudget: 5999,
        }),
      ),
    ).toContain("contextTokenBudget");
  });

  it("requires recent message budget below context budget", () => {
    expect(
      fieldIssues(
        validSettings({
          contextTokenBudget: 10_000,
          recentMessageBudget: 10_000,
        }),
      ),
    ).toContain("recentMessageBudget");
  });

  it("requires summary threshold above recent message budget", () => {
    expect(
      fieldIssues(
        validSettings({
          recentMessageBudget: 5000,
          summaryTriggerTokens: 5000,
        }),
      ),
    ).toContain("summaryTriggerTokens");
  });

  it("refuses a capsule that cannot seat every section at its write cap", () => {
    // A row from before the rule: capsule 8000 beside target 6400 and
    // snapshot 500 needs 9600 + 1000 + 1200 + 42 = 11842.
    const owner = validSettings({
      capsuleTokenBudget: 8000,
      recentSnapshotTokenBudget: 500,
    });
    const result = settingsSchema.safeParse(owner);
    expect(result.success).toBe(false);
    expect(fieldIssues(owner)).toEqual(["capsuleTokenBudget"]);
    expect(result.success ? "" : result.error.issues[0].message).toBe(
      "Capsule 8000 is below the 11842 a full write needs: narrative cap 9600 (target 6400 × 1.5) + snapshot cap 1000 (500 × 2) + summary cap 1200 (600 × 2) + chrome 42.",
    );
    expect(
      fieldIssues({ ...owner, capsuleTokenBudget: 11_841 }),
    ).toEqual(["capsuleTokenBudget"]);
    expect(
      settingsSchema.safeParse({ ...owner, capsuleTokenBudget: 11_842 }).success,
    ).toBe(true);
    // The shipped defaults pass: 12000 ≥ 9600 + 800 + 1200 + 42.
    expect(settingsSchema.safeParse(validSettings()).success).toBe(true);
  });

  it("refuses a context window that cannot seat a full unsummarized history", () => {
    // The pre-0019 shipped trio: 32000 − 2048 − 3200 − 6 − 12000 = 14746
    // free, against 20000 + 2000.
    const shipped = validSettings({
      contextTokenBudget: 32_000,
      recentMessageBudget: 16_000,
      summaryTriggerTokens: 20_000,
      toolsEnabled: true,
    });
    const result = settingsSchema.safeParse(shipped);
    expect(fieldIssues(shipped)).toEqual(["contextTokenBudget"]);
    expect(result.success ? "" : result.error.issues[0].message).toBe(
      "Context 32000 leaves 14746 for history and anchors, below the 22000 a full unsummarized history needs: summary threshold 20000 + memory 2000, after output 2048 + tool reserve 3200 + system prompt 6 + capsule 12000.",
    );
    // The shipped defaults pass with tools on: 96000 − 2048 − 3200 − 6 −
    // 12000 = 78746 ≥ 72000 + 2000.
    expect(
      settingsSchema.safeParse(validSettings({ toolsEnabled: true })).success,
    ).toBe(true);
    // Below the basic floor only that message fires, not the window rule.
    const floor = validSettings({
      contextTokenBudget: 3000,
      recentMessageBudget: 1000,
      summaryTriggerTokens: 1500,
    });
    expect(fieldIssues(floor)).toEqual(["contextTokenBudget"]);
    const floorResult = settingsSchema.safeParse(floor);
    expect(floorResult.success ? "" : floorResult.error.issues[0].message).toBe(
      "Context budget must be at least output tokens plus 2000.",
    );
    // The tool reserve counts only while tools are on.
    const edge = validSettings({ contextTokenBudget: 88_054 });
    expect(settingsSchema.safeParse(edge).success).toBe(true);
    expect(fieldIssues({ ...edge, contextTokenBudget: 88_053 })).toEqual([
      "contextTokenBudget",
    ]);
    expect(fieldIssues({ ...edge, toolsEnabled: true })).toEqual([
      "contextTokenBudget",
    ]);
  });

  it("rejects unknown fields", () => {
    expect(
      settingsSchema.safeParse({
        ...validSettings(),
        chatApiKey: "must-not-be-accepted",
      }).success,
    ).toBe(false);
  });
});
