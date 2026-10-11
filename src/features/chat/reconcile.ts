import type { ChatMessage } from "@/shared/types";

// Reconciliation is by attemptId, not content (MC-116A): identical content
// can be sent repeatedly — that is exactly the observed failure — and the
// abort can precede the message SSE, in which case the client holds no
// server ids at all. The attempt id on the user row is the only handle that
// always exists.

export type TailObservation =
  | { kind: "completed" }
  | { kind: "retracted" }
  | { kind: "in_flight"; assistantCreatedAt: string }
  | { kind: "terminal_residue" };

export function observeTail(
  messages: ChatMessage[],
  attemptId: string,
): TailObservation {
  const index = messages.findIndex(
    (message) => message.role === "user" && message.attemptId === attemptId,
  );
  if (index === -1) {
    return { kind: "retracted" };
  }
  const next = messages[index + 1];
  if (next && next.role === "assistant") {
    if (next.status === "complete") {
      return { kind: "completed" };
    }
    if (next.status === "streaming") {
      return { kind: "in_flight", assistantCreatedAt: next.createdAt };
    }
  }
  // failed/cancelled — or a shape the invariant forbids. Either way the
  // residue path (grace poll, then cleanup on retry) is the safe treatment;
  // the reconciler must not assume it can only observe complete, streaming,
  // or absent.
  return { kind: "terminal_residue" };
}

export type ReconcileAction =
  | { kind: "clear" }
  | { kind: "leave" }
  | { kind: "arm_retry"; cleanupAttemptId?: string }
  | { kind: "poll" };

export function decideReconcileAction(
  observation: TailObservation,
  context: {
    attemptId: string;
    hasLocalStream: boolean;
    now: number;
    staleStreamingMs: number;
    residueObservedAt: number | null;
    residueGraceMs: number;
  },
): ReconcileAction {
  switch (observation.kind) {
    case "completed":
      // The half-open connection outlived the client's patience: clear the
      // notice, no resend.
      return { kind: "clear" };
    case "retracted":
      return { kind: "arm_retry" };
    case "in_flight": {
      if (context.hasLocalStream) {
        // This page still holds the attempt's live stream; the ordinary
        // rendering path owns it.
        return { kind: "leave" };
      }
      // Orphaned: nothing can re-attach to an SSE stream, so poll until the
      // row resolves or its stale deadline passes — past it the send path's
      // sweep deletes the orphan pair, so recovery is self-cleaning.
      const staleAt =
        new Date(observation.assistantCreatedAt).getTime() +
        context.staleStreamingMs;
      return context.now >= staleAt ? { kind: "arm_retry" } : { kind: "poll" };
    }
    case "terminal_residue": {
      // First assume the mark-then-delete window; a row that outlives the
      // grace is the degraded mode (discard itself failed), where a plain
      // resend would re-create exactly the debris this path exists to kill —
      // so Retry carries the old attempt id for the send-side cleanup.
      if (
        context.residueObservedAt === null ||
        context.now < context.residueObservedAt + context.residueGraceMs
      ) {
        return { kind: "poll" };
      }
      return { kind: "arm_retry", cleanupAttemptId: context.attemptId };
    }
  }
}
