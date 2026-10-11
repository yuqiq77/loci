import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireOwner: vi.fn(async () => null),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  isMemoryEnabled: vi.fn(),
}));

vi.mock("@/server/auth/request", () => ({
  requireOwner: mocks.requireOwner,
}));
vi.mock("@/server/db/settings", () => ({
  getSettings: mocks.getSettings,
  updateSettings: mocks.updateSettings,
}));
vi.mock("@/server/memory/embedding", () => ({
  isMemoryEnabled: mocks.isMemoryEnabled,
}));

const storedSettings = {
  id: 1,
  systemPrompt: "You are helpful.",
  defaultModelId: "claude-opus-4-6",
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
  updatedAt: new Date("2026-06-15T12:00:00Z"),
};

function request(method: "GET" | "PUT", body?: unknown) {
  return new NextRequest("http://localhost/api/settings", {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
}

describe("settings routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue(storedSettings);
    mocks.updateSettings.mockResolvedValue(storedSettings);
    mocks.isMemoryEnabled.mockReturnValue(false);
  });

  it("returns editable settings and safe provider metadata only", async () => {
    const { GET } = await import("@/app/api/settings/route");
    const response = await GET(request("GET"));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      settings: {
        systemPrompt: "You are helpful.",
        capsuleTokenBudget: 12_000,
        narrativeTargetTokens: 6400,
        recentSnapshotTokenBudget: 400,
        webSearchEnabled: true,
        toolsEnabled: false,
      },
      models: [
        { id: "claude-fable-5-1", label: "Fable 5.1" },
        { id: "claude-fable-5", label: "Fable 5" },
        { id: "claude-opus-5-5", label: "Opus 5.5" },
        { id: "claude-opus-4-6", label: "Opus 4.6" },
        { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
      ],
      defaultModelId: "claude-opus-4-6",
      memoryEnabled: false,
    });
    expect(JSON.stringify(payload)).not.toMatch(
      /API_KEY|BASE_URL|test-key|apiKey/i,
    );
  });

  it("validates and updates the complete settings document", async () => {
    const input = {
      systemPrompt: "Be concise.",
      temperature: 0.4,
      maxOutputTokens: 1024,
      // 17000 − 1024 − 3200 − 4 − 3000 = 9772 ≥ 8000 + 1000 (window seat).
      contextTokenBudget: 17_000,
      recentMessageBudget: 6000,
      memoryTokenBudget: 1000,
      // 750 + 500 + 1200 + 42 = 2492 for target 500 / snapshot 250.
      capsuleTokenBudget: 3000,
      narrativeTargetTokens: 500,
      recentSnapshotTokenBudget: 250,
      summaryTriggerTokens: 8000,
      memoryRetrievalLimit: 3,
      webSearchEnabled: false,
      toolsEnabled: true,
    };
    mocks.updateSettings.mockResolvedValue({
      ...storedSettings,
      ...input,
    });
    const { PUT } = await import("@/app/api/settings/route");
    const response = await PUT(request("PUT", input));

    expect(response.status).toBe(200);
    expect(mocks.updateSettings).toHaveBeenCalledWith(input);
    expect((await response.json()).settings).toMatchObject(input);
  });

  it("rejects invalid cross-field budgets without updating", async () => {
    const { PUT } = await import("@/app/api/settings/route");
    const response = await PUT(
      request("PUT", {
        systemPrompt: "Be concise.",
        temperature: 0.4,
        maxOutputTokens: 5000,
        contextTokenBudget: 6000,
        recentMessageBudget: 6000,
        memoryTokenBudget: 1000,
        capsuleTokenBudget: 3000,
        narrativeTargetTokens: 500,
        recentSnapshotTokenBudget: 250,
        summaryTriggerTokens: 6000,
        memoryRetrievalLimit: 3,
        webSearchEnabled: true,
        toolsEnabled: false,
      }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("INVALID_INPUT");
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });
});
