import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireOwner: vi.fn(async () => null),
  listSessionMessages: vi.fn(),
  getRewritableTailId: vi.fn(),
  sessionExists: vi.fn(),
}));

vi.mock("@/server/auth/request", () => ({
  requireOwner: mocks.requireOwner,
}));
vi.mock("@/server/db/messages", () => ({
  listSessionMessages: mocks.listSessionMessages,
  getRewritableTailId: mocks.getRewritableTailId,
}));
vi.mock("@/server/db/sessions", () => ({
  sessionExists: mocks.sessionExists,
}));

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

function request() {
  return new NextRequest(
    `http://localhost/api/sessions/${SESSION_ID}/messages`,
  );
}

describe("GET /api/sessions/[id]/messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sessionExists.mockResolvedValue(true);
    mocks.listSessionMessages.mockResolvedValue([]);
    mocks.getRewritableTailId.mockResolvedValue(null);
  });

  it("carries the server-computed rewritable-tail indicator", async () => {
    // Top-level field, computed from the DB's true tail (MC-116B decision
    // 5) — a paginated slice must never be the source.
    mocks.getRewritableTailId.mockResolvedValue("tail-user-id");
    const { GET } = await import("@/app/api/sessions/[id]/messages/route");

    const response = await GET(request(), {
      params: Promise.resolve({ id: SESSION_ID }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      messages: [],
      rewritableTailId: "tail-user-id",
    });
    expect(mocks.getRewritableTailId).toHaveBeenCalledWith(SESSION_ID);
  });

  it("returns an explicit error when message loading fails", async () => {
    mocks.listSessionMessages.mockRejectedValue(
      new Error("database unavailable"),
    );
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { GET } = await import("@/app/api/sessions/[id]/messages/route");

    const response = await GET(request(), {
      params: Promise.resolve({ id: SESSION_ID }),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to load messages.",
      },
    });
    expect(consoleError).toHaveBeenCalledWith(
      "Failed to load session messages.",
      "Error",
    );
    consoleError.mockRestore();
  });
});
