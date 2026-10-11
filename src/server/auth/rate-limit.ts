type RateLimitEntry = {
  count: number;
  resetAt: number;
};

type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

export class FixedWindowRateLimiter {
  private readonly attempts = new Map<string, RateLimitEntry>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  consume(key: string): RateLimitResult {
    const currentTime = this.now();
    const existing = this.attempts.get(key);

    if (!existing || currentTime >= existing.resetAt) {
      this.attempts.set(key, {
        count: 1,
        resetAt: currentTime + this.windowMs,
      });
      return { allowed: true };
    }

    if (existing.count >= this.limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((existing.resetAt - currentTime) / 1000),
        ),
      };
    }

    existing.count += 1;
    return { allowed: true };
  }

  reset(key: string): void {
    this.attempts.delete(key);
  }

  clear(): void {
    this.attempts.clear();
  }
}

export const loginRateLimiter = new FixedWindowRateLimiter(5, 60_000);
