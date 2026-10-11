import { z } from "zod";

export const chatRequestSchema = z
  .object({
    sessionId: z.uuid(),
    content: z.string().trim().min(1).max(50_000),
    modelId: z.string().trim().min(1).max(100).optional(),
    // Client-stamped id of this send attempt (MC-116A). Persisted into the
    // user row's metadata; the only handle that always exists for
    // reconciliation, since identical content can be sent repeatedly and the
    // abort can precede the message SSE.
    attemptId: z.uuid(),
    // Terminal-residue recovery: the attempt id of a failed/cancelled pair
    // the send transaction must delete before inserting the new attempt.
    cleanupAttemptId: z.uuid().optional(),
    // Tail rewrite (MC-116B): the user message id of the exchange this send
    // replaces. Regenerate resends the old text, edit sends new text — the
    // server never distinguishes the two. Content always comes from `content`.
    retryOfMessageId: z.uuid().optional(),
  })
  .strict();

export type ChatRequestInput = z.infer<typeof chatRequestSchema>;
