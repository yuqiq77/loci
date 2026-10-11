import { NextRequest, NextResponse } from "next/server";

import { requireOwner } from "@/server/auth/request";
import { createSession, listActiveSessions } from "@/server/db/sessions";
import { errorResponse } from "@/server/http/errors";
import { createSessionSchema } from "@/server/sessions/schema";

export const runtime = "nodejs";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const unauthorized = await requireOwner(request);
  if (unauthorized) {
    return unauthorized;
  }

  return NextResponse.json({ sessions: await listActiveSessions() });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const unauthorized = await requireOwner(request);
  if (unauthorized) {
    return unauthorized;
  }

  const rawBody = await request.text();
  let body: unknown = {};
  if (rawBody.trim()) {
    try {
      body = JSON.parse(rawBody);
    } catch {
      return errorResponse("INVALID_INPUT");
    }
  }

  const parsed = createSessionSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse("INVALID_INPUT");
  }

  const session = await createSession(parsed.data);
  return NextResponse.json({ session }, { status: 201 });
}
