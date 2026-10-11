import { NextRequest, NextResponse } from "next/server";

import { requireOwner } from "@/server/auth/request";
import { enqueueJob } from "@/server/db/jobs";
import { errorResponse } from "@/server/http/errors";
import { consolidateNarrativeSchema } from "@/server/profile/schema";

export const runtime = "nodejs";

// Manual "consolidate now" / "rebuild" (D10): enqueues directly, bypassing the
// episode tick's interval guard. Singleton dedupe in the job queue absorbs
// repeat clicks; `queued: false` reports an already-pending job.
export async function POST(request: NextRequest): Promise<NextResponse> {
  const unauthorized = await requireOwner(request);
  if (unauthorized) {
    return unauthorized;
  }

  const body = await request.json().catch(() => null);
  const parsed = consolidateNarrativeSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse("INVALID_INPUT");
  }

  const jobId = await enqueueJob("consolidate_narrative", {
    mode: parsed.data.mode,
  });

  return NextResponse.json({ queued: jobId !== null });
}
