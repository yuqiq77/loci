import { NextRequest, NextResponse } from "next/server";

import { requireOwner } from "@/server/auth/request";
import {
  getRewritableTailId,
  listSessionMessages,
} from "@/server/db/messages";
import { sessionExists } from "@/server/db/sessions";
import { errorResponse } from "@/server/http/errors";
import { messagesQuerySchema, sessionIdSchema } from "@/server/sessions/schema";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(
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

  const query = messagesQuerySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );
  if (!query.success) {
    return errorResponse("INVALID_INPUT");
  }

  let exists: boolean;
  try {
    exists = await sessionExists(id);
  } catch (error) {
    console.error(
      "Failed to check session before loading messages.",
      error instanceof Error ? error.name : "UnknownError",
    );
    return errorResponse("INTERNAL_ERROR", "Failed to load messages.");
  }

  if (!exists) {
    return errorResponse("SESSION_NOT_FOUND");
  }

  let messages;
  let rewritableTailId;
  try {
    // The eligibility indicator is computed server-side from the true tail
    // and both cursors (MC-116B decision 5) — the paginated slice need not
    // even contain the tail, so the client must never infer it.
    [messages, rewritableTailId] = await Promise.all([
      listSessionMessages(id, query.data.limit, query.data.offset),
      getRewritableTailId(id),
    ]);
  } catch (error) {
    console.error(
      "Failed to load session messages.",
      error instanceof Error ? error.name : "UnknownError",
    );
    return errorResponse("INTERNAL_ERROR", "Failed to load messages.");
  }

  return NextResponse.json({ messages, rewritableTailId });
}
