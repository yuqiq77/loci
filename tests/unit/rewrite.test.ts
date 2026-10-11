import { describe, expect, it } from "vitest";

import {
  decideRewriteRetry,
  dropStaleStreaming,
  hiddenPairIds,
  removeSupersededPair,
} from "@/features/chat/rewrite";
import type { ChatMessage } from "@/shared/types";

function message(overrides: Partial<ChatMessage> & { id: string }): ChatMessage {
  return {
    role: "user",
    content: "",
    status: "complete",
    createdAt: "2026-06-15T12:00:00.000Z",
    ...overrides,
  };
}

// The MC-116B phases: while a replacement streams, old pair + replacement
// coexist and only the hide rule keeps the UI single-tailed. No duplicate
// pair may be visible at any phase.
const oldUser = message({ id: "old-user", content: "Question" });
const oldAssistant = message({
  id: "old-assistant",
  role: "assistant",
  content: "Reply",
});

describe("hiddenPairIds", () => {
  it("hides the locally targeted pair between click and refetch", () => {
    // Phase: click/stream in this page — the local rows carry no marker.
    const optimistic = message({ id: "optimistic-1", content: "Question" });
    const replacement = message({
      id: "replacement-assistant",
      role: "assistant",
      status: "streaming",
    });
    const hidden = hiddenPairIds(
      [oldUser, oldAssistant, optimistic, replacement],
      ["old-user"],
    );
    expect(hidden).toEqual(new Set(["old-user", "old-assistant"]));
  });

  it("hides the superseded pair of a streaming replacement on reload", () => {
    // Phase: reload mid-stream — the GET returns both pairs, the
    // replacement user row carries the supersedes marker.
    const replacementUser = message({
      id: "replacement-user",
      content: "Question",
      supersedes: "old-user",
    });
    const replacementAssistant = message({
      id: "replacement-assistant",
      role: "assistant",
      status: "streaming",
    });
    const hidden = hiddenPairIds(
      [oldUser, oldAssistant, replacementUser, replacementAssistant],
      [],
    );
    expect(hidden).toEqual(new Set(["old-user", "old-assistant"]));
  });

  it("shows the old pair again once the replacement was retracted", () => {
    // Phase: failure/retraction — nothing references the old pair anymore.
    expect(hiddenPairIds([oldUser, oldAssistant], [])).toEqual(new Set());
  });

  it("does not hide for a terminal-residue replacement", () => {
    // Degraded mode: the residue is visible debris, the old pair is the
    // authoritative tail — hiding it would leave the residue as the tail.
    const residueUser = message({
      id: "residue-user",
      content: "Question",
      supersedes: "old-user",
    });
    const residueAssistant = message({
      id: "residue-assistant",
      role: "assistant",
      status: "failed",
    });
    expect(
      hiddenPairIds([oldUser, oldAssistant, residueUser, residueAssistant], []),
    ).toEqual(new Set());
  });

  it("ignores a marker whose target is no longer present", () => {
    // Phase: success — the swap removed the old pair server-side; the
    // refetched list has nothing to hide.
    const replacementUser = message({
      id: "replacement-user",
      content: "Question",
      supersedes: "old-user",
    });
    const replacementAssistant = message({
      id: "replacement-assistant",
      role: "assistant",
      status: "streaming",
    });
    expect(
      hiddenPairIds([replacementUser, replacementAssistant], []),
    ).toEqual(new Set());
  });
});

describe("removeSupersededPair", () => {
  it("drops the pair once the swap committed", () => {
    const replacementUser = message({ id: "replacement-user" });
    const replacementAssistant = message({
      id: "replacement-assistant",
      role: "assistant",
    });
    expect(
      removeSupersededPair(
        [oldUser, oldAssistant, replacementUser, replacementAssistant],
        "old-user",
      ),
    ).toEqual([replacementUser, replacementAssistant]);
  });

  it("returns the list unchanged when the pair is already gone", () => {
    const list = [message({ id: "other" })];
    expect(removeSupersededPair(list, "old-user")).toBe(list);
  });
});

describe("decideRewriteRetry", () => {
  // The failed-rewrite notice's Retry branch (MC-116B scope): re-attempt
  // against the same target vs hand the content to the composer.

  it("re-attempts a retracted rewrite whose target is still the tail", () => {
    expect(decideRewriteRetry("retracted", "old-user", "old-user")).toBe(
      "re_attempt",
    );
  });

  it("falls back to the composer once the tail moved or was covered", () => {
    expect(decideRewriteRetry("retracted", "newer-user", "old-user")).toBe(
      "composer_fallback",
    );
    expect(decideRewriteRetry("retracted", null, "old-user")).toBe(
      "composer_fallback",
    );
  });

  it("re-attempts when the replacement itself occludes the tail", () => {
    // An orphaned streaming or terminal-residue replacement is the DB tail,
    // so the indicator is null because of it — the send-path sweep clears
    // it, and MESSAGE_NOT_RETRYABLE stays the backstop. A composer
    // fallback here would turn into a plain resend that appends a
    // duplicate exchange after the restored old pair.
    expect(decideRewriteRetry("in_flight", null, "old-user")).toBe(
      "re_attempt",
    );
    expect(decideRewriteRetry("terminal_residue", null, "old-user")).toBe(
      "re_attempt",
    );
  });
});

describe("dropStaleStreaming", () => {
  it("drops a reload phantom pair when a new send begins", () => {
    const phantomUser = message({
      id: "phantom-user",
      supersedes: "old-user",
    });
    const phantomAssistant = message({
      id: "phantom-assistant",
      role: "assistant",
      status: "streaming",
    });
    const optimistic = message({ id: "optimistic-1" });
    expect(
      dropStaleStreaming(
        [oldUser, oldAssistant, phantomUser, phantomAssistant, optimistic],
        "new-assistant",
      ),
    ).toEqual([oldUser, oldAssistant, optimistic]);
  });

  it("keeps the send's own assistant and complete exchanges", () => {
    const ownAssistant = message({
      id: "new-assistant",
      role: "assistant",
      status: "streaming",
    });
    const list = [oldUser, oldAssistant, ownAssistant];
    expect(dropStaleStreaming(list, "new-assistant")).toBe(list);
  });
});
