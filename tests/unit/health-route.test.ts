import { beforeEach, describe, expect, it, vi } from "vitest";

const checkDatabaseHealth = vi.fn();

vi.mock("@/server/db/health", () => ({
  checkDatabaseHealth,
}));

describe("GET /api/health", () => {
  beforeEach(() => {
    checkDatabaseHealth.mockReset();
  });

  it("returns a minimal healthy response", async () => {
    checkDatabaseHealth.mockResolvedValue(undefined);
    const { GET } = await import("@/app/api/health/route");

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("returns service unavailable when PostgreSQL is unavailable", async () => {
    checkDatabaseHealth.mockRejectedValue(new Error("connection failed"));
    const { GET } = await import("@/app/api/health/route");

    const response = await GET();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ ok: false });
  });
});
