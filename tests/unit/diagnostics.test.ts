import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  classifyFence,
  settleSections,
  type FenceRow,
} from "@/server/db/diagnostics";
import {
  diagnosticsJobsQuerySchema,
  diagnosticsToolRunsQuerySchema,
  memoryTraceQuerySchema,
} from "@/server/diagnostics/schema";
import { policyVersionFromSourceKey } from "@/server/jobs/source-keys";

const mocks = vi.hoisted(() => ({
  requireOwner: vi.fn(async () => null as NextResponse | null),
  loadDiagnosticsPulse: vi.fn(),
  listJobsForDiagnostics: vi.fn(),
  resolveFences: vi.fn(),
  listToolRunAttempt: vi.fn(),
  listToolRunAttemptsForSession: vi.fn(),
  listMemoryTrace: vi.fn(),
}));

vi.mock("@/server/auth/request", () => ({
  requireOwner: mocks.requireOwner,
}));
vi.mock("@/server/db/diagnostics", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/server/db/diagnostics")>();
  return {
    ...original,
    loadDiagnosticsPulse: mocks.loadDiagnosticsPulse,
    listJobsForDiagnostics: mocks.listJobsForDiagnostics,
    resolveFences: mocks.resolveFences,
    listToolRunAttempt: mocks.listToolRunAttempt,
    listToolRunAttemptsForSession: mocks.listToolRunAttemptsForSession,
    listMemoryTrace: mocks.listMemoryTrace,
  };
});

function fenceRow(id: string, sourceKey: string): FenceRow {
  return {
    id,
    type: "consolidate_narrative",
    sourceKey,
    policyVersion: policyVersionFromSourceKey(sourceKey),
    attempts: 1,
    completedAt: null,
    lastError: null,
  };
}

describe("diagnostics sections (MC-123)", () => {
  it("isolates a rejected aggregate to its own section", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await settleSections({
      good: Promise.resolve({ count: 1 }),
      bad: Promise.reject(new TypeError("boom")),
    });

    expect(result).toEqual({ good: { count: 1 }, bad: { error: "TypeError" } });
    expect(console.error).toHaveBeenCalledWith("diagnostics_section_failed", {
      section: "bad",
      error: "TypeError",
    });
  });

  it("classifies a failed row as a fence only under the exact derived key", () => {
    const derived = "v3|through:x|msg:y|mem:z|p1";
    const blocking = fenceRow("a", derived);
    const olderPolicy = fenceRow("b", "v3|through:x|msg:y|mem:z|p0");
    const olderSource = fenceRow("c", "v2|through:w|msg:y|mem:z|p1");

    expect(classifyFence(derived, [olderPolicy, blocking, olderSource])).toEqual({
      status: "blocked",
      blockedBy: blocking,
      history: [olderPolicy, olderSource],
    });
    expect(classifyFence(derived, [olderPolicy])).toEqual({
      status: "clear",
      blockedBy: null,
      history: [olderPolicy],
    });
    expect(olderPolicy.policyVersion).toBe(0);
    expect(policyVersionFromSourceKey("2026-09-11")).toBeNull();
    expect(policyVersionFromSourceKey(null)).toBeNull();
    expect(classifyFence(null, [blocking])).toMatchObject({
      status: "clear",
      history: [blocking],
    });
  });
});

describe("diagnostics query schemas", () => {
  it("parses the jobs query with defaults, filters, and cursor", () => {
    expect(diagnosticsJobsQuerySchema.parse({})).toEqual({ limit: 50 });
    const id = "6f0a3c6e-2d8d-4b0f-9d3a-1a2b3c4d5e6f";
    expect(
      diagnosticsJobsQuerySchema.parse({
        status: "failed",
        type: "write_diary_entry",
        limit: "10",
        before: id,
      }),
    ).toEqual({
      status: "failed",
      type: "write_diary_entry",
      limit: 10,
      before: id,
    });
    expect(diagnosticsJobsQuerySchema.safeParse({ status: "done" }).success).toBe(false);
    expect(diagnosticsJobsQuerySchema.safeParse({ type: "nope" }).success).toBe(false);
    expect(diagnosticsJobsQuerySchema.safeParse({ limit: "500" }).success).toBe(false);
    expect(diagnosticsJobsQuerySchema.safeParse({ before: "yesterday" }).success).toBe(false);
  });

  it("requires exactly one of sessionId or attemptId for tool runs", () => {
    const id = "6f0a3c6e-2d8d-4b0f-9d3a-1a2b3c4d5e6f";
    expect(diagnosticsToolRunsQuerySchema.parse({ sessionId: id })).toEqual({
      sessionId: id,
      limit: 200,
    });
    expect(diagnosticsToolRunsQuerySchema.parse({ attemptId: id, limit: "5" })).toEqual({
      attemptId: id,
      limit: 5,
    });
    expect(diagnosticsToolRunsQuerySchema.safeParse({}).success).toBe(false);
    expect(
      diagnosticsToolRunsQuerySchema.safeParse({ sessionId: id, attemptId: id }).success,
    ).toBe(false);
  });

  it("bounds the trace limit", () => {
    expect(memoryTraceQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(memoryTraceQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
  });
});

describe("diagnostics routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireOwner.mockResolvedValue(null);
  });

  const get = (url: string) => new NextRequest(`http://localhost${url}`);
  const unauthorized = () =>
    mocks.requireOwner.mockResolvedValue(
      NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 }),
    );

  it("gates every endpoint on the owner session (AC 8)", async () => {
    unauthorized();
    const pulse = await import("@/app/api/diagnostics/pulse/route");
    const jobs = await import("@/app/api/diagnostics/jobs/route");
    const toolRuns = await import("@/app/api/diagnostics/tool-runs/route");
    const trace = await import("@/app/api/memories/[id]/trace/route");
    const id = "6f0a3c6e-2d8d-4b0f-9d3a-1a2b3c4d5e6f";

    expect((await pulse.GET(get("/api/diagnostics/pulse"))).status).toBe(401);
    expect((await jobs.GET(get("/api/diagnostics/jobs"))).status).toBe(401);
    expect(
      (await toolRuns.GET(get(`/api/diagnostics/tool-runs?sessionId=${id}`)))
        .status,
    ).toBe(401);
    expect(
      (
        await trace.GET(get(`/api/memories/${id}/trace`), {
          params: Promise.resolve({ id }),
        })
      ).status,
    ).toBe(401);
    for (const reader of [
      mocks.loadDiagnosticsPulse,
      mocks.listJobsForDiagnostics,
      mocks.resolveFences,
      mocks.listToolRunAttemptsForSession,
      mocks.listMemoryTrace,
    ]) {
      expect(reader).not.toHaveBeenCalled();
    }
  });

  it("passes the parsed jobs query through and isolates a failed fences section", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.listJobsForDiagnostics.mockResolvedValue({ rows: [], nextCursor: null });
    mocks.resolveFences.mockRejectedValue(new Error("no narrative"));
    const { GET } = await import("@/app/api/diagnostics/jobs/route");

    const response = await GET(get("/api/diagnostics/jobs?status=failed&limit=5"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      listing: { rows: [], nextCursor: null },
      fences: { error: "Error" },
    });
    expect(mocks.listJobsForDiagnostics).toHaveBeenCalledWith({
      status: "failed",
      limit: 5,
    });
    expect((await GET(get("/api/diagnostics/jobs?status=nope"))).status).toBe(400);
  });

  it("continues a listing without recomputing the fences", async () => {
    mocks.listJobsForDiagnostics.mockResolvedValue({ rows: [], nextCursor: null });
    const { GET } = await import("@/app/api/diagnostics/jobs/route");
    const id = "6f0a3c6e-2d8d-4b0f-9d3a-1a2b3c4d5e6f";

    const response = await GET(get(`/api/diagnostics/jobs?before=${id}`));

    expect(await response.json()).toEqual({ listing: { rows: [], nextCursor: null } });
    expect(mocks.listJobsForDiagnostics).toHaveBeenCalledWith({ limit: 50, before: id });
    expect(mocks.resolveFences).not.toHaveBeenCalled();
  });

  it("dispatches tool runs by attempt or by session", async () => {
    mocks.listToolRunAttempt.mockResolvedValue([]);
    mocks.listToolRunAttemptsForSession.mockResolvedValue([]);
    const { GET } = await import("@/app/api/diagnostics/tool-runs/route");
    const id = "6f0a3c6e-2d8d-4b0f-9d3a-1a2b3c4d5e6f";

    await GET(get(`/api/diagnostics/tool-runs?attemptId=${id}`));
    expect(mocks.listToolRunAttempt).toHaveBeenCalledWith(id);
    await GET(get(`/api/diagnostics/tool-runs?sessionId=${id}&limit=20`));
    expect(mocks.listToolRunAttemptsForSession).toHaveBeenCalledWith(id, 20);
    expect((await GET(get("/api/diagnostics/tool-runs"))).status).toBe(400);
  });

  it("rejects a malformed memory id on the trace route", async () => {
    const { GET } = await import("@/app/api/memories/[id]/trace/route");

    const response = await GET(get("/api/memories/nope/trace"), {
      params: Promise.resolve({ id: "nope" }),
    });

    expect(response.status).toBe(404);
    expect(mocks.listMemoryTrace).not.toHaveBeenCalled();
  });
});
