import { describe, expect, it } from "vitest";

import {
  decideReconcileAction,
  observeTail,
  type TailObservation,
} from "@/features/chat/reconcile";
import type { ChatMessage, MessageStatus } from "@/shared/types";

const ATTEMPT_ID = "22222222-2222-4222-8222-222222222222";

let nextId = 0;

function message(
  role: ChatMessage["role"],
  status: MessageStatus,
  overrides: Partial<ChatMessage> = {},
): ChatMessage {
  nextId += 1;
  return {
    id: `message-${nextId}`,
    role,
    content: "text",
    status,
    createdAt: "2026-06-15T12:00:00.000Z",
    ...overrides,
  };
}

function completedPair(): ChatMessage[] {
  return [
    message("user", "complete", { attemptId: ATTEMPT_ID }),
    message("assistant", "complete"),
  ];
}

describe("observeTail", () => {
  it("finds a completed exchange by attemptId", () => {
    expect(observeTail(completedPair(), ATTEMPT_ID)).toEqual({
      kind: "completed",
    });
  });

  it("matches by attemptId even when identical content was resent", () => {
    // Two identical user texts — only the attempt id distinguishes them.
    const tail = [
      message("user", "complete", {
        content: "same words",
        attemptId: "99999999-9999-4999-8999-999999999999",
      }),
      message("assistant", "complete"),
      message("user", "complete", {
        content: "same words",
        attemptId: ATTEMPT_ID,
      }),
      message("assistant", "streaming", {
        createdAt: "2026-06-15T12:03:00.000Z",
      }),
    ];
    expect(observeTail(tail, ATTEMPT_ID)).toEqual({
      kind: "in_flight",
      assistantCreatedAt: "2026-06-15T12:03:00.000Z",
    });
  });

  it("reports retracted when no row carries the attempt id", () => {
    expect(observeTail([], ATTEMPT_ID)).toEqual({ kind: "retracted" });
    const foreign = [
      message("user", "complete", {
        attemptId: "99999999-9999-4999-8999-999999999999",
      }),
      message("assistant", "complete"),
    ];
    expect(observeTail(foreign, ATTEMPT_ID)).toEqual({ kind: "retracted" });
  });

  it("reports terminal residue for failed and cancelled assistants", () => {
    for (const status of ["failed", "cancelled"] as const) {
      const tail = [
        message("user", "complete", { attemptId: ATTEMPT_ID }),
        message("assistant", status),
      ];
      expect(observeTail(tail, ATTEMPT_ID)).toEqual({
        kind: "terminal_residue",
      });
    }
  });

  it("treats shapes the invariant forbids as terminal residue", () => {
    // A matched user row with no assistant after it, or followed by another
    // user row — the reconciler must not assume only complete, streaming,
    // or absent.
    const lone = [message("user", "complete", { attemptId: ATTEMPT_ID })];
    expect(observeTail(lone, ATTEMPT_ID)).toEqual({
      kind: "terminal_residue",
    });
    const userAfter = [
      message("user", "complete", { attemptId: ATTEMPT_ID }),
      message("user", "complete"),
    ];
    expect(observeTail(userAfter, ATTEMPT_ID)).toEqual({
      kind: "terminal_residue",
    });
  });
});

describe("decideReconcileAction", () => {
  const base = {
    attemptId: ATTEMPT_ID,
    hasLocalStream: false,
    now: Date.parse("2026-06-15T12:01:00.000Z"),
    staleStreamingMs: 6 * 60 * 1000,
    residueObservedAt: null,
    residueGraceMs: 10_000,
  };
  const inFlight: TailObservation = {
    kind: "in_flight",
    assistantCreatedAt: "2026-06-15T12:00:00.000Z",
  };

  it("clears a completed attempt without resending", () => {
    expect(decideReconcileAction({ kind: "completed" }, base)).toEqual({
      kind: "clear",
    });
  });

  it("arms a plain retry for a retracted attempt", () => {
    expect(decideReconcileAction({ kind: "retracted" }, base)).toEqual({
      kind: "arm_retry",
    });
  });

  it("leaves a locally held stream alone", () => {
    expect(
      decideReconcileAction(inFlight, { ...base, hasLocalStream: true }),
    ).toEqual({ kind: "leave" });
  });

  it("polls an orphaned in-flight attempt before its stale deadline", () => {
    expect(decideReconcileAction(inFlight, base)).toEqual({ kind: "poll" });
  });

  it("arms retry once the orphan passes the stale deadline", () => {
    const pastDeadline =
      Date.parse("2026-06-15T12:00:00.000Z") + base.staleStreamingMs;
    expect(
      decideReconcileAction(inFlight, { ...base, now: pastDeadline }),
    ).toEqual({ kind: "arm_retry" });
  });

  it("polls terminal residue through the grace window", () => {
    const residue: TailObservation = { kind: "terminal_residue" };
    expect(decideReconcileAction(residue, base)).toEqual({ kind: "poll" });
    expect(
      decideReconcileAction(residue, {
        ...base,
        residueObservedAt: base.now - base.residueGraceMs + 1,
      }),
    ).toEqual({ kind: "poll" });
  });

  it("arms a cleanup retry once residue outlives the grace", () => {
    expect(
      decideReconcileAction(
        { kind: "terminal_residue" },
        { ...base, residueObservedAt: base.now - base.residueGraceMs },
      ),
    ).toEqual({ kind: "arm_retry", cleanupAttemptId: ATTEMPT_ID });
  });
});
