import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/request", () => ({
  requireOwner: vi.fn(async () => null),
}));

const updateSession = vi.fn();
const deleteSession = vi.fn();
const createSession = vi.fn();
const listActiveSessions = vi.fn();

vi.mock("@/server/db/sessions", () => ({
  updateSession,
  deleteSession,
  createSession,
  listActiveSessions,
}));

const VALID_ID = "11111111-1111-1111-1111-111111111111";

function jsonRequest(body: unknown) {
  return {
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as never;
}

function textRequest(body: string) {
  return { text: async () => body } as never;
}

describe("session routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects unknown fields on create with INVALID_INPUT", async () => {
    const { POST } = await import("@/app/api/sessions/route");
    const response = await POST(jsonRequest({ role: "admin" }));

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("INVALID_INPUT");
    expect(createSession).not.toHaveBeenCalled();
  });

  it("allows an empty body when creating with defaults", async () => {
    const session = { id: VALID_ID };
    createSession.mockResolvedValue(session);
    const { POST } = await import("@/app/api/sessions/route");
    const response = await POST(textRequest(""));

    expect(response.status).toBe(201);
    expect(createSession).toHaveBeenCalledWith({});
    expect(await response.json()).toEqual({ session });
  });

  it("rejects malformed JSON without creating a session", async () => {
    const { POST } = await import("@/app/api/sessions/route");
    const response = await POST(textRequest('{"title":'));

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("INVALID_INPUT");
    expect(createSession).not.toHaveBeenCalled();
  });

  it("returns SESSION_NOT_FOUND for a non-uuid id", async () => {
    const { DELETE } = await import("@/app/api/sessions/[id]/route");
    const response = await DELETE(jsonRequest(null), {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });

    expect(response.status).toBe(404);
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it("returns SESSION_NOT_FOUND when the session is missing", async () => {
    updateSession.mockResolvedValue(null);
    const { PATCH } = await import("@/app/api/sessions/[id]/route");
    const response = await PATCH(jsonRequest({ title: "New" }), {
      params: Promise.resolve({ id: VALID_ID }),
    });

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("SESSION_NOT_FOUND");
  });
});
