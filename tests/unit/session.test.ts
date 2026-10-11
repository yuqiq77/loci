import { SignJWT } from "jose";
import { afterEach, describe, expect, it } from "vitest";

import {
  createSessionToken,
  getSessionCookieOptions,
  verifySessionToken,
} from "@/server/auth/session";
import { resetServerEnvForTests } from "@/server/env";

const originalEnv = { ...process.env };
const secret = "test-session-secret-that-is-32-bytes";

afterEach(() => {
  process.env = { ...originalEnv };
  resetServerEnvForTests();
});

function configure(nodeEnv: "development" | "production" = "development") {
  Object.assign(process.env, { NODE_ENV: nodeEnv });
  process.env.SESSION_SECRET = secret;
  resetServerEnvForTests();
}

describe("owner session", () => {
  it("creates and verifies an owner token", async () => {
    configure();

    expect(await verifySessionToken(await createSessionToken())).toBe(true);
  });

  it("rejects a token with a modified signature", async () => {
    configure();
    const token = await createSessionToken();
    const [header, payload, signature] = token.split(".");
    const tamperedSignature = `${signature.startsWith("a") ? "b" : "a"}${signature.slice(1)}`;
    const tampered = `${header}.${payload}.${tamperedSignature}`;

    expect(await verifySessionToken(tampered)).toBe(false);
  });

  it("rejects an expired token", async () => {
    configure();
    const expired = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("owner")
      .setIssuedAt(1)
      .setExpirationTime(2)
      .sign(new TextEncoder().encode(secret));

    expect(await verifySessionToken(expired)).toBe(false);
  });

  it("sets secure production cookie attributes", () => {
    configure("production");

    expect(getSessionCookieOptions()).toMatchObject({
      httpOnly: true,
      sameSite: "strict",
      secure: true,
      path: "/",
    });
  });

  it("allows local HTTP cookies in development", () => {
    configure();

    expect(getSessionCookieOptions().secure).toBe(false);
  });
});
