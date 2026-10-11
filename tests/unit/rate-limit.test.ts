import { describe, expect, it } from "vitest";

import { FixedWindowRateLimiter } from "@/server/auth/rate-limit";

describe("FixedWindowRateLimiter", () => {
  it("blocks after the configured number of attempts", () => {
    let now = 1_000;
    const limiter = new FixedWindowRateLimiter(2, 60_000, () => now);

    expect(limiter.consume("ip")).toEqual({ allowed: true });
    expect(limiter.consume("ip")).toEqual({ allowed: true });
    expect(limiter.consume("ip")).toEqual({
      allowed: false,
      retryAfterSeconds: 60,
    });

    now += 60_000;
    expect(limiter.consume("ip")).toEqual({ allowed: true });
  });

  it("resets an identity after successful authentication", () => {
    const limiter = new FixedWindowRateLimiter(1, 60_000);

    expect(limiter.consume("ip")).toEqual({ allowed: true });
    limiter.reset("ip");
    expect(limiter.consume("ip")).toEqual({ allowed: true });
  });
});
