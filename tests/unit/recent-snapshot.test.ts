import { describe, expect, it } from "vitest";

import { datedRecentSnapshot } from "@/server/db/recent-snapshot";
import {
  buildRecentSnapshotPrompt,
  computeRecentSnapshotWindow,
  RECENT_SNAPSHOT_OVERLAP_MS,
} from "@/server/summaries/recent-snapshot";
import {
  PERSON_REFERENCE_RULE,
  SOURCE_LANGUAGE_RULE,
} from "@/server/summaries/writer-voice";

describe("recent continuity snapshot", () => {
  it("computes the source window with a 12-hour overlap", () => {
    const previousEnd = new Date("2026-07-02T12:00:00Z");
    const now = new Date("2026-07-03T12:00:00Z");

    expect(computeRecentSnapshotWindow(previousEnd, now)).toEqual({
      previousWindowEnd: previousEnd,
      sourceWindowStart: new Date(previousEnd.getTime() - RECENT_SNAPSHOT_OVERLAP_MS),
      sourceWindowEnd: now,
    });
    expect(computeRecentSnapshotWindow(null, now)).toEqual({
      previousWindowEnd: null,
      sourceWindowStart: null,
      sourceWindowEnd: now,
    });
  });

  it("returns dated snapshots at every age; missing and empty stay null", () => {
    const now = new Date("2026-07-02T12:00:00Z");

    expect(datedRecentSnapshot(null, now)).toBeNull();
    expect(
      datedRecentSnapshot(
        {
          content: "   ",
          version: 1,
          updatedAt: new Date("2026-07-01T12:00:00Z"),
          sourceWindowEnd: null,
          staleAfter: null,
        },
        now,
      ),
    ).toBeNull();
    // A stale row is no longer filtered: it comes back dated by its window
    // end and flagged for the trace (MC-113).
    expect(
      datedRecentSnapshot(
        {
          content: "Current work",
          version: 2,
          updatedAt: new Date("2026-06-23T13:00:00Z"),
          sourceWindowEnd: new Date("2026-06-23T12:00:00Z"),
          staleAfter: new Date("2026-06-30T12:00:00Z"),
        },
        now,
      ),
    ).toEqual({
      content: "Current work",
      version: 2,
      asOf: new Date("2026-06-23T12:00:00Z"),
      stale: true,
    });
    expect(
      datedRecentSnapshot(
        {
          content: " Current work ",
          version: 3,
          updatedAt: new Date("2026-07-02T11:00:00Z"),
          sourceWindowEnd: new Date("2026-07-02T10:00:00Z"),
          staleAfter: new Date("2026-07-09T11:00:00Z"),
        },
        now,
      ),
    ).toEqual({
      content: "Current work",
      version: 3,
      asOf: new Date("2026-07-02T10:00:00Z"),
      stale: false,
    });
    // Boundary: staleAfter equal to now is not yet stale (strict <),
    // preserved from the pre-MC-113 gate contract.
    expect(
      datedRecentSnapshot(
        {
          content: "Current work",
          version: 3,
          updatedAt: new Date("2026-07-02T11:00:00Z"),
          sourceWindowEnd: new Date("2026-07-02T10:00:00Z"),
          staleAfter: new Date("2026-07-02T12:00:00Z"),
        },
        now,
      ),
    ).toEqual({
      content: "Current work",
      version: 3,
      asOf: new Date("2026-07-02T10:00:00Z"),
      stale: false,
    });
    // Legacy rows without a source window date themselves by updated_at.
    expect(
      datedRecentSnapshot(
        {
          content: "Current work",
          version: 4,
          updatedAt: new Date("2026-07-01T12:00:00Z"),
          sourceWindowEnd: null,
          staleAfter: null,
        },
        now,
      ),
    ).toEqual({
      content: "Current work",
      version: 4,
      asOf: new Date("2026-07-01T12:00:00Z"),
      stale: false,
    });
  });

  it("builds the replacement prompt with source sections and language rule", () => {
    const prompt = buildRecentSnapshotPrompt({
      currentSnapshot: "Old snapshot",
      tokenBudget: 300,
      window: computeRecentSnapshotWindow(
        new Date("2026-07-02T00:00:00Z"),
        new Date("2026-07-02T12:00:00Z"),
      ),
      inputs: {
        hasNewInputs: true,
        summaries: [
          {
            sessionId: "session-1",
            title: "v0.2 work",
            summary: "We decided the snapshot lands before capsule assembly.",
            summaryThroughMessageId: "message-1",
            cursorCompletedAt: new Date("2026-07-02T10:00:00Z"),
          },
        ],
        activeSessions: [
          {
            sessionId: "session-1",
            title: "v0.2 work",
            lastCompletedAt: new Date("2026-07-02T11:00:00Z"),
            messages: [
              {
                role: "user",
                content: "先做 snapshot。",
                completedAt: new Date("2026-07-02T10:30:00Z"),
                createdAt: new Date("2026-07-02T10:30:00Z"),
              },
            ],
          },
        ],
        memories: [
          {
            id: "memory-1",
            content: "I still need to resolve the snapshot TTL question.",
            kind: "open_thread",
            importance: 0.8,
            resolved: false,
            pinned: false,
            updatedAt: new Date("2026-07-02T11:30:00Z"),
          },
        ],
      },
    });

    expect(prompt).toContain("Old snapshot");
    expect(prompt).toContain(SOURCE_LANGUAGE_RULE);
    expect(prompt).toContain(PERSON_REFERENCE_RULE);
    expect(prompt).toContain("Session summaries whose cursor advanced");
    expect(prompt).toContain("We decided the snapshot lands before capsule assembly.");
    expect(prompt).toContain("先做 snapshot。");
    expect(prompt).toContain("open_thread memory-1");
  });
});
