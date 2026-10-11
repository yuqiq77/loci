import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireOwner: vi.fn(async () => null as NextResponse | null),
  listDiaryEntries: vi.fn(),
  countDiaryEntries: vi.fn(),
  listDiaryMonths: vi.fn(),
}));

vi.mock("@/server/auth/request", () => ({
  requireOwner: mocks.requireOwner,
}));
vi.mock("@/server/db/diary", () => ({
  listDiaryEntries: mocks.listDiaryEntries,
  countDiaryEntries: mocks.countDiaryEntries,
  listDiaryMonths: mocks.listDiaryMonths,
}));

const storedEntries = [
  {
    id: "00000000-0000-4000-8000-000000000002",
    entryDate: "2026-07-02",
    content: "Tonight we completed the prototype review.",
    createdAt: new Date("2026-07-08T02:05:00Z"),
  },
  {
    id: "00000000-0000-4000-8000-000000000001",
    entryDate: "2026-07-06",
    content: "A quiet day of small threads.",
    createdAt: new Date("2026-07-07T02:05:00Z"),
  },
];

function request(query = "") {
  return new NextRequest(`http://localhost/api/diary${query}`);
}

describe("diary route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireOwner.mockResolvedValue(null);
    mocks.listDiaryEntries.mockResolvedValue(storedEntries);
    mocks.countDiaryEntries.mockResolvedValue(2);
    mocks.listDiaryMonths.mockResolvedValue([{ month: "2026-07", count: 2 }]);
  });

  it("returns entries newest-first with owner auth", async () => {
    const { GET } = await import("@/app/api/diary/route");
    const response = await GET(request());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({
      total: 2,
      months: [{ month: "2026-07", count: 2 }],
      entries: [
        {
          id: storedEntries[0].id,
          entryDate: "2026-07-02",
          content: "Tonight we completed the prototype review.",
          createdAt: "2026-07-08T02:05:00.000Z",
        },
        {
          id: storedEntries[1].id,
          entryDate: "2026-07-06",
          content: "A quiet day of small threads.",
          createdAt: "2026-07-07T02:05:00.000Z",
        },
      ],
    });
    expect(mocks.listDiaryEntries).toHaveBeenCalledWith({
      limit: 30,
      offset: 0,
    });
  });

  it("passes limit and offset through and rejects invalid values", async () => {
    const { GET } = await import("@/app/api/diary/route");

    const paged = await GET(request("?limit=5&offset=10"));
    expect(paged.status).toBe(200);
    expect(mocks.listDiaryEntries).toHaveBeenCalledWith({
      limit: 5,
      offset: 10,
    });

    const invalid = await GET(request("?limit=0"));
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error.code).toBe("INVALID_INPUT");
  });

  it("filters by month and rejects a malformed month", async () => {
    const { GET } = await import("@/app/api/diary/route");

    const month = await GET(request("?month=2026-07&limit=31"));
    expect(month.status).toBe(200);
    expect(mocks.listDiaryEntries).toHaveBeenCalledWith({
      limit: 31,
      offset: 0,
      month: "2026-07",
    });

    for (const bad of ["2026-13", "2026-7", "July"]) {
      const invalid = await GET(request(`?month=${bad}`));
      expect(invalid.status).toBe(400);
    }
  });

  it("rejects unauthenticated requests before touching the store", async () => {
    mocks.requireOwner.mockResolvedValue(
      NextResponse.json(
        { error: { code: "UNAUTHORIZED", message: "Authentication required." } },
        { status: 401 },
      ),
    );
    const { GET } = await import("@/app/api/diary/route");
    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(mocks.listDiaryEntries).not.toHaveBeenCalled();
  });
});
