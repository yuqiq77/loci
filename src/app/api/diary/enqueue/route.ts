import { NextRequest, NextResponse } from "next/server";

import { requireOwner } from "@/server/auth/request";
import { enqueueJob } from "@/server/db/jobs";
import { diaryEnqueueSchema } from "@/server/diary/schema";
import { errorResponse } from "@/server/http/errors";
import { diaryDayOf } from "@/server/summaries/diary";

export const runtime = "nodejs";

// Manual diary enqueue for one date (MC-118 scope 8), mirroring
// api/profile/consolidate: authority by path — no sourceKey, so the fence
// on a failed automatic row for the same date does not apply and that row is
// left untouched. Pending-per-date dedupe still absorbs repeat clicks, the
// job skips an already-journaled day, and the append-only unique
// entry_date refuses a duplicate write.
export async function POST(request: NextRequest): Promise<NextResponse> {
  const unauthorized = await requireOwner(request);
  if (unauthorized) {
    return unauthorized;
  }

  const body = await request.json().catch(() => null);
  const parsed = diaryEnqueueSchema.safeParse(body);
  // Closed days only, like the tick: a day is never journaled while its
  // night is open — a partial entry could never be replaced (append-only).
  if (!parsed.success || parsed.data.date >= diaryDayOf(new Date())) {
    return errorResponse("INVALID_INPUT");
  }

  const jobId = await enqueueJob("write_diary_entry", {
    date: parsed.data.date,
  });

  return NextResponse.json({ queued: jobId !== null });
}
