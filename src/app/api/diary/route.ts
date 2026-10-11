import { NextRequest, NextResponse } from "next/server";

import { requireOwner } from "@/server/auth/request";
import {
  countDiaryEntries,
  listDiaryEntries,
  listDiaryMonths,
} from "@/server/db/diary";
import { diaryQuerySchema } from "@/server/diary/schema";
import { errorResponse } from "@/server/http/errors";

export const runtime = "nodejs";

// Read-only in MC-111: edit, delete, and regenerate are deferred together —
// the append-only table has no mutation surface to expose.
export async function GET(request: NextRequest): Promise<NextResponse> {
  const unauthorized = await requireOwner(request);
  if (unauthorized) {
    return unauthorized;
  }

  const parsed = diaryQuerySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );
  if (!parsed.success) {
    return errorResponse("INVALID_INPUT");
  }

  const [entries, total, months] = await Promise.all([
    listDiaryEntries(parsed.data),
    countDiaryEntries(),
    listDiaryMonths(),
  ]);
  return NextResponse.json({
    total,
    months,
    entries: entries.map((entry) => ({
      id: entry.id,
      entryDate: entry.entryDate,
      content: entry.content,
      createdAt: entry.createdAt.toISOString(),
    })),
  });
}
