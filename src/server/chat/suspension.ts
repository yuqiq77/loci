import { CHAT_TIMEOUT_MS } from "@/shared/chat";

import { ProviderError } from "./provider-error";
import type { ChatProvider } from "./types";

// A call whose wall clock ran this far past its own timer is treated as a
// suspected host suspension (MC-118 decision 7). A heuristic, not a proof —
// Node timers are not guaranteed to fire on time, and an event-loop stall
// delays them too — accepted knowingly because under the source fence a
// mis-charged sleep timeout blocks a source for good.
export const HOST_SUSPENSION_FACTOR = 1.5;

// Background-only wrapper (applied by the compression / consolidation / chat
// background provider factories, never the user-facing chat provider): a
// timeout or connection failure whose wall clock outran the call's own timer
// — the timer fired late, or the socket died on resume — becomes
// HOST_SUSPENDED, which the job worker refunds instead of charging.
export function withSuspensionDetection(
  provider: ChatProvider,
  timeoutMs = CHAT_TIMEOUT_MS,
): ChatProvider {
  return {
    async *stream(request, signal) {
      const startedAt = Date.now();
      try {
        yield* provider.stream(request, signal);
      } catch (error) {
        if (
          !signal.aborted &&
          error instanceof ProviderError &&
          (error.code === "GENERATION_TIMEOUT" ||
            error.code === "PROVIDER_UNAVAILABLE") &&
          Date.now() - startedAt >= timeoutMs * HOST_SUSPENSION_FACTOR
        ) {
          throw new ProviderError(
            "HOST_SUSPENDED",
            `Provider call outlived its ${Math.round(
              timeoutMs / 1000,
            )}s timeout by wall clock; the host was probably suspended.`,
          );
        }
        throw error;
      }
    },
    countTokens: provider.countTokens
      ? (request, signal) => provider.countTokens!(request, signal)
      : undefined,
  };
}
