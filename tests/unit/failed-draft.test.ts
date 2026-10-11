import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearFailedDraftStash,
  FAILED_DRAFT_MAX_CONTENT_LENGTH,
  FAILED_DRAFT_TTL_MS,
  type FailedDraft,
  loadFailedDraftStash,
  stashFailedDraft,
} from "@/features/chat/failed-draft";

const STASH_KEY = "loci_failed_drafts";

function fakeStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

function draft(overrides: Partial<FailedDraft> = {}): FailedDraft {
  return {
    sessionId: "11111111-1111-4111-8111-111111111111",
    content: "Hello",
    attemptId: "22222222-2222-4222-8222-222222222222",
    ...overrides,
  };
}

describe("failed draft stash", () => {
  let storage: Storage;

  beforeEach(() => {
    storage = fakeStorage();
    vi.stubGlobal("localStorage", storage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("round-trips a draft with its server ids", async () => {
    const stashed = draft({
      userMessageId: "user-id",
      assistantMessageId: "assistant-id",
    });
    stashFailedDraft(stashed, 1_000);

    expect(loadFailedDraftStash(2_000)).toEqual([stashed]);
  });

  it("round-trips a rewrite attempt's target (MC-116B)", () => {
    // Retry of a failed rewrite must re-attempt the rewrite, never a plain
    // resend — the target id has to survive the stash.
    const stashed = draft({
      retryOfMessageId: "66666666-6666-4666-8666-666666666666",
    });
    stashFailedDraft(stashed, 1_000);

    expect(loadFailedDraftStash(2_000)).toEqual([stashed]);
  });

  it("keeps one draft per session, the latest winning", () => {
    stashFailedDraft(draft({ content: "First" }), 1_000);
    stashFailedDraft(
      draft({
        content: "Second",
        attemptId: "33333333-3333-4333-8333-333333333333",
      }),
      2_000,
    );

    const loaded = loadFailedDraftStash(3_000);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].content).toBe("Second");
  });

  it("drops expired drafts on load and rewrites the store", () => {
    stashFailedDraft(draft(), 0);

    expect(loadFailedDraftStash(FAILED_DRAFT_TTL_MS + 1)).toEqual([]);
    expect(storage.getItem(STASH_KEY)).toBeNull();
  });

  it("clears the store on a version mismatch", () => {
    storage.setItem(
      STASH_KEY,
      JSON.stringify({ version: 999, drafts: [{ ...draft(), savedAt: 0 }] }),
    );

    expect(loadFailedDraftStash(1)).toEqual([]);
    expect(storage.getItem(STASH_KEY)).toBeNull();
  });

  it("clears the store on malformed content", () => {
    storage.setItem(STASH_KEY, "not json");

    expect(loadFailedDraftStash(1)).toEqual([]);
    expect(storage.getItem(STASH_KEY)).toBeNull();
  });

  it("keeps oversized content memory-only and clears the stale slot", () => {
    stashFailedDraft(draft({ content: "older attempt" }), 500);

    stashFailedDraft(
      draft({
        content: "x".repeat(FAILED_DRAFT_MAX_CONTENT_LENGTH + 1),
        attemptId: "33333333-3333-4333-8333-333333333333",
      }),
      1_000,
    );

    // Neither the oversized draft nor the stale earlier one may survive —
    // a later load must not claim outdated content as current.
    expect(storage.getItem(STASH_KEY)).toBeNull();
  });

  it("degrades silently when setItem throws", () => {
    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });

    expect(() => stashFailedDraft(draft(), 1_000)).not.toThrow();
    expect(loadFailedDraftStash(2_000)).toEqual([]);
  });

  it("clears only the requested session", () => {
    const other = draft({
      sessionId: "44444444-4444-4444-8444-444444444444",
      attemptId: "55555555-5555-4555-8555-555555555555",
    });
    stashFailedDraft(draft(), 1_000);
    stashFailedDraft(other, 1_000);

    clearFailedDraftStash(draft().sessionId);

    expect(loadFailedDraftStash(2_000)).toEqual([other]);
  });
});
