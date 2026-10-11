import { jwtVerify, SignJWT } from "jose";

import { getSessionEnv } from "@/server/env";

export const SESSION_COOKIE_NAME = "loci_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

const OWNER_SUBJECT = "owner";

function getSigningKey(): Uint8Array {
  return new TextEncoder().encode(getSessionEnv().SESSION_SECRET);
}

export async function createSessionToken(): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(OWNER_SUBJECT)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .sign(getSigningKey());
}

export async function verifySessionToken(token: string): Promise<boolean> {
  try {
    await jwtVerify(token, getSigningKey(), {
      algorithms: ["HS256"],
      subject: OWNER_SUBJECT,
    });
    return true;
  } catch {
    return false;
  }
}

export function getSessionCookieOptions() {
  return {
    httpOnly: true,
    maxAge: SESSION_MAX_AGE_SECONDS,
    path: "/",
    sameSite: "strict" as const,
    secure: getSessionEnv().NODE_ENV === "production",
  };
}
