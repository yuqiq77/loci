import { NextRequest, NextResponse } from "next/server";

import { SESSION_COOKIE_NAME, verifySessionToken } from "./session";

export async function isOwnerRequest(request: NextRequest): Promise<boolean> {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  return token ? verifySessionToken(token) : false;
}

export async function requireOwner(
  request: NextRequest,
): Promise<NextResponse | null> {
  if (await isOwnerRequest(request)) {
    return null;
  }

  return NextResponse.json(
    {
      error: {
        code: "UNAUTHORIZED",
        message: "Authentication required.",
      },
    },
    { status: 401 },
  );
}
