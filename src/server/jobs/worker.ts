import {
  CONTINUITY_CHECK_INTERVAL_MS,
  maybeEnqueueContinuityJobs,
} from "./continuity";
import {
  claimNextJob,
  completeJob,
  MAX_ATTEMPTS,
  parseJobPayload,
  recordJobExhausted,
  recordJobNote,
  recoverStaleJobs,
  retryOrFailJob,
  type ExhaustedCandidate,
} from "@/server/db/jobs";
import { JOB_ERROR_MAX_LENGTH } from "@/server/jobs/last-error";
import {
  embedMemory,
  ExtractionWindowSkippedError,
  extractMemories,
} from "@/server/memory/extract";
import { titleSession } from "@/server/sessions/title";
import {
  CompressionTerminationError,
  isHostSuspended,
} from "@/server/summaries/compression";
import {
  consolidateNarrative,
  ProviderChainError,
  type ProviderChainJob,
} from "@/server/summaries/consolidate-narrative";
import { writeDiaryEntry } from "@/server/summaries/diary";
import { updateRecentSnapshot } from "@/server/summaries/recent-snapshot";
import { summarizeSession } from "@/server/summaries/summarize";

const POLL_INTERVAL_MS = 2_000;
const MAX_ERROR_POLL_INTERVAL_MS = 60_000;

type WorkerGlobal = typeof globalThis & {
  __lociJobWorkerStarted?: boolean;
};

function errorCause(error: unknown): unknown {
  if (error && typeof error === "object" && "cause" in error) {
    return (error as { cause?: unknown }).cause;
  }
  return undefined;
}

// Appends the cause chain unless the wrapper already embeds its cause's
// message (the narrative stage wrapper would print the termination record
// twice); an empty cause message never counts as embedded.
function withCause(top: string, error: unknown): string {
  const cause = errorCause(error);
  if (!cause) {
    return top;
  }
  if (cause instanceof Error && cause.message && top.includes(cause.message)) {
    return top;
  }
  return `${top}\ncaused by: ${errorLabel(cause)}`;
}

function errorLabel(error: unknown): string {
  if (error instanceof Error) {
    const label = error.message ? `${error.name}: ${error.message}` : error.name;
    return withCause(label, error);
  }
  if (error && typeof error === "object") {
    const code =
      "code" in error && typeof error.code === "string"
        ? ` ${error.code}`
        : "";
    const message =
      "message" in error && typeof error.message === "string"
        ? `: ${error.message}`
        : "";
    return `UnknownError${code}${message}`;
  }
  return String(error);
}

// The whole cause chain, bounded: a wrapped termination record must stay
// readable from jobs.last_error alone (MC-118 scope 3). The top message
// stays bare (it is what tests and the hygiene report match on); causes
// carry their class name.
function jobErrorMessage(error: unknown): string {
  const top =
    error instanceof Error ? error.message || error.name : String(error);
  return withCause(top, error).slice(0, JOB_ERROR_MAX_LENGTH);
}

// Runs on the loop's first iteration (startup) and then every
// CONTINUITY_CHECK_INTERVAL_MS. Stale recovery is periodic, not startup-only:
// a restart inside a lease's fifteen minutes still sees it live, and only a
// later tick reaps it. The loop ticks between jobs, never during one, so a
// lease it reaps is never one this worker still holds.
export async function runWorkerTick(now: Date): Promise<void> {
  try {
    await recoverStaleJobs(now);
  } catch (error) {
    console.error("Job worker stale recovery failed.", errorLabel(error));
  }
  try {
    await maybeEnqueueContinuityJobs(now);
  } catch (error) {
    console.error("Continuity job tick failed.", errorLabel(error));
  }
}

async function runJobWorker(): Promise<void> {
  let consecutiveFailures = 0;
  let lastTickAt = 0;
  while (true) {
    let nextPollMs = POLL_INTERVAL_MS;
    try {
      const now = new Date();
      if (now.getTime() - lastTickAt >= CONTINUITY_CHECK_INTERVAL_MS) {
        lastTickAt = now.getTime();
        await runWorkerTick(now);
      }
      await runNextJob();
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      nextPollMs = Math.min(
        POLL_INTERVAL_MS * 2 ** Math.min(consecutiveFailures - 1, 5),
        MAX_ERROR_POLL_INTERVAL_MS,
      );
      console.error(
        `Job worker iteration failed. Retrying in ${Math.round(
          nextPollMs / 1_000,
        )}s.`,
        errorLabel(error),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, nextPollMs));
  }
}

// Whether the whole chain is out of retryable candidates (MC-118 decision
// 5). A chain error answers from its per-candidate outcomes; a single-
// provider writer's bare termination or a skipped extraction window is
// terminal on its own. Anything else (timeout, unavailable, unknown, or a
// wrapper around any of these) keeps the bounded job-level retries —
// `cause` is never the signal.
function isJobTerminal(error: unknown): boolean {
  return (
    (error instanceof ProviderChainError && !error.retryable) ||
    error instanceof ExtractionWindowSkippedError ||
    error instanceof CompressionTerminationError
  );
}

function chainJobFor(
  job: { id: string; payload: unknown },
): ProviderChainJob {
  const exhausted: ExhaustedCandidate[] = [
    ...((job.payload as { exhausted?: ExhaustedCandidate[] }).exhausted ?? []),
  ];
  return {
    exhausted,
    recordExhausted: async (entry) => {
      exhausted.push(entry);
      await recordJobExhausted(job.id, exhausted);
    },
    recordNote: async (note) => {
      await recordJobNote(job.id, note);
    },
  };
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0];
}

export async function runNextJob(): Promise<boolean> {
  const job = await claimNextJob();
  if (!job) {
    return false;
  }

  try {
    const payload = parseJobPayload(job.type, job.payload);
    if (job.type === "summarize_session") {
      await summarizeSession(
        (payload as { sessionId: string }).sessionId,
      );
    } else if (job.type === "update_recent_snapshot") {
      await updateRecentSnapshot();
    } else if (job.type === "extract_memories") {
      await extractMemories(
        payload as {
          sessionId: string;
        },
        { isFinalAttempt: job.attempts >= MAX_ATTEMPTS },
      );
    } else if (job.type === "embed_memory") {
      await embedMemory((payload as { memoryId: string }).memoryId);
    } else if (job.type === "consolidate_narrative") {
      await consolidateNarrative(
        (payload as { mode: "incremental" | "rebuild" }).mode,
        new Date(),
        chainJobFor(job),
      );
    } else if (job.type === "title_session") {
      await titleSession((payload as { sessionId: string }).sessionId);
    } else if (job.type === "write_diary_entry") {
      await writeDiaryEntry((payload as { date: string }).date, {
        isFinalAttempt: job.attempts >= MAX_ATTEMPTS,
        job: chainJobFor(job),
      });
    }
    await completeJob(job.id);
  } catch (error) {
    const message = jobErrorMessage(error);
    if (isHostSuspended(error)) {
      // Not this attempt's fault (decision 7): hand the attempt back and let
      // the row run again; exhausted entries already persisted stay.
      await retryOrFailJob({
        id: job.id,
        attempts: job.attempts,
        error: message,
        uncharged: true,
      });
      console.warn("job_attempt_suspended", {
        id: job.id,
        type: job.type,
        attempt: job.attempts,
        error: firstLine(message),
      });
      return true;
    }
    const terminal = isJobTerminal(error) || job.attempts >= MAX_ATTEMPTS;
    await retryOrFailJob({
      id: job.id,
      attempts: job.attempts,
      error: message,
      terminal,
    });
    // One line per failed attempt, not only the terminal one (scope 9): the
    // next attempt overwrites last_error.
    console.error(terminal ? "job_failed" : "job_attempt_failed", {
      id: job.id,
      type: job.type,
      attempt: job.attempts,
      error: firstLine(message),
    });
  }

  return true;
}

export function startJobWorker(): void {
  const workerGlobal = globalThis as WorkerGlobal;
  if (workerGlobal.__lociJobWorkerStarted) {
    return;
  }

  workerGlobal.__lociJobWorkerStarted = true;
  void runJobWorker();
}
