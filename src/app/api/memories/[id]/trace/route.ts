import { NextRequest, NextResponse } from "next/server";

import { requireOwner } from "@/server/auth/request";
import { listMemoryTrace } from "@/server/db/diagnostics";
import { memoryTraceQuerySchema } from "@/server/diagnostics/schema";
import { errorResponse } from "@/server/http/errors";
import { memoryIdSchema } from "@/server/memory/schema";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

// Read-only (MC-123): the recorded injection decisions for one memory.
export async function GET(
  request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  const unauthorized = await requireOwner(request);
  if (unauthorized) {
    return unauthorized;
  }

  const { id } = await context.params;
  if (!memoryIdSchema.safeParse(id).success) {
    return errorResponse("MEMORY_NOT_FOUND");
  }
  const parsed = memoryTraceQuerySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );
  if (!parsed.success) {
    return errorResponse("INVALID_INPUT");
  }

  return NextResponse.json({
    memoryId: id,
    decisions: await listMemoryTrace(id, parsed.data.limit),
  });
}
