import { NextRequest, NextResponse } from "next/server";

import { requireOwner } from "@/server/auth/request";
import { deleteSession, updateSession } from "@/server/db/sessions";
import { errorResponse } from "@/server/http/errors";
import { sessionIdSchema, updateSessionSchema } from "@/server/sessions/schema";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(
  request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  const unauthorized = await requireOwner(request);
  if (unauthorized) {
    return unauthorized;
  }

  const { id } = await context.params;
  if (!sessionIdSchema.safeParse(id).success) {
    return errorResponse("SESSION_NOT_FOUND");
  }

  const body = await request.json().catch(() => null);
  const parsed = updateSessionSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse("INVALID_INPUT");
  }

  const session = await updateSession(id, parsed.data);
  if (!session) {
    return errorResponse("SESSION_NOT_FOUND");
  }

  return NextResponse.json({ session });
}

export async function DELETE(
  request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  const unauthorized = await requireOwner(request);
  if (unauthorized) {
    return unauthorized;
  }

  const { id } = await context.params;
  if (!sessionIdSchema.safeParse(id).success) {
    return errorResponse("SESSION_NOT_FOUND");
  }

  if (!(await deleteSession(id))) {
    return errorResponse("SESSION_NOT_FOUND");
  }

  return NextResponse.json({ ok: true });
}
