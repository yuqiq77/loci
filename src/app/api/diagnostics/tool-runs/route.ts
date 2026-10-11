import { NextRequest, NextResponse } from "next/server";

import { requireOwner } from "@/server/auth/request";
import {
  listToolRunAttempt,
  listToolRunAttemptsForSession,
} from "@/server/db/diagnostics";
import { diagnosticsToolRunsQuerySchema } from "@/server/diagnostics/schema";
import { errorResponse } from "@/server/http/errors";

export const runtime = "nodejs";

// Read-only (MC-123): tool_runs by session (recent attempts) or by attempt.
export async function GET(request: NextRequest): Promise<NextResponse> {
  const unauthorized = await requireOwner(request);
  if (unauthorized) {
    return unauthorized;
  }

  const parsed = diagnosticsToolRunsQuerySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );
  if (!parsed.success) {
    return errorResponse("INVALID_INPUT");
  }
  const { sessionId, attemptId, limit } = parsed.data;

  return NextResponse.json({
    attempts: attemptId
      ? await listToolRunAttempt(attemptId)
      : await listToolRunAttemptsForSession(sessionId!, limit),
  });
}
