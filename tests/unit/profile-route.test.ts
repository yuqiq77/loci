import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireOwner: vi.fn(async () => null),
  getSettings: vi.fn(),
  getRelationshipNarrative: vi.fn(),
  writeNarrativeVersion: vi.fn(),
  enqueueJob: vi.fn(),
}));

vi.mock("@/server/auth/request", () => ({
  requireOwner: mocks.requireOwner,
}));
vi.mock("@/server/db/settings", () => ({
  getSettings: mocks.getSettings,
}));
vi.mock("@/server/db/narrative", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/server/db/narrative")>();
  return {
    ...original,
    getRelationshipNarrative: mocks.getRelationshipNarrative,
    writeNarrativeVersion: mocks.writeNarrativeVersion,
  };
});
vi.mock("@/server/db/jobs", () => ({
  enqueueJob: mocks.enqueueJob,
}));

const storedSettings = {
  standingContext: "## Profile\nSeed from settings.",
  capsuleTokenBudget: 4000,
  narrativeTargetTokens: 1000,
  recentSnapshotTokenBudget: 400,
};
// The editor's limit is the narrative write cap (MC-121): target 1000 × 1.5.
// The target rides along as the normal size.
const TARGET = 1000;
const WRITE_CAP = 1500;

function request(method: "GET" | "PUT" | "POST", body?: unknown) {
  return new NextRequest("http://localhost/api/profile", {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
}

describe("profile routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireOwner.mockResolvedValue(null);
    mocks.getSettings.mockResolvedValue(storedSettings);
    mocks.getRelationshipNarrative.mockResolvedValue({
      content: "",
      version: 0,
      updatedAt: new Date(),
      consolidatedThrough: new Date(),
    });
    mocks.writeNarrativeVersion.mockImplementation(
      async (input: { content: string }) => ({
        content: input.content,
        version: 2,
        updatedAt: new Date(),
        consolidatedThrough: new Date(),
      }),
    );
    mocks.enqueueJob.mockResolvedValue("job-1");
  });

  it("serves the narrative when present", async () => {
    mocks.getRelationshipNarrative.mockResolvedValue({
      content: "## Profile\nConsolidated narrative.",
      version: 3,
      updatedAt: new Date(),
      consolidatedThrough: new Date(),
    });
    const { GET } = await import("@/app/api/profile/route");
    const response = await GET(request("GET"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      content: "## Profile\nConsolidated narrative.",
      source: "narrative",
      version: 3,
      updatedAt: expect.any(String),
      targetTokens: TARGET,
      tokenBudget: WRITE_CAP,
    });
  });

  it("falls back to the standing-context seed before the first version", async () => {
    const { GET } = await import("@/app/api/profile/route");
    const response = await GET(request("GET"));

    expect(await response.json()).toEqual({
      content: "## Profile\nSeed from settings.",
      source: "standing_context",
      version: 0,
      updatedAt: expect.any(String),
      targetTokens: TARGET,
      tokenBudget: WRITE_CAP,
    });
  });

  it("serves a deliberately blanked narrative instead of the seed", async () => {
    mocks.getRelationshipNarrative.mockResolvedValue({
      content: "",
      version: 4,
      updatedAt: new Date(),
      consolidatedThrough: new Date(),
    });
    const { GET } = await import("@/app/api/profile/route");
    const response = await GET(request("GET"));

    expect(await response.json()).toEqual({
      content: "",
      source: "narrative",
      version: 4,
      updatedAt: expect.any(String),
      targetTokens: TARGET,
      tokenBudget: WRITE_CAP,
    });
  });

  it("writes a manual version on save", async () => {
    const { PUT } = await import("@/app/api/profile/route");
    const response = await PUT(
      request("PUT", { content: "## Profile\nEdited.", expectedVersion: 1 }),
    );

    expect(response.status).toBe(200);
    expect(mocks.writeNarrativeVersion).toHaveBeenCalledWith({
      content: "## Profile\nEdited.",
      mode: "manual",
      expectedVersion: 1,
    });
    expect(await response.json()).toMatchObject({
      content: "## Profile\nEdited.",
      source: "narrative",
    });
  });

  it("accepts a paste between the target and the write cap", async () => {
    const { PUT } = await import("@/app/api/profile/route");
    // 3600 ASCII characters = 1200 estimated tokens: over the 1000 target,
    // inside the 1500 cap — a legal record the capsule seats in full.
    const response = await PUT(
      request("PUT", { content: "x".repeat(3600), expectedVersion: 1 }),
    );

    expect(response.status).toBe(200);
    expect(mocks.writeNarrativeVersion).toHaveBeenCalledTimes(1);
  });

  it("rejects a paste above the write cap with the numbers", async () => {
    const { PUT } = await import("@/app/api/profile/route");
    // 4503 ASCII characters = 1501 estimated tokens: one over the cap.
    const response = await PUT(
      request("PUT", { content: "x".repeat(4503), expectedVersion: 1 }),
    );

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("INVALID_INPUT");
    expect(payload.error.message).toBe(
      "Narrative is 1501 estimated tokens; the limit is 1500 (target 1000 × 1.5).",
    );
    expect(mocks.writeNarrativeVersion).not.toHaveBeenCalled();
  });

  it("queues manual consolidation and reports an already-pending job", async () => {
    const { POST } = await import("@/app/api/profile/consolidate/route");

    const queued = await POST(request("POST", { mode: "incremental" }));
    expect(await queued.json()).toEqual({ queued: true });
    expect(mocks.enqueueJob).toHaveBeenCalledWith("consolidate_narrative", {
      mode: "incremental",
    });

    mocks.enqueueJob.mockResolvedValue(null);
    const duplicate = await POST(request("POST", { mode: "rebuild" }));
    expect(await duplicate.json()).toEqual({ queued: false });
    expect(mocks.enqueueJob).toHaveBeenLastCalledWith(
      "consolidate_narrative",
      { mode: "rebuild" },
    );
  });

  it("rejects a save without the loaded version", async () => {
    const { PUT } = await import("@/app/api/profile/route");
    const response = await PUT(
      request("PUT", { content: "## Profile\nEdited." }),
    );

    expect(response.status).toBe(400);
    expect(mocks.writeNarrativeVersion).not.toHaveBeenCalled();
  });

  it("returns 409 when a background write raced the editor", async () => {
    const { NarrativeVersionConflictError } = await import(
      "@/server/db/narrative"
    );
    mocks.writeNarrativeVersion.mockRejectedValue(
      new NarrativeVersionConflictError(),
    );
    const { PUT } = await import("@/app/api/profile/route");
    const response = await PUT(
      request("PUT", { content: "## Profile\nEdited.", expectedVersion: 1 }),
    );

    expect(response.status).toBe(409);
    const payload = await response.json();
    expect(payload.error.code).toBe("NARRATIVE_VERSION_CONFLICT");
  });

  it("rejects an unknown consolidation mode", async () => {
    const { POST } = await import("@/app/api/profile/consolidate/route");
    const response = await POST(request("POST", { mode: "nuke" }));

    expect(response.status).toBe(400);
    expect(mocks.enqueueJob).not.toHaveBeenCalled();
  });
});
