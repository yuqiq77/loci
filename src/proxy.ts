import { NextRequest, NextResponse } from "next/server";

import { isOwnerRequest } from "@/server/auth/request";

const PUBLIC_PATHS = new Set([
  "/login",
  "/api/auth/login",
  "/api/health",
]);

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.has(pathname)) {
    return NextResponse.next();
  }

  if (await isOwnerRequest(request)) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
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

  return NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
