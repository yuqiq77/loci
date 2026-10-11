// Failure recovery is client-side (MC-116A): every send attempt is mirrored
// to localStorage for its lifetime so tab death cannot eat the text, and a
// failed attempt survives as a transient draft behind the failure notice.
// The mirror is best-effort — version, TTL and size gates keep junk from
// accumulating, and any storage failure degrades to memory-only (the
// component state) for the life of the page.

export type FailedDraft = {
  sessionId: string;
  content: string;
  attemptId: string;
  userMessageId?: string;
  assistantMessageId?: string;
  // Set when the failed attempt was a tail rewrite (MC-116B): a plain
  // resend would append a duplicate exchange after the restored old pair,
  // so Retry must re-attempt the rewrite against this target — or fall back
  // to the composer when the target is no longer the rewritable tail.
  retryOfMessageId?: string;
};

const STASH_KEY = "loci_failed_drafts";
const STASH_VERSION = 1;
export const FAILED_DRAFT_TTL_MS = 48 * 60 * 60 * 1000;
// Matches chatRequestSchema's content max, so every sendable draft fits the
// mirror; the guard survives only as a quota-safety backstop.
export const FAILED_DRAFT_MAX_CONTENT_LENGTH = 50_000;

type StashedDraft = FailedDraft & { savedAt: number };

type Stash = { version: number; drafts: StashedDraft[] };

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function readStash(): StashedDraft[] {
  const store = storage();
  if (!store) {
    return [];
  }
  let raw: string | null;
  try {
    raw = store.getItem(STASH_KEY);
  } catch {
    return [];
  }
  if (!raw) {
    return [];
  }
  let parsed: Stash;
  try {
    parsed = JSON.parse(raw) as Stash;
  } catch {
    removeStash();
    return [];
  }
  if (
    parsed?.version !== STASH_VERSION ||
    !Array.isArray(parsed.drafts)
  ) {
    removeStash();
    return [];
  }
  return parsed.drafts.filter(
    (draft) =>
      typeof draft?.sessionId === "string" &&
      typeof draft.content === "string" &&
      typeof draft.attemptId === "string" &&
      typeof draft.savedAt === "number",
  );
}

function writeStash(drafts: StashedDraft[]): void {
  const store = storage();
  if (!store) {
    return;
  }
  try {
    if (drafts.length === 0) {
      store.removeItem(STASH_KEY);
    } else {
      store.setItem(
        STASH_KEY,
        JSON.stringify({ version: STASH_VERSION, drafts }),
      );
    }
  } catch {
    // Quota or storage failure: degrade to memory-only.
  }
}

function removeStash(): void {
  const store = storage();
  if (!store) {
    return;
  }
  try {
    store.removeItem(STASH_KEY);
  } catch {
    // Ignore: nothing readable was there anyway.
  }
}

export function stashFailedDraft(draft: FailedDraft, now = Date.now()): void {
  if (draft.content.length > FAILED_DRAFT_MAX_CONTENT_LENGTH) {
    // Never leave a stale earlier draft claimable as if it were current.
    clearFailedDraftStash(draft.sessionId);
    return;
  }
  const others = readStash().filter(
    (entry) => entry.sessionId !== draft.sessionId,
  );
  writeStash([...others, { ...draft, savedAt: now }]);
}

export function clearFailedDraftStash(sessionId: string): void {
  const drafts = readStash();
  const kept = drafts.filter((entry) => entry.sessionId !== sessionId);
  if (kept.length !== drafts.length) {
    writeStash(kept);
  }
}

export function loadFailedDraftStash(now = Date.now()): FailedDraft[] {
  const drafts = readStash();
  const fresh = drafts.filter(
    (entry) => now - entry.savedAt <= FAILED_DRAFT_TTL_MS,
  );
  if (fresh.length !== drafts.length) {
    writeStash(fresh);
  }
  return fresh.map((entry) => ({
    sessionId: entry.sessionId,
    content: entry.content,
    attemptId: entry.attemptId,
    userMessageId: entry.userMessageId,
    assistantMessageId: entry.assistantMessageId,
    retryOfMessageId: entry.retryOfMessageId,
  }));
}
