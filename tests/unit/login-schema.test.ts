import { describe, expect, it } from "vitest";

import { loginBodySchema } from "@/app/api/auth/login/route";

describe("loginBodySchema", () => {
  it("accepts only a non-empty password field", () => {
    expect(loginBodySchema.safeParse({ password: "secret" }).success).toBe(
      true,
    );
    expect(loginBodySchema.safeParse({ password: "" }).success).toBe(false);
    expect(loginBodySchema.safeParse({}).success).toBe(false);
    expect(
      loginBodySchema.safeParse({ password: "secret", username: "owner" })
        .success,
    ).toBe(false);
  });
});
