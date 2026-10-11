import { NextRequest, NextResponse } from "next/server";

import { requireOwner } from "@/server/auth/request";
import { loadDiagnosticsPulse } from "@/server/db/diagnostics";

export const runtime = "nodejs";

// Read-only (MC-123): aggregates over existing rows, each section isolated.
export async function GET(request: NextRequest): Promise<NextResponse> {
  const unauthorized = await requireOwner(request);
  if (unauthorized) {
    return unauthorized;
  }

  return NextResponse.json(await loadDiagnosticsPulse());
}
