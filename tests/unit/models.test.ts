import { describe, expect, it } from "vitest";

import {
  AVAILABLE_MODELS,
  isKnownModel,
  modelRequiresThinking,
  modelSupportsTemperature,
} from "@/server/chat/models";

describe("model registry", () => {
  it("offers the concrete selectable models without a legacy default", () => {
    expect(AVAILABLE_MODELS.map((model) => model.id)).toEqual([
      "claude-fable-5-1",
      "claude-fable-5",
      "claude-opus-5-5",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
    ]);
    expect(isKnownModel("default")).toBe(false);
    expect(isKnownModel("claude-opus-5-5")).toBe(true);
    // Retired from the picker; sessions still pinned to it must re-pick.
    expect(isKnownModel("claude-sonnet-5")).toBe(false);
  });

  it("marks always-on-thinking models (explicit disabled would 400)", () => {
    expect(modelRequiresThinking("claude-fable-5-1")).toBe(true);
    expect(modelRequiresThinking("claude-fable-5")).toBe(true);
    expect(modelRequiresThinking("claude-opus-5-5")).toBe(true);
    expect(modelRequiresThinking("claude-opus-4-6")).toBe(false);
    expect(modelRequiresThinking("claude-sonnet-4-6")).toBe(false);
  });

  it("only sends temperature for the legacy 4.6 models (allow-list)", () => {
    expect(modelSupportsTemperature("claude-opus-4-6")).toBe(true);
    expect(modelSupportsTemperature("claude-sonnet-4-6")).toBe(true);
    // 5-series rejects sampling params, and anything unlisted defaults to off.
    expect(modelSupportsTemperature("claude-opus-5-5")).toBe(false);
    expect(modelSupportsTemperature("some-future-model")).toBe(false);
  });
});
