import { describe, expect, it } from "vitest";

import {
  memoriesQuerySchema,
  updateMemorySchema,
} from "@/server/memory/schema";

describe("memory schema", () => {
  it("allows editing memory kind to a known value", () => {
    expect(
      updateMemorySchema.parse({ kind: "boundary_fact" }),
    ).toEqual({ kind: "boundary_fact" });
  });

  it("rejects unknown memory kinds", () => {
    expect(() =>
      updateMemorySchema.parse({ kind: "misc" }),
    ).toThrow();
  });

  it("allows filtering memory search by kind", () => {
    expect(
      memoriesQuerySchema.parse({ kind: "boundary_fact" }).kind,
    ).toBe("boundary_fact");
  });

  it("rejects unknown memory search kinds", () => {
    expect(() =>
      memoriesQuerySchema.parse({ kind: "misc" }),
    ).toThrow();
  });
});
