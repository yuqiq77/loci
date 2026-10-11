import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getClientIp } from "@/server/auth/client-ip";
import { loginRateLimiter } from "@/server/auth/rate-limit";
import {
  createSessionToken,
  getSessionCookieOptions,
  SESSION_COOKIE_NAME,
} from "@/server/auth/session";
import { verifyPassword } from "@/server/auth/password";

export const runtime = "nodejs";

export const loginBodySchema = z
  .object({
    password: z.string().min(1),
  })
  .strict();

const INVALID_LOGIN_RESPONSE = {
  error: {
    code: "INVALID_CREDENTIALS",
    message: "Invalid credentials.",
  },
};

export async function POST(request: NextRequest): Promise<NextResponse> {
  const clientIp = getClientIp(request);
  const rateLimit = loginRateLimiter.consume(clientIp);

  if (!rateLimit.allowed) {
    return NextResponse.json(
      {
        error: {
          code: "RATE_LIMITED",
          message: "Too many login attempts. Try again later.",
        },
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(rateLimit.retryAfterSeconds),
        },
      },
    );
  }

  const body = await request.json().catch(() => null);
  const parsed = loginBodySchema.safeParse(body);

  if (!parsed.success || !(await verifyPassword(parsed.data.password))) {
    return NextResponse.json(INVALID_LOGIN_RESPONSE, { status: 401 });
  }

  loginRateLimiter.reset(clientIp);

  const response = NextResponse.json({ ok: true });
  response.cookies.set(
    SESSION_COOKIE_NAME,
    await createSessionToken(),
    getSessionCookieOptions(),
  );
  return response;
}
