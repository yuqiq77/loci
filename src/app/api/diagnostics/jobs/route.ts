import { NextRequest, NextResponse } from "next/server";

import { requireOwner } from "@/server/auth/request";
import {
  listJobsForDiagnostics,
  resolveFences,
  settleSections,
} from "@/server/db/diagnostics";
import { diagnosticsJobsQuerySchema } from "@/server/diagnostics/schema";
import { errorResponse } from "@/server/http/errors";

export const runtime = "nodejs";

// Read-only (MC-123): the jobs listing with the MC-118 fields decoded, plus
// the per-writer fence status. The two sections degrade independently.
export async function GET(request: NextRequest): Promise<NextResponse> {
  const unauthorized = await requireOwner(request);
  if (unauthorized) {
    return unauthorized;
  }

  const parsed = diagnosticsJobsQuerySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );
  if (!parsed.success) {
    return errorResponse("INVALID_INPUT");
  }
  // Fences ride along with the first page only; later pages are the same
  // listing continued and the client keeps the fences it already has.
  return NextResponse.json(
    await settleSections({
      listing: listJobsForDiagnostics(parsed.data),
      ...(parsed.data.before ? {} : { fences: resolveFences() }),
    }),
  );
}
