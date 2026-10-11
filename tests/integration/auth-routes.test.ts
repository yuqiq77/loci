import { argon2id, hash } from "argon2";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loginRateLimiter } from "@/server/auth/rate-limit";
import { requireOwner } from "@/server/auth/request";
import {
  createSessionToken,
  SESSION_COOKIE_NAME,
} from "@/server/auth/session";
import { resetServerEnvForTests } from "@/server/env";
import { proxy } from "@/proxy";

const originalEnv = { ...process.env };
const password = "correct horse battery staple";

beforeAll(async () => {
  Object.assign(process.env, { NODE_ENV: "test" });
  process.env.APP_ORIGIN = "http://localhost:3000";
  process.env.DATABASE_URL =
    "postgresql://loci:loci@localhost:5432/loci";
  process.env.SESSION_SECRET = "integration-session-secret-32-bytes";
  process.env.OWNER_PASSWORD_HASH = await hash(password, { type: argon2id });
  resetServerEnvForTests();
});

afterAll(() => {
  process.env = { ...originalEnv };
  resetServerEnvForTests();
});

beforeEach(() => {
  loginRateLimiter.clear();
});

function loginRequest(body: unknown, ip = "127.0.0.1") {
  return new NextRequest("http://localhost:3000/api/auth/login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": ip,
    },
    body: JSON.stringify(body),
  });
}

describe("authentication routes", () => {
  it("sets the owner cookie after a successful login", async () => {
    const { POST } = await import("@/app/api/auth/login/route");

    const response = await POST(loginRequest({ password }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(response.headers.get("set-cookie")).toContain(
      `${SESSION_COOKIE_NAME}=`,
    );
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toMatch(/SameSite=strict/i);
  });

  it("uses the same generic response for invalid input and password", async () => {
    const { POST } = await import("@/app/api/auth/login/route");

    const invalidBody = await POST(loginRequest({}));
    const wrongPassword = await POST(
      loginRequest({ password: "definitely wrong" }, "127.0.0.2"),
    );

    expect(invalidBody.status).toBe(401);
    expect(wrongPassword.status).toBe(401);
    await expect(invalidBody.json()).resolves.toEqual(
      await wrongPassword.json(),
    );
  });

  it("rate limits the sixth failed attempt for one IP", async () => {
    const { POST } = await import("@/app/api/auth/login/route");

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await POST(
        loginRequest({ password: "wrong" }, "127.0.0.3"),
      );
      expect(response.status).toBe(401);
    }

    const blocked = await POST(
      loginRequest({ password: "wrong" }, "127.0.0.3"),
    );
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
  });

  it("clears the cookie on authenticated logout", async () => {
    const { POST } = await import("@/app/api/auth/logout/route");
    const token = await createSessionToken();
    const request = new NextRequest(
      "http://localhost:3000/api/auth/logout",
      {
        method: "POST",
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${token}`,
        },
      },
    );

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain(
      `${SESSION_COOKIE_NAME}=`,
    );
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("requires a valid owner cookie in protected API handlers", async () => {
    const missing = new NextRequest("http://localhost:3000/api/private");
    expect((await requireOwner(missing))?.status).toBe(401);

    const valid = new NextRequest("http://localhost:3000/api/private", {
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${await createSessionToken()}`,
      },
    });
    expect(await requireOwner(valid)).toBeNull();
  });

  it("does not exempt dotted page or API paths", async () => {
    const dottedPage = await proxy(
      new NextRequest("http://localhost:3000/private.html"),
    );
    expect(dottedPage.status).toBe(307);
    expect(dottedPage.headers.get("location")).toBe(
      "http://localhost:3000/login",
    );

    const dottedApi = await proxy(
      new NextRequest("http://localhost:3000/api/private.json"),
    );
    expect(dottedApi.status).toBe(401);
  });
});
