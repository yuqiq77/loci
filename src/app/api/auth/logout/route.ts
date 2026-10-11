import { NextRequest, NextResponse } from "next/server";

import { requireOwner } from "@/server/auth/request";
import {
  getSessionCookieOptions,
  SESSION_COOKIE_NAME,
} from "@/server/auth/session";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const unauthorized = await requireOwner(request);
  if (unauthorized) {
    return unauthorized;
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE_NAME, "", {
    ...getSessionCookieOptions(),
    maxAge: 0,
  });
  return response;
}
