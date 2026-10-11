import { describe, expect, it } from "vitest";

import {
  createSessionSchema,
  messagesQuerySchema,
  sessionIdSchema,
  updateSessionSchema,
} from "@/server/sessions/schema";

describe("createSessionSchema", () => {
  it("accepts an empty object and uses defaults later", () => {
    expect(createSessionSchema.safeParse({}).success).toBe(true);
  });

  it("rejects unknown fields", () => {
    expect(createSessionSchema.safeParse({ role: "admin" }).success).toBe(
      false,
    );
  });

  it("rejects an empty title", () => {
    expect(createSessionSchema.safeParse({ title: "   " }).success).toBe(false);
  });

  it("accepts thinking choices made in the blank composer", () => {
    expect(
      createSessionSchema.safeParse({
        modelId: "claude-opus-5-5",
        thinkingEnabled: true,
        thinkingEffort: "max",
      }).success,
    ).toBe(true);
  });

  it("rejects an unknown thinking effort", () => {
    expect(
      createSessionSchema.safeParse({ thinkingEffort: "extreme" }).success,
    ).toBe(false);
  });
});

describe("updateSessionSchema", () => {
  it("requires at least one field", () => {
    expect(updateSessionSchema.safeParse({}).success).toBe(false);
  });

  it("accepts an archive toggle", () => {
    expect(updateSessionSchema.safeParse({ archived: true }).success).toBe(
      true,
    );
  });
});

describe("messagesQuerySchema", () => {
  it("applies defaults", () => {
    expect(messagesQuerySchema.parse({})).toEqual({ limit: 100, offset: 0 });
  });

  it("coerces strings and enforces the maximum limit", () => {
    expect(messagesQuerySchema.parse({ limit: "50", offset: "10" })).toEqual({
      limit: 50,
      offset: 10,
    });
    expect(messagesQuerySchema.safeParse({ limit: "500" }).success).toBe(false);
  });
});

describe("sessionIdSchema", () => {
  it("rejects non-uuid identifiers", () => {
    expect(sessionIdSchema.safeParse("not-a-uuid").success).toBe(false);
  });
});
