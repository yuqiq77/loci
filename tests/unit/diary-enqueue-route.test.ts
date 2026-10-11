import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { addDiaryDays, diaryDayOf } from "@/server/summaries/diary";

const mocks = vi.hoisted(() => ({
  requireOwner: vi.fn(async () => null as NextResponse | null),
  enqueueJob: vi.fn(),
}));

vi.mock("@/server/auth/request", () => ({
  requireOwner: mocks.requireOwner,
}));
vi.mock("@/server/db/jobs", () => ({
  enqueueJob: mocks.enqueueJob,
}));

function request(body: unknown) {
  return new NextRequest("http://localhost/api/diary/enqueue", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("diary enqueue route (MC-118 manual re-arm)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireOwner.mockResolvedValue(null);
  });

  it("enqueues the date without a sourceKey, so the fence does not apply", async () => {
    mocks.enqueueJob.mockResolvedValue("job-1");
    const { POST } = await import("@/app/api/diary/enqueue/route");

    const response = await POST(request({ date: "2026-07-12" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ queued: true });
    expect(mocks.enqueueJob).toHaveBeenCalledWith("write_diary_entry", {
      date: "2026-07-12",
    });
  });

  it("accepts the most recently closed day and rejects the open one", async () => {
    mocks.enqueueJob.mockResolvedValue("job-1");
    const { POST } = await import("@/app/api/diary/enqueue/route");
    const openDay = diaryDayOf(new Date());

    const closed = await POST(request({ date: addDiaryDays(openDay, -1) }));
    expect(closed.status).toBe(200);

    const open = await POST(request({ date: openDay }));
    expect(open.status).toBe(400);
    const future = await POST(request({ date: addDiaryDays(openDay, 1) }));
    expect(future.status).toBe(400);
    expect(mocks.enqueueJob).toHaveBeenCalledTimes(1);
  });

  it("reports an already-pending day as not queued", async () => {
    mocks.enqueueJob.mockResolvedValue(null);
    const { POST } = await import("@/app/api/diary/enqueue/route");

    const response = await POST(request({ date: "2026-07-12" }));

    expect(await response.json()).toEqual({ queued: false });
  });

  it("rejects a malformed date and never enqueues", async () => {
    const { POST } = await import("@/app/api/diary/enqueue/route");

    const response = await POST(request({ date: "yesterday" }));

    expect(response.status).toBe(400);
    expect(mocks.enqueueJob).not.toHaveBeenCalled();
  });

  it("requires the owner", async () => {
    mocks.requireOwner.mockResolvedValue(
      NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 }),
    );
    const { POST } = await import("@/app/api/diary/enqueue/route");

    const response = await POST(request({ date: "2026-07-12" }));

    expect(response.status).toBe(401);
    expect(mocks.enqueueJob).not.toHaveBeenCalled();
  });
});
