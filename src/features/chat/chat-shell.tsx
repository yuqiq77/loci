"use client";

import {
  type MouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import Link from "next/link";

import { LogoutButton } from "@/components/logout-button";
import { GlassLociIcon, LociIcon } from "@/components/loci-icon";
import {
  TOOL_PAGE_COPY,
  ToolPageHeader,
  type ToolPageKey,
} from "@/components/tool-page-header";
import { DiaryList } from "@/features/diary/diary-list";
import { DiagnosticsPanel } from "@/features/diagnostics/diagnostics-panel";
import { MemoryList } from "@/features/memories/memory-list";
import { ProfileEditor } from "@/features/profile/profile-editor";
import { SessionList } from "@/features/sessions/session-list";
import { SettingsForm } from "@/features/settings/settings-form";
import { STALE_STREAMING_MS, STREAM_IDLE_TIMEOUT_MS } from "@/shared/chat";
import {
  forgetLastSession,
  rememberLastSession,
  WORKSPACE_PANEL_STORAGE_KEY,
} from "@/shared/last-session";
import { DEFAULT_SESSION_TITLE } from "@/shared/sessions";
import type {
  ChatMessage,
  SessionSummary,
  ThinkingEffort,
} from "@/shared/types";

import { Composer } from "./composer";
import {
  clearFailedDraftStash,
  type FailedDraft,
  loadFailedDraftStash,
  stashFailedDraft,
} from "./failed-draft";
import { MessageList } from "./message-list";
import { readSse } from "./read-sse";
import { nextActivity } from "./tool-status";
import { decideReconcileAction, observeTail } from "./reconcile";
import {
  decideRewriteRetry,
  dropStaleStreaming,
  hiddenPairIds,
  removeSupersededPair,
} from "./rewrite";

const MESSAGE_PAGE_SIZE = 200;
// Failure reconciliation (MC-116A): the poll rate for an orphaned in-flight
// attempt, and the grace a terminal residue row gets to disappear on its own
// (the route's mark-then-delete window) before Retry starts carrying
// cleanupAttemptId.
const RECONCILE_POLL_MS = 5_000;
const RESIDUE_GRACE_MS = 10_000;
// Bounded re-checks after the first completed exchange, not a polling loop.
// Rungs are cumulative (each schedules from the previous attempt, including
// failed ones): ~5s covers the happy path (2s worker poll + a short model
// call), ~20s a slow model, ~80s and ~140s bracket the job's first retry
// (RETRY_DELAYS_MS in src/server/db/jobs.ts: +1m, then +10m — the second
// retry is deliberately not polled). After that we stop — the title is
// still in the DB and shows on the next session load.
const TITLE_REFETCH_DELAYS_MS = [5_000, 15_000, 60_000, 60_000];

type ActiveDraft = {
  sessionId: string;
  assistantMessageId: string;
  content: string;
  thinking: string;
  // Transient web-search / client-tool activity (MC-117C), restored on
  // session switch.
  activeTool: string | null;
};

function withActivity(
  message: ChatMessage,
  activeTool: string | null,
): ChatMessage {
  return { ...message, activeTool: activeTool ?? undefined };
}

// A failed attempt surfaced as a notice. "checking" while reconciliation is
// fetching or polling the tail; "ready" once Retry is armed. needsCleanup
// marks the degraded terminal-residue case whose Retry must carry
// cleanupAttemptId.
type FailedDraftView = FailedDraft & {
  phase: "checking" | "ready";
  needsCleanup: boolean;
};

// The tool pages are the panels: one entry in TOOL_PAGE_COPY per page.
type ToolPanel = ToolPageKey;
type WorkspacePanel = "chat" | ToolPanel;

function isToolPanel(value: string | null): value is ToolPanel {
  return value !== null && Object.hasOwn(TOOL_PAGE_COPY, value);
}

function DesktopToolPanel({
  panel,
  onBack,
}: {
  panel: ToolPanel;
  onBack: () => void;
}) {
  return (
    <div className="hidden h-full overflow-y-auto bg-surface-panel md:block">
      <div className="mx-auto max-w-4xl px-6 py-8 pb-24">
        <ToolPageHeader onBack={onBack} page={panel} />
        {panel === "settings" ? <SettingsForm /> : null}
        {panel === "memories" ? <MemoryList /> : null}
        {panel === "journals" ? <DiaryList /> : null}
        {panel === "profile" ? <ProfileEditor /> : null}
        {panel === "diagnostics" ? <DiagnosticsPanel /> : null}
      </div>
    </div>
  );
}

class MessagesFetchError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function fetchAllMessages(
  sessionId: string,
  signal?: AbortSignal,
): Promise<{ messages: ChatMessage[]; rewritableTailId: string | null }> {
  const history: ChatMessage[] = [];
  // Server-computed eligibility indicator (MC-116B): taken from the last
  // page fetched — same DB truth on every page, and the last read is the
  // freshest.
  let rewritableTailId: string | null = null;
  let offset = 0;
  for (;;) {
    const response = await fetch(
      `/api/sessions/${sessionId}/messages?limit=${MESSAGE_PAGE_SIZE}&offset=${offset}`,
      signal ? { signal } : undefined,
    );
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new MessagesFetchError(
        payload?.error?.message ?? "Unable to load messages.",
        response.status,
      );
    }
    const data = await response.json();
    const page: ChatMessage[] = data.messages ?? [];
    history.push(...page);
    rewritableTailId =
      typeof data.rewritableTailId === "string" ? data.rewritableTailId : null;
    if (page.length < MESSAGE_PAGE_SIZE) {
      break;
    }
    offset += page.length;
  }
  return { messages: history, rewritableTailId };
}

function clientId(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  );
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10).join(""),
  ].join("-");
}

export function ChatShell({
  defaultModelId,
  initialSessionId,
  models,
}: {
  defaultModelId: string;
  initialSessionId: string | null;
  models: { id: string; label: string }[];
}) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  // Server-provided (last-session cookie) so the restored conversation is
  // the first thing rendered — no blank-state flash on the way back from
  // the tool pages or a reload.
  const [selectedId, setSelectedId] = useState<string | null>(
    initialSessionId,
  );
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(
    initialSessionId !== null,
  );
  // Model choices made on the blank new-chat state, applied when the first
  // send creates the conversation.
  const [draftModelId, setDraftModelId] = useState(defaultModelId);
  const [draftThinkingEnabled, setDraftThinkingEnabled] = useState(true);
  const [draftThinkingEffort, setDraftThinkingEffort] =
    useState<ThinkingEffort>("high");
  const [messageLoadError, setMessageLoadError] = useState<string | null>(
    null,
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [workspacePanel, setWorkspacePanel] =
    useState<WorkspacePanel>("chat");
  const workspacePanelMounted = useRef(false);
  const [streamingSessions, setStreamingSessions] = useState<Set<string>>(
    new Set(),
  );
  const [chatError, setChatError] = useState<string | null>(null);
  const [composerContent, setComposerContent] = useState("");
  const [failedDrafts, setFailedDrafts] = useState<
    Map<string, FailedDraftView>
  >(new Map());
  // Rewritable-tail eligibility for the selected conversation, read from the
  // messages GET (MC-116B) — never inferred from the local slice. The
  // optimistic update after `done` marks the fresh pair; the server-side
  // MESSAGE_NOT_RETRYABLE rejection is the race backstop.
  const [rewritableTailId, setRewritableTailId] = useState<string | null>(
    null,
  );
  // Tail edit in progress: the composer holds the replacement text until
  // send. previousComposer restores whatever draft the Edit click displaced.
  // Cleared on send, cancel, and any conversation switch.
  const [editingTail, setEditingTail] = useState<{
    sessionId: string;
    userMessageId: string;
    previousComposer: string;
  } | null>(null);
  // The old pair each in-flight rewrite hides locally, keyed by session —
  // the server never deleted it, so restoration on failure is just clearing
  // this marker. Render-only state; the double-click gate is pendingSends.
  const [rewriteTargets, setRewriteTargets] = useState<Map<string, string>>(
    new Map(),
  );
  const messageRequest = useRef<AbortController | null>(null);
  const selectedIdRef = useRef<string | null>(initialSessionId);
  const activeDrafts = useRef<Map<string, ActiveDraft>>(new Map());
  // Mirror of failedDrafts for the async reconciliation loops, which must
  // read the latest value between awaits.
  const failedDraftsRef = useRef<Map<string, FailedDraftView>>(new Map());
  // Sessions with a send in flight, as a ref: timer-driven retries and
  // reconcile polls run on stale render closures, so the streamingSessions
  // state cannot guard them.
  const pendingSends = useRef<Set<string>>(new Set());
  const reconcileTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  // First time a terminal residue row was observed per session — the grace
  // clock for the mark-then-delete window.
  const residueObservedAt = useRef<Map<string, number>>(new Map());
  const streamExpiryTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  const titleRefetchTimers = useRef<
    Map<string, ReturnType<typeof setTimeout>>
  >(new Map());
  // A done event from a stream that outlives the component must not re-arm
  // refetch timers after the unmount cleanup has already run.
  const unmounted = useRef(false);
  // Guards the lazy session creation against a double-send racing it: the
  // ref is the synchronous gate, the state disables the blank composer.
  const creatingSession = useRef(false);
  const [creating, setCreating] = useState(false);
  const messageViewport = useRef<HTMLDivElement | null>(null);
  const shouldAutoScroll = useRef(true);

  const selectSession = useCallback(async (id: string) => {
    setWorkspacePanel("chat");
    rememberLastSession(id);
    messageRequest.current?.abort();
    const controller = new AbortController();
    messageRequest.current = controller;

    selectedIdRef.current = id;
    setSelectedId(id);
    setDrawerOpen(false);
    setMessages([]);
    setChatError(null);
    setMessageLoadError(null);
    setRewritableTailId(null);
    setEditingTail(null);
    setLoadingMessages(true);
    try {
      const { messages: history, rewritableTailId: fetchedTailId } =
        await fetchAllMessages(id, controller.signal);

      if (!controller.signal.aborted) {
        const draft = activeDrafts.current.get(id);
        const merged = draft
          ? history.map((message) =>
              message.id === draft.assistantMessageId
                ? withActivity(
                    {
                      ...message,
                      content: draft.content,
                      thinking: draft.thinking || message.thinking,
                      status: "streaming" as const,
                    },
                    draft.activeTool,
                  )
                : message,
            )
          : history;
        setMessages(merged);
        setRewritableTailId(fetchedTailId);
        const persistedStream = history.find(
          (message) => message.status === "streaming",
        );
        const staleAt = persistedStream
          ? new Date(persistedStream.createdAt).getTime() +
            STALE_STREAMING_MS
          : 0;
        const streamIsActive =
          Boolean(draft) || (persistedStream && staleAt > Date.now());
        const existingTimer = streamExpiryTimers.current.get(id);
        if (existingTimer) {
          clearTimeout(existingTimer);
          streamExpiryTimers.current.delete(id);
        }
        if (persistedStream && !draft && streamIsActive) {
          const timer = setTimeout(() => {
            setStreamingSessions((current) => {
              const next = new Set(current);
              next.delete(id);
              return next;
            });
            streamExpiryTimers.current.delete(id);
          }, Math.max(0, staleAt - Date.now() + 50));
          streamExpiryTimers.current.set(id, timer);
        }

        setStreamingSessions((current) => {
          const next = new Set(current);
          if (streamIsActive) {
            next.add(id);
          } else {
            next.delete(id);
          }
          return next;
        });
      }
    } catch (error) {
      if (
        messageRequest.current === controller &&
        !(error instanceof DOMException && error.name === "AbortError")
      ) {
        setMessages([]);
        setMessageLoadError(
          error instanceof Error ? error.message : "Unable to load messages.",
        );
      }
    } finally {
      if (messageRequest.current === controller) {
        messageRequest.current = null;
        setLoadingMessages(false);
      }
    }
  }, []);

  // No session is created here — the blank state shows a centered composer
  // and the conversation only comes into existence on the first send.
  const startNewChat = useCallback(() => {
    setWorkspacePanel("chat");
    forgetLastSession();
    messageRequest.current?.abort();
    messageRequest.current = null;
    selectedIdRef.current = null;
    setSelectedId(null);
    setMessages([]);
    setChatError(null);
    setMessageLoadError(null);
    setRewritableTailId(null);
    setEditingTail(null);
    setLoadingMessages(false);
    setDrawerOpen(false);
    setDraftModelId(defaultModelId);
    setDraftThinkingEnabled(true);
    setDraftThinkingEffort("high");
  }, [defaultModelId]);

  useEffect(() => {
    const controller = new AbortController();
    const restoredId = initialSessionId;

    void (async () => {
      if (restoredId) {
        void selectSession(restoredId);
      }
      const response = await fetch("/api/sessions", {
        signal: controller.signal,
      });
      if (!response.ok) {
        return;
      }
      const data = await response.json();
      if (controller.signal.aborted) {
        return;
      }
      const list: SessionSummary[] = data.sessions ?? [];
      setSessions(list);
      // A stale cookie (conversation deleted elsewhere) falls back to the
      // blank new-chat state instead of an error screen.
      if (
        restoredId &&
        selectedIdRef.current === restoredId &&
        !list.some((session) => session.id === restoredId)
      ) {
        startNewChat();
      }
    })().catch((error) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setSessions([]);
      }
    });

    return () => controller.abort();
  }, [initialSessionId, selectSession, startNewChat]);

  useEffect(() => {
    // StrictMode re-runs effects after a simulated unmount whose cleanup set
    // the flag; without the reset every unmounted-guarded path stays dead
    // for the life of the page in dev.
    unmounted.current = false;
    const expiryTimers = streamExpiryTimers.current;
    const refetchTimers = titleRefetchTimers.current;
    const pollTimers = reconcileTimers.current;
    return () => {
      unmounted.current = true;
      const controller = messageRequest.current;
      messageRequest.current = null;
      controller?.abort();
      for (const timer of expiryTimers.values()) {
        clearTimeout(timer);
      }
      expiryTimers.clear();
      for (const timer of refetchTimers.values()) {
        clearTimeout(timer);
      }
      refetchTimers.clear();
      for (const timer of pollTimers.values()) {
        clearTimeout(timer);
      }
      pollTimers.clear();
    };
  }, []);

  useEffect(() => {
    const storedPanel = window.sessionStorage.getItem(
      WORKSPACE_PANEL_STORAGE_KEY,
    );
    if (
      window.matchMedia("(min-width: 768px)").matches &&
      isToolPanel(storedPanel)
    ) {
      // One-time restoration from browser-owned state after hydration.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setWorkspacePanel(storedPanel);
    }
  }, []);

  useEffect(() => {
    if (!workspacePanelMounted.current) {
      workspacePanelMounted.current = true;
      return;
    }
    if (workspacePanel === "chat") {
      window.sessionStorage.removeItem(WORKSPACE_PANEL_STORAGE_KEY);
    } else {
      window.sessionStorage.setItem(
        WORKSPACE_PANEL_STORAGE_KEY,
        workspacePanel,
      );
    }
  }, [workspacePanel]);

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 768px)");
    function keepMobileOnChat(event: MediaQueryListEvent) {
      if (!event.matches) {
        setWorkspacePanel("chat");
      }
    }
    desktop.addEventListener("change", keepMobileOnChat);
    return () => desktop.removeEventListener("change", keepMobileOnChat);
  }, []);

  // Claim stashed attempts from a previous page life (tab death mid-stream,
  // or a failure this page never got to resolve) and reconcile them. The
  // stash tolerates the session having been deleted — reconciliation drops
  // the claim on a 404.
  useEffect(() => {
    for (const draft of loadFailedDraftStash()) {
      if (failedDraftsRef.current.has(draft.sessionId)) {
        continue;
      }
      setFailedDraftView(draft.sessionId, {
        ...draft,
        phase: "checking",
        needsCleanup: false,
      });
      void reconcileFailedDraft(draft.sessionId, "verify");
    }
    // Runs once; the helpers are stable component functions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-validate tail eligibility when the user comes back to this tab: an
  // idle extraction pass may have covered the tail meanwhile (the 15-min
  // episode boundary is the NORMAL fate of a parked conversation), and
  // decision 5 wants stale Retry/Edit gone without a rejected click. The
  // server-side MESSAGE_NOT_RETRYABLE stays the backstop for the
  // still-in-foreground race.
  useEffect(() => {
    let lastRun = 0;
    const revalidate = () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      const sessionId = selectedIdRef.current;
      if (!sessionId) {
        return;
      }
      // focus and visibilitychange often fire together — one fetch is
      // enough.
      const now = Date.now();
      if (now - lastRun < 2_000) {
        return;
      }
      lastRun = now;
      void refreshMessages(sessionId);
    };
    window.addEventListener("focus", revalidate);
    document.addEventListener("visibilitychange", revalidate);
    return () => {
      window.removeEventListener("focus", revalidate);
      document.removeEventListener("visibilitychange", revalidate);
    };
    // refreshMessages reads refs and stable setters only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function scheduleTitleRefetch(sessionId: string, attempt = 0) {
    if (unmounted.current || attempt >= TITLE_REFETCH_DELAYS_MS.length) {
      return;
    }
    const existing = titleRefetchTimers.current.get(sessionId);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      titleRefetchTimers.current.delete(sessionId);
      void (async () => {
        const response = await fetch("/api/sessions");
        if (!response.ok) {
          // A transient failure consumes one rung instead of ending the
          // ladder — the later rungs exist for exactly these conditions.
          scheduleTitleRefetch(sessionId, attempt + 1);
          return;
        }
        const data = await response.json();
        const list: SessionSummary[] = data.sessions ?? [];
        // Fill in every locally-default title the response already carries;
        // a manual rename that landed locally is never overwritten.
        setSessions((current) =>
          current.map((item) => {
            if (item.title !== DEFAULT_SESSION_TITLE) {
              return item;
            }
            const server = list.find((entry) => entry.id === item.id);
            return server && server.title !== DEFAULT_SESSION_TITLE
              ? { ...item, title: server.title }
              : item;
          }),
        );
        const refreshed = list.find((item) => item.id === sessionId);
        if (refreshed && refreshed.title === DEFAULT_SESSION_TITLE) {
          scheduleTitleRefetch(sessionId, attempt + 1);
        }
      })().catch(() => scheduleTitleRefetch(sessionId, attempt + 1));
    }, TITLE_REFETCH_DELAYS_MS[attempt]);
    titleRefetchTimers.current.set(sessionId, timer);
  }

  async function renameSession(session: SessionSummary) {
    const title = window.prompt("Rename conversation", session.title)?.trim();
    if (!title || title === session.title) {
      return;
    }
    const response = await fetch(`/api/sessions/${session.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (!response.ok) {
      return;
    }
    const { session: updated } = await response.json();
    setSessions((prev) => [
      updated,
      ...prev.filter((item) => item.id !== updated.id),
    ]);
  }

  async function setSessionModel(modelId: string) {
    const sessionId = selectedIdRef.current;
    if (!sessionId) {
      return;
    }
    const previous = sessions.find((item) => item.id === sessionId)?.modelId;
    if (!previous || previous === modelId) {
      return;
    }
    setSessions((prev) =>
      prev.map((item) =>
        item.id === sessionId ? { ...item, modelId } : item,
      ),
    );
    const response = await fetch(`/api/sessions/${sessionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId }),
    });
    if (!response.ok) {
      setSessions((prev) =>
        prev.map((item) =>
          item.id === sessionId ? { ...item, modelId: previous } : item,
        ),
      );
      return;
    }
    const { session: updated } = await response.json();
    setSessions((prev) =>
      prev.map((item) => (item.id === updated.id ? updated : item)),
    );
  }

  async function patchSession(
    patch: Partial<Pick<SessionSummary, "thinkingEnabled" | "thinkingEffort">>,
  ) {
    const sessionId = selectedIdRef.current;
    if (!sessionId) {
      return;
    }
    const previous = sessions.find((item) => item.id === sessionId);
    if (!previous) {
      return;
    }
    setSessions((prev) =>
      prev.map((item) =>
        item.id === sessionId ? { ...item, ...patch } : item,
      ),
    );
    const response = await fetch(`/api/sessions/${sessionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!response.ok) {
      setSessions((prev) =>
        prev.map((item) => (item.id === sessionId ? previous : item)),
      );
      return;
    }
    const { session: updated } = await response.json();
    setSessions((prev) =>
      prev.map((item) => (item.id === updated.id ? updated : item)),
    );
  }

  async function archiveSession(session: SessionSummary) {
    const response = await fetch(`/api/sessions/${session.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
    if (response.ok) {
      removeFromList(session.id);
    }
  }

  async function deleteSession(session: SessionSummary) {
    if (!window.confirm(`Delete "${session.title}"? This cannot be undone.`)) {
      return;
    }
    const response = await fetch(`/api/sessions/${session.id}`, {
      method: "DELETE",
    });
    if (response.ok) {
      removeFromList(session.id);
    }
  }

  function removeFromList(id: string) {
    setSessions((prev) => prev.filter((item) => item.id !== id));
    if (selectedId === id) {
      forgetLastSession();
      messageRequest.current?.abort();
      messageRequest.current = null;
      selectedIdRef.current = null;
      setSelectedId(null);
      setMessages([]);
      setMessageLoadError(null);
      setRewritableTailId(null);
      setEditingTail(null);
      setLoadingMessages(false);
    }
    setRewriteTargetView(id, null);
    const timer = streamExpiryTimers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      streamExpiryTimers.current.delete(id);
    }
    const refetchTimer = titleRefetchTimers.current.get(id);
    if (refetchTimer) {
      clearTimeout(refetchTimer);
      titleRefetchTimers.current.delete(id);
    }
    dropFailedDraft(id);
  }

  function setFailedDraftView(
    sessionId: string,
    view: FailedDraftView | null,
  ) {
    // The ref updates synchronously — reconciliation reads it between
    // awaits, before React re-renders. All mutations go through here.
    const next = new Map(failedDraftsRef.current);
    if (view) {
      next.set(sessionId, view);
    } else {
      next.delete(sessionId);
    }
    failedDraftsRef.current = next;
    setFailedDrafts(next);
  }

  function setRewriteTargetView(
    sessionId: string,
    supersededUserId: string | null,
  ) {
    setRewriteTargets((current) => {
      const next = new Map(current);
      if (supersededUserId) {
        next.set(sessionId, supersededUserId);
      } else {
        next.delete(sessionId);
      }
      return next;
    });
  }

  function clearFailedDraftNotice(sessionId: string) {
    const timer = reconcileTimers.current.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      reconcileTimers.current.delete(sessionId);
    }
    residueObservedAt.current.delete(sessionId);
    setFailedDraftView(sessionId, null);
  }

  function dropFailedDraft(sessionId: string) {
    clearFailedDraftNotice(sessionId);
    clearFailedDraftStash(sessionId);
  }

  async function fetchSessionTail(
    sessionId: string,
  ): Promise<
    | { kind: "ok"; messages: ChatMessage[]; rewritableTailId: string | null }
    | { kind: "deleted" }
    | { kind: "error" }
  > {
    try {
      return { kind: "ok", ...(await fetchAllMessages(sessionId)) };
    } catch (error) {
      return error instanceof MessagesFetchError && error.status === 404
        ? { kind: "deleted" }
        : { kind: "error" };
    }
  }

  // Restore-by-refetch after a rewrite rejection: the server never touched
  // the old pair, so the refetch brings it back and refreshes eligibility.
  async function refreshMessages(sessionId: string) {
    const tail = await fetchSessionTail(sessionId);
    if (
      tail.kind !== "ok" ||
      selectedIdRef.current !== sessionId ||
      activeDrafts.current.has(sessionId) ||
      pendingSends.current.has(sessionId)
    ) {
      return;
    }
    setMessages(tail.messages);
    setRewritableTailId(tail.rewritableTailId);
  }

  function scheduleReconcile(sessionId: string, intent: "verify" | "retry") {
    const existing = reconcileTimers.current.get(sessionId);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      reconcileTimers.current.delete(sessionId);
      void reconcileFailedDraft(sessionId, intent);
    }, RECONCILE_POLL_MS);
    reconcileTimers.current.set(sessionId, timer);
  }

  // The MC-116A branch matrix: refetch the tail, then act on what the
  // attemptId finds. "retry" intent may resend (the user clicked Retry);
  // "verify" only ever clears or arms.
  async function reconcileFailedDraft(
    sessionId: string,
    intent: "verify" | "retry",
  ) {
    if (unmounted.current) {
      return;
    }
    const draft = failedDraftsRef.current.get(sessionId);
    if (!draft) {
      return;
    }
    const tail = await fetchSessionTail(sessionId);
    // Identity, not presence: the draft may have been replaced by a newer
    // failed attempt while the fetch was in flight — a stale pass must not
    // overwrite it.
    if (
      unmounted.current ||
      failedDraftsRef.current.get(sessionId)?.attemptId !== draft.attemptId
    ) {
      return;
    }
    if (tail.kind === "deleted") {
      dropFailedDraft(sessionId);
      return;
    }
    if (tail.kind === "error") {
      // Transient fetch failure: arm Retry — the click reconciles again.
      setFailedDraftView(sessionId, { ...draft, phase: "ready" });
      return;
    }
    const observation = observeTail(tail.messages, draft.attemptId);
    if (observation.kind === "terminal_residue") {
      if (!residueObservedAt.current.has(sessionId)) {
        residueObservedAt.current.set(sessionId, Date.now());
      }
    } else {
      residueObservedAt.current.delete(sessionId);
    }
    const action = decideReconcileAction(observation, {
      attemptId: draft.attemptId,
      hasLocalStream: activeDrafts.current.has(sessionId),
      now: Date.now(),
      staleStreamingMs: STALE_STREAMING_MS,
      residueObservedAt: residueObservedAt.current.get(sessionId) ?? null,
      residueGraceMs: RESIDUE_GRACE_MS,
    });
    if (action.kind === "clear") {
      dropFailedDraft(sessionId);
      if (
        selectedIdRef.current === sessionId &&
        !activeDrafts.current.has(sessionId) &&
        // A send between POST and its message SSE has an optimistic row but
        // no activeDrafts entry yet — replacing the list would wipe it.
        !pendingSends.current.has(sessionId)
      ) {
        setMessages(tail.messages);
        setRewritableTailId(tail.rewritableTailId);
      }
    } else if (action.kind === "leave") {
      // This page's live stream owns the attempt; its done/error handlers
      // will resolve the stash.
      setFailedDraftView(sessionId, null);
    } else if (action.kind === "arm_retry") {
      if (intent === "retry") {
        // A rewrite re-attempt vs composer fallback (MC-116B): only a
        // retracted observation reveals the true tail — an orphaned or
        // residual replacement occludes the indicator and the send-path
        // sweep clears it, so those re-attempt with the server backstop.
        if (
          draft.retryOfMessageId &&
          decideRewriteRetry(
            observation.kind,
            tail.rewritableTailId,
            draft.retryOfMessageId,
          ) === "composer_fallback"
        ) {
          if (selectedIdRef.current === sessionId) {
            dropFailedDraft(sessionId);
            setComposerContent((current) =>
              current.trim() ? current : draft.content,
            );
            void refreshMessages(sessionId);
          } else {
            // Dropping while unselected would lose the text with nowhere
            // to put it — keep the notice armed; the next Retry falls back
            // again once the conversation is on screen.
            setFailedDraftView(sessionId, {
              ...draft,
              phase: "ready",
              needsCleanup: false,
            });
          }
          return;
        }
        // sendMessage drops the draft only once its guards pass; a refused
        // resend re-arms the notice instead of losing the text.
        await sendMessage(
          draft.content,
          {
            retryOf: draft,
            cleanupAttemptId: action.cleanupAttemptId,
          },
          draft.retryOfMessageId,
        );
      } else {
        setFailedDraftView(sessionId, {
          ...draft,
          phase: "ready",
          needsCleanup: Boolean(action.cleanupAttemptId),
        });
        // A phantom replacement from a reload can outlive its server rows
        // (retracted while this page held the pre-retraction list): sync to
        // server truth so the old pair renders again and no forever-
        // streaming bubble survives. Same guards as the clear branch.
        if (
          selectedIdRef.current === sessionId &&
          !activeDrafts.current.has(sessionId) &&
          !pendingSends.current.has(sessionId)
        ) {
          setMessages(tail.messages);
          setRewritableTailId(tail.rewritableTailId);
        }
      }
    } else {
      setFailedDraftView(sessionId, { ...draft, phase: "checking" });
      // Retry intent survives the short residue grace (the click carries
      // through to the cleanup send); orphan polling can run for minutes,
      // so it downgrades to verify and re-arms instead of auto-resending.
      scheduleReconcile(
        sessionId,
        intent === "retry" && observation.kind === "terminal_residue"
          ? "retry"
          : "verify",
      );
    }
  }

  async function retryFailedDraft(sessionId: string) {
    const draft = failedDraftsRef.current.get(sessionId);
    if (!draft || draft.phase !== "ready") {
      return;
    }
    if (draft.needsCleanup) {
      // Reconciliation (or a retracted:false error event) already
      // established the residue; the retry carries the old attempt id so
      // the send transaction removes the pair. A rewrite residue re-attempts
      // its target too — MESSAGE_NOT_RETRYABLE is the backstop if the tail
      // moved meanwhile.
      await sendMessage(
        draft.content,
        {
          retryOf: draft,
          cleanupAttemptId: draft.attemptId,
        },
        draft.retryOfMessageId,
      );
      return;
    }
    setFailedDraftView(sessionId, { ...draft, phase: "checking" });
    await reconcileFailedDraft(sessionId, "retry");
  }

  async function sendMessage(
    content: string,
    retry?: { retryOf: FailedDraft; cleanupAttemptId?: string },
    // Tail rewrite (MC-116B): the user message id of the old exchange this
    // send replaces. Regenerate and edit both come through here; the server
    // never distinguishes them.
    rewriteOfMessageId?: string,
  ) {
    // A retry targets the failed draft's own conversation — the user may
    // have switched sessions between arming and the resend.
    let targetId = retry ? retry.retryOf.sessionId : selectedIdRef.current;
    let target = sessions.find((item) => item.id === targetId);
    // Blank new-chat state: the conversation is created on first send,
    // carrying the model and thinking choices made in the blank composer.
    if (!targetId) {
      if (creatingSession.current) {
        setComposerContent(content);
        return;
      }
      creatingSession.current = true;
      setCreating(true);
      // The user can switch to an existing conversation while the request
      // is in flight; a stale failure must not clobber a draft typed there
      // or surface its error under the wrong conversation.
      const failCreation = () => {
        if (selectedIdRef.current === null) {
          setChatError("Unable to start a new conversation.");
        }
        setComposerContent((current) => (current.trim() ? current : content));
      };
      try {
        const response = await fetch("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            modelId: draftModelId,
            thinkingEnabled: draftThinkingEnabled,
            thinkingEffort: draftThinkingEffort,
          }),
        });
        if (!response.ok) {
          failCreation();
          return;
        }
        const { session: created } = (await response.json()) as {
          session: SessionSummary;
        };
        setSessions((prev) => [created, ...prev]);
        // Claim the selection only if the blank state this send started
        // from is still on screen; otherwise the exchange continues in the
        // background like any other non-selected session's stream.
        if (selectedIdRef.current === null) {
          selectedIdRef.current = created.id;
          setSelectedId(created.id);
          rememberLastSession(created.id);
        }
        targetId = created.id;
        target = created;
      } catch {
        failCreation();
        return;
      } finally {
        creatingSession.current = false;
        setCreating(false);
      }
    }
    if (
      !targetId ||
      !target ||
      streamingSessions.has(targetId) ||
      // Fresh in-flight check: a timer-driven retry runs on a stale render
      // closure, so streamingSessions alone cannot be trusted here.
      pendingSends.current.has(targetId)
    ) {
      if (retry) {
        // Nothing was sent and nothing was dropped — re-arm the notice and
        // leave the stash alone (it may belong to an in-flight attempt).
        setFailedDraftView(retry.retryOf.sessionId, {
          ...retry.retryOf,
          phase: "ready",
          needsCleanup: Boolean(retry.cleanupAttemptId),
        });
        return;
      }
      // Nothing was sent — hand the draft back instead of dropping it.
      setComposerContent(content);
      return;
    }
    const sessionId = targetId;
    const session = target;
    if (retry) {
      // The old attempt's notice and stash are consumed by this resend only
      // now that the guards have passed; a failure of the resend re-creates
      // them under the fresh attempt id.
      dropFailedDraft(sessionId);
    }
    if (rewriteOfMessageId) {
      // Hide the old pair locally — it is not deleted server-side yet, and
      // won't be unless the replacement completes. Set only after the
      // guards pass so a refused send never leaves a pair hidden. The
      // pendingSends ref above is the synchronous double-click gate.
      setRewriteTargetView(sessionId, rewriteOfMessageId);
    }

    const optimisticId = `optimistic-${clientId()}`;
    const optimisticMessage: ChatMessage = {
      id: optimisticId,
      role: "user",
      content,
      status: "complete",
      createdAt: new Date().toISOString(),
    };
    if (selectedIdRef.current === sessionId) {
      setChatError(null);
      setMessages((current) => [...current, optimisticMessage]);
    }
    pendingSends.current.add(sessionId);
    setStreamingSessions((current) => new Set(current).add(sessionId));

    // Every attempt is stamped and stashed for its whole in-flight life, so
    // a tab death at any point leaves a reconcilable trace (MC-116A).
    const attemptId = clientId();
    stashFailedDraft({
      sessionId,
      content,
      attemptId,
      retryOfMessageId: rewriteOfMessageId,
    });

    const controller = new AbortController();
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(), STREAM_IDLE_TIMEOUT_MS);
    };
    resetIdle();
    let userMessageId: string | null = null;
    let assistantMessageId: string | null = null;
    let sawTerminal = false;
    let rejected = false;
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          content,
          modelId: session.modelId,
          attemptId,
          ...(retry?.cleanupAttemptId
            ? { cleanupAttemptId: retry.cleanupAttemptId }
            : {}),
          ...(rewriteOfMessageId
            ? { retryOfMessageId: rewriteOfMessageId }
            : {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => null);
        // A 4xx means beginGeneration rejected the send before any insert
        // (the union commits only cleanup); a 5xx can arrive after the pair
        // was persisted, so the stash must survive for reconciliation.
        const rejectedBeforePersist =
          !response.ok && response.status < 500;
        if (rejectedBeforePersist) {
          clearFailedDraftStash(sessionId);
        }
        if (rewriteOfMessageId) {
          // The old pair was never touched server-side — clearing the hide
          // marker restores it. Both rejection codes recover by refetch
          // (decision 7); the retry path refetches through reconciliation.
          setRewriteTargetView(sessionId, null);
          if (
            rejectedBeforePersist &&
            !retry &&
            payload?.error?.code !== "MESSAGE_NOT_RETRYABLE" &&
            selectedIdRef.current === sessionId
          ) {
            void refreshMessages(sessionId);
          }
        }
        if (
          rewriteOfMessageId &&
          payload?.error?.code === "MESSAGE_NOT_RETRYABLE"
        ) {
          // The race backstop (MC-116B decision 5): the tail moved or the
          // episode boundary passed under a visible affordance. No notice —
          // hand the content to the composer for the user to decide, and
          // refetch so the restored pair and fresh eligibility render.
          if (selectedIdRef.current === sessionId) {
            setMessages((current) =>
              current.filter((message) => message.id !== optimisticId),
            );
            setComposerContent((current) =>
              current.trim() ? current : content,
            );
            void refreshMessages(sessionId);
          } else {
            // The user switched away mid-resolution: with the composer out
            // of reach, dropping everything would lose the text — restore
            // an armed notice instead; its Retry falls back on screen.
            const restored = retry?.retryOf ?? {
              sessionId,
              content,
              attemptId,
              retryOfMessageId: rewriteOfMessageId,
            };
            stashFailedDraft(restored);
            setFailedDraftView(sessionId, {
              ...restored,
              phase: "ready",
              needsCleanup: false,
            });
          }
          return;
        }
        if (retry) {
          // Restore a notice and let reconciliation decide what the rows
          // became: the original attempt's for a clean rejection, this
          // attempt's when the outcome is unknown. A GENERATION_IN_PROGRESS
          // answer at the stale-deadline edge drops back to polling
          // silently instead of surfacing a send error.
          const restored = rejectedBeforePersist
            ? retry.retryOf
            : {
                sessionId,
                content,
                attemptId,
                retryOfMessageId: rewriteOfMessageId,
              };
          if (rejectedBeforePersist) {
            stashFailedDraft(retry.retryOf);
          }
          setFailedDraftView(sessionId, {
            ...restored,
            phase: "checking",
            needsCleanup: false,
          });
          if (selectedIdRef.current === sessionId) {
            setMessages((current) =>
              current.filter((message) => message.id !== optimisticId),
            );
            if (payload?.error?.code !== "GENERATION_IN_PROGRESS") {
              setChatError(
                payload?.error?.message ?? "Unable to start generation.",
              );
            }
          }
          void reconcileFailedDraft(sessionId, "verify");
          return;
        }
        rejected = rejectedBeforePersist;
        throw new Error(
          payload?.error?.message ?? "Unable to start generation.",
        );
      }

      for await (const item of readSse(response.body)) {
        resetIdle();
        if (item.event === "message") {
          userMessageId = item.data.userMessageId;
          const receivedAssistantId = item.data.assistantMessageId;
          assistantMessageId = receivedAssistantId;
          // The server accepted this attempt: retire the previous failure
          // notice and its reconciliation, preserving this send's stash.
          // A rejection before this event leaves the old notice available.
          clearFailedDraftNotice(sessionId);
          // Fill the server ids into the stash; before this event an abort
          // leaves only the attemptId, which is all reconciliation needs.
          stashFailedDraft({
            sessionId,
            content,
            attemptId,
            userMessageId: item.data.userMessageId,
            assistantMessageId: receivedAssistantId,
            retryOfMessageId: rewriteOfMessageId,
          });
          activeDrafts.current.set(sessionId, {
            sessionId,
            assistantMessageId: receivedAssistantId,
            content: "",
            thinking: "",
            activeTool: null,
          });
          setSessions((current) => {
            const updated = current.find((entry) => entry.id === sessionId);
            return updated
              ? [
                  { ...updated, updatedAt: new Date().toISOString() },
                  ...current.filter((entry) => entry.id !== sessionId),
                ]
              : current;
          });
          if (selectedIdRef.current === sessionId) {
            // dropStaleStreaming: any other locally rendered streaming
            // assistant is a reload phantom whose pair this send's sweep
            // just removed server-side — never render it as a duplicate.
            setMessages((current) => [
              ...dropStaleStreaming(current, receivedAssistantId).map(
                (message) =>
                  message.id === optimisticId
                    ? { ...message, id: item.data.userMessageId }
                    : message,
              ),
              {
                id: receivedAssistantId,
                role: "assistant",
                content: "",
                status: "streaming",
                createdAt: new Date().toISOString(),
              },
            ]);
          }
        } else if (item.event === "delta" && assistantMessageId) {
          const draft = activeDrafts.current.get(sessionId);
          // Loop-mode prose is buffered, so the first delta means every
          // tool round is over.
          if (draft) {
            draft.content += item.data.text;
            draft.activeTool = null;
          }
          if (selectedIdRef.current === sessionId) {
            setMessages((current) =>
              current.map((message) =>
                message.id === assistantMessageId
                  ? withActivity(
                      {
                        ...message,
                        content: message.content + item.data.text,
                      },
                      null,
                    )
                  : message,
              ),
            );
          }
        } else if (item.event === "thinking" && assistantMessageId) {
          const draft = activeDrafts.current.get(sessionId);
          if (draft) {
            draft.thinking += item.data.text;
          }
          if (selectedIdRef.current === sessionId) {
            setMessages((current) =>
              current.map((message) =>
                message.id === assistantMessageId
                  ? {
                      ...message,
                      thinking: (message.thinking ?? "") + item.data.text,
                    }
                  : message,
              ),
            );
          }
        } else if (
          (item.event === "search" || item.event === "tool") &&
          assistantMessageId
        ) {
          // Transient activity (MC-117C): held on the draft so a session
          // switch restores it, mirrored onto the visible message. Never
          // prose, never persisted; a tool error is not a chat failure.
          const activeTool = nextActivity(item);
          const draft = activeDrafts.current.get(sessionId);
          if (draft) {
            draft.activeTool = activeTool;
          }
          if (selectedIdRef.current === sessionId) {
            setMessages((current) =>
              current.map((message) =>
                message.id === assistantMessageId
                  ? withActivity(message, activeTool)
                  : message,
              ),
            );
          }
        } else if (item.event === "usage" && assistantMessageId) {
          if (selectedIdRef.current === sessionId) {
            setMessages((current) =>
              current.map((message) =>
                message.id === assistantMessageId
                  ? {
                      ...message,
                      inputTokens:
                        item.data.inputTokens ?? message.inputTokens,
                      outputTokens:
                        item.data.outputTokens ?? message.outputTokens,
                      cacheCreationInputTokens:
                        item.data.cacheCreationInputTokens ??
                        message.cacheCreationInputTokens,
                      cacheReadInputTokens:
                        item.data.cacheReadInputTokens ??
                        message.cacheReadInputTokens,
                    }
                  : message,
              ),
            );
          }
        } else if (item.event === "done" && assistantMessageId) {
          sawTerminal = true;
          activeDrafts.current.delete(sessionId);
          clearFailedDraftStash(sessionId);
          if (session.title === DEFAULT_SESSION_TITLE) {
            scheduleTitleRefetch(sessionId);
          }
          if (selectedIdRef.current === sessionId) {
            // On a rewrite, the swap committed with this done: the hidden
            // old pair is already gone from the server, so drop its rows
            // from local state — nothing else to restore or clean up.
            setMessages((current) => {
              const base = rewriteOfMessageId
                ? removeSupersededPair(current, rewriteOfMessageId)
                : current;
              return base.map((message) =>
                message.id === assistantMessageId
                  ? withActivity({ ...message, status: "complete" }, null)
                  : message,
              );
            });
            // The fresh exchange is the new rewritable tail; jobs advance
            // cursors only later, and MESSAGE_NOT_RETRYABLE is the backstop
            // if one wins that race.
            if (userMessageId) {
              setRewritableTailId(userMessageId);
            }
          }
          if (rewriteOfMessageId) {
            setRewriteTargetView(sessionId, null);
          }
        } else if (item.event === "error") {
          sawTerminal = true;
          // The server retracts the pair on any abnormal end (MC-116A), so
          // the old retracted/failed split collapses into one path: remove
          // the pair locally and surface the failure notice. In the
          // degraded mode (`retracted: false`, discard failed) the residue
          // rows are what Retry's reconciliation cleans up.
          if (selectedIdRef.current === sessionId) {
            setMessages((current) =>
              current.filter(
                (message) =>
                  message.id !== optimisticId &&
                  message.id !== userMessageId &&
                  message.id !== assistantMessageId,
              ),
            );
          }
          activeDrafts.current.delete(sessionId);
          // A failed rewrite retracted only the replacement; clearing the
          // hide marker restores the untouched old pair.
          if (rewriteOfMessageId) {
            setRewriteTargetView(sessionId, null);
          }
          const draft: FailedDraft = {
            sessionId,
            content,
            attemptId,
            userMessageId: userMessageId ?? undefined,
            assistantMessageId: assistantMessageId ?? undefined,
            retryOfMessageId: rewriteOfMessageId,
          };
          stashFailedDraft(draft);
          setFailedDraftView(sessionId, {
            ...draft,
            phase: "ready",
            // retracted: false is the server saying the discard itself
            // failed — the residue is established, so Retry skips the
            // grace poll and carries cleanupAttemptId immediately.
            needsCleanup: item.data.retracted === false,
          });
        }
      }
      if (!sawTerminal) {
        // The stream ended without done/error — a proxy truncation or an
        // early server close. Unresolved is a failure here; without this
        // the UI would keep a streaming bubble and never arm Retry.
        throw new Error("The response stream ended unexpectedly.");
      }
    } catch (error) {
      if (!sawTerminal && selectedIdRef.current === sessionId) {
        setMessages((current) =>
          current.filter(
            (message) =>
              message.id !== optimisticId &&
              message.id !== userMessageId &&
              message.id !== assistantMessageId,
          ),
        );
      }
      if (rejected) {
        // The server rejected the send before any stream began; nothing was
        // persisted. Hand the draft back instead of dropping it — but never
        // clobber a draft typed in the meantime.
        setComposerContent((current) =>
          current.trim() ? current : content,
        );
        if (selectedIdRef.current === sessionId) {
          setChatError(
            error instanceof Error ? error.message : "Generation failed.",
          );
        }
      } else if (!sawTerminal) {
        // Idle abort or a dropped connection: the server outcome is
        // unknown. The attempt survives as the failure notice; Retry
        // reconciles by attemptId before deciding whether to resend.
        const draft: FailedDraft = {
          sessionId,
          content,
          attemptId,
          userMessageId: userMessageId ?? undefined,
          assistantMessageId: assistantMessageId ?? undefined,
          retryOfMessageId: rewriteOfMessageId,
        };
        stashFailedDraft(draft);
        setFailedDraftView(sessionId, {
          ...draft,
          phase: "ready",
          needsCleanup: false,
        });
      } else if (selectedIdRef.current === sessionId) {
        setChatError(
          error instanceof Error ? error.message : "Generation failed.",
        );
      }
    } finally {
      clearTimeout(idleTimer);
      pendingSends.current.delete(sessionId);
      activeDrafts.current.delete(sessionId);
      // Backstop for every non-done exit (the done and error branches
      // already cleared it): the attempt is over, so nothing may stay
      // hidden — the old pair either survived server-side or was swapped
      // out, and reconciliation refetches the truth either way.
      if (rewriteOfMessageId) {
        setRewriteTargetView(sessionId, null);
      }
      const timer = streamExpiryTimers.current.get(sessionId);
      if (timer) {
        clearTimeout(timer);
        streamExpiryTimers.current.delete(sessionId);
      }
      setStreamingSessions((current) => {
        const next = new Set(current);
        next.delete(sessionId);
        return next;
      });
    }
  }

  useEffect(() => {
    if (!shouldAutoScroll.current) {
      return;
    }
    const viewport = messageViewport.current;
    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  }, [messages]);

  const selectedSession = sessions.find((s) => s.id === selectedId);
  const selectedFailedDraft = selectedId
    ? (failedDrafts.get(selectedId) ?? null)
    : null;
  // The hide rule keeps the UI single-tailed while old pair + replacement
  // coexist server-side (MC-116B): the render filter is the only thing that
  // hides — nothing is removed from state until the swap commits.
  const hiddenIds = hiddenPairIds(
    messages,
    selectedId && rewriteTargets.has(selectedId)
      ? [rewriteTargets.get(selectedId)!]
      : [],
  );
  const visibleMessages =
    hiddenIds.size > 0
      ? messages.filter((message) => !hiddenIds.has(message.id))
      : messages;
  // Retry/Edit render only when the server-computed indicator marks the
  // visible tail rewritable and nothing is in flight for this conversation.
  const tailUser = visibleMessages[visibleMessages.length - 2];
  const tailAssistant = visibleMessages[visibleMessages.length - 1];
  const rewriteReady = Boolean(
    selectedId &&
      rewritableTailId !== null &&
      !loadingMessages &&
      !streamingSessions.has(selectedId) &&
      !selectedFailedDraft &&
      tailAssistant?.role === "assistant" &&
      tailAssistant.status === "complete" &&
      tailUser?.role === "user" &&
      tailUser.id === rewritableTailId,
  );
  const editingSelectedTail =
    editingTail !== null && editingTail.sessionId === selectedId;

  function retryTail() {
    if (!rewriteReady || !tailUser) {
      return;
    }
    if (editingSelectedTail) {
      cancelEditTail();
    }
    void sendMessage(tailUser.content, undefined, tailUser.id);
  }

  function editTail() {
    // Re-clicking Edit while already editing is a no-op: overwriting would
    // clobber previousComposer (the draft the first click displaced) and
    // reset any in-progress edit back to the tail's original text.
    if (!rewriteReady || !tailUser || !selectedId || editingSelectedTail) {
      return;
    }
    setEditingTail({
      sessionId: selectedId,
      userMessageId: tailUser.id,
      previousComposer: composerContent,
    });
    setComposerContent(tailUser.content);
  }

  function cancelEditTail() {
    // Restore whatever draft the Edit click displaced — a misclick must
    // not destroy typed text.
    setComposerContent(editingTail?.previousComposer ?? "");
    setEditingTail(null);
  }

  async function handleComposerSend(content: string) {
    if (editingTail && editingTail.sessionId === selectedIdRef.current) {
      const target = editingTail.userMessageId;
      setEditingTail(null);
      await sendMessage(content, undefined, target);
      return;
    }
    await sendMessage(content);
  }

  function openToolPanel(
    event: MouseEvent<HTMLAnchorElement>,
    panel: ToolPanel,
  ) {
    if (!window.matchMedia("(min-width: 768px)").matches) {
      return;
    }
    event.preventDefault();
    setDrawerOpen(false);
    setWorkspacePanel(panel);
  }

  return (
    <div className="flex h-dvh overflow-hidden">
      {drawerOpen ? (
        <div
          aria-hidden="true"
          className="fixed inset-0 z-10 bg-stone-900/15 md:hidden"
          onClick={() => setDrawerOpen(false)}
        />
      ) : null}
      <aside
        className={`${
          drawerOpen ? "flex" : "hidden"
        } absolute inset-y-0 left-0 z-20 w-72 flex-col border-r border-stone-200/60 bg-surface p-4 shadow-xl md:static md:flex md:w-80 md:shadow-none`}
      >
        <SessionList
          sessions={sessions}
          selectedId={workspacePanel === "chat" ? selectedId : null}
          onSelect={(id) => void selectSession(id)}
          onCreate={startNewChat}
          onRename={(s) => void renameSession(s)}
          onArchive={(s) => void archiveSession(s)}
          onDelete={(s) => void deleteSession(s)}
        />
        <nav className="mt-5 space-y-1 border-t border-stone-200/80 pt-4">
          <Link
            className={`flex items-center gap-3 rounded-xl px-3.5 py-3 text-sm font-semibold transition hover:bg-stone-200/50 hover:text-stone-900 md:text-[13px] ${
              workspacePanel === "settings"
                ? "bg-stone-200 text-stone-900"
                : "text-stone-600"
            }`}
            href="/settings"
            onClick={(event) => openToolPanel(event, "settings")}
          >
            <svg aria-hidden="true" className="size-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" />
            </svg>
            <span>Settings</span>
          </Link>
          <Link
            className={`flex items-center gap-3 rounded-xl px-3.5 py-3 text-sm font-semibold transition hover:bg-stone-200/50 hover:text-stone-900 md:text-[13px] ${
              workspacePanel === "memories"
                ? "bg-stone-200 text-stone-900"
                : "text-stone-600"
            }`}
            href="/memories"
            onClick={(event) => openToolPanel(event, "memories")}
          >
            <LociIcon className="size-4 shrink-0" />
            <span>Memories</span>
          </Link>
          <Link
            className={`flex items-center gap-3 rounded-xl px-3.5 py-3 text-sm font-semibold transition hover:bg-stone-200/50 hover:text-stone-900 md:text-[13px] ${
              workspacePanel === "journals"
                ? "bg-stone-200 text-stone-900"
                : "text-stone-600"
            }`}
            href="/journals"
            onClick={(event) => openToolPanel(event, "journals")}
          >
            <svg aria-hidden="true" className="size-4 shrink-0" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" viewBox="0 0 24 24">
              <rect height="18" rx="2" width="14" x="5" y="3" />
              <path d="M9 3v18M12.5 8h3M12.5 11.5h3" />
            </svg>
            <span>Journals</span>
          </Link>
          <Link
            className={`flex items-center gap-3 rounded-xl px-3.5 py-3 text-sm font-semibold transition hover:bg-stone-200/50 hover:text-stone-900 md:text-[13px] ${
              workspacePanel === "profile"
                ? "bg-stone-200 text-stone-900"
                : "text-stone-600"
            }`}
            href="/profile"
            onClick={(event) => openToolPanel(event, "profile")}
          >
            <svg aria-hidden="true" className="size-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
              <circle cx="12" cy="8" r="4" />
              <path d="M4.5 21a7.5 7.5 0 0 1 15 0" />
            </svg>
            <span>Profile</span>
          </Link>
          <Link
            className={`flex items-center gap-3 rounded-xl px-3.5 py-3 text-sm font-semibold transition hover:bg-stone-200/50 hover:text-stone-900 md:text-[13px] ${
              workspacePanel === "diagnostics"
                ? "bg-stone-200 text-stone-900"
                : "text-stone-600"
            }`}
            href="/diagnostics"
            onClick={(event) => openToolPanel(event, "diagnostics")}
          >
            <svg aria-hidden="true" className="size-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
              <path d="M3 12h4l2.5-6 4 12 2.5-6h5" />
            </svg>
            <span>Diagnostics</span>
          </Link>
          <LogoutButton sidebar />
        </nav>
      </aside>

      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-surface-chat/50">
        {workspacePanel === "chat" ? (
          <>
        <button
          aria-controls="session-navigation"
          aria-expanded={drawerOpen}
          aria-label="Open conversations"
          className="absolute left-4 top-4 z-[6] flex size-11 items-center justify-center rounded-full border border-white/70 bg-white/80 text-stone-800 shadow-[0_8px_24px_rgba(36,33,29,0.08)] backdrop-blur-xl transition hover:bg-white md:hidden"
          onClick={() => setDrawerOpen((open) => !open)}
          type="button"
        >
          <svg
            aria-hidden="true"
            className="size-5"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeWidth="2"
            viewBox="0 0 24 24"
          >
            <path d="M6 8h12" />
            <path d="M5 12h14" />
            <path d="M6 16h6" />
          </svg>
        </button>

        {selectedId ? (
          <>
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 top-0 z-[5] h-24 md:hidden"
              data-chat-top-fade
            />

            <div
              className="flex-1 overflow-y-auto px-4 pb-40 pt-20 md:px-6 md:pb-44 md:pt-8"
              onScroll={(event) => {
                const element = event.currentTarget;
                shouldAutoScroll.current =
                  element.scrollHeight -
                    element.scrollTop -
                    element.clientHeight <
                  80;
              }}
              ref={messageViewport}
            >
              <MessageList
                messages={visibleMessages}
                loading={loadingMessages}
                loadError={messageLoadError}
                editTargetId={rewriteReady && tailUser ? tailUser.id : null}
                retryTargetId={
                  rewriteReady && tailAssistant ? tailAssistant.id : null
                }
                onEditTail={editTail}
                onRetryTail={retryTail}
              />
              {chatError ? (
                <p className="mx-auto mt-4 w-full max-w-4xl text-sm text-red-700">
                  {chatError}
                </p>
              ) : null}
              {selectedFailedDraft ? (
                <div className="mx-auto mt-4 w-full max-w-4xl rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
                  <p className="font-medium">
                    {selectedFailedDraft.phase === "ready"
                      ? "Message failed to send."
                      : "Checking an interrupted message…"}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-red-700">
                    {selectedFailedDraft.content}
                  </p>
                  {selectedFailedDraft.phase === "ready" ? (
                    <button
                      className="mt-2 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-xs font-semibold text-red-800 transition hover:bg-red-100"
                      onClick={() =>
                        void retryFailedDraft(selectedFailedDraft.sessionId)
                      }
                      type="button"
                    >
                      Retry
                    </button>
                  ) : null}
                </div>
              ) : null}
              {editingSelectedTail ? (
                <div className="mx-auto mt-4 flex w-full max-w-4xl items-center justify-between gap-3 rounded-lg border border-stone-300/70 bg-stone-100/80 px-4 py-2.5 text-sm text-stone-700">
                  <p>Editing the last message — sending will replace it.</p>
                  <button
                    className="rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-xs font-semibold text-stone-700 transition hover:bg-stone-50"
                    onClick={cancelEditTail}
                    type="button"
                  >
                    Cancel
                  </button>
                </div>
              ) : null}
            </div>

            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 bottom-0 z-[5] h-48 md:h-56"
              data-chat-bottom-fade
            />

            <Composer
              content={composerContent}
              disabled={
                loadingMessages ||
                streamingSessions.has(selectedId) ||
                // The restored conversation's summary may still be loading;
                // sending needs it (model id), so hold the composer shut.
                !selectedSession
              }
              hasMessages={messages.length > 0}
              models={models}
              modelId={selectedSession?.modelId ?? null}
              thinkingEnabled={selectedSession?.thinkingEnabled ?? false}
              thinkingEffort={selectedSession?.thinkingEffort ?? "high"}
              onContentChange={setComposerContent}
              onModelChange={(id) => void setSessionModel(id)}
              onThinkingChange={(enabled) =>
                void patchSession({ thinkingEnabled: enabled })
              }
              onEffortChange={(effort) =>
                void patchSession({ thinkingEffort: effort })
              }
              onSend={handleComposerSend}
            />
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center px-4 pb-16 md:px-6">
            <div className="w-full max-w-2xl">
              <div className="mb-6 flex flex-col items-center text-center">
                <GlassLociIcon className="mb-4 size-14 drop-shadow-[0_8px_11px_rgba(36,33,29,0.16)]" />
                <h1 className="text-xl font-normal text-stone-800">
                  What&apos;s on your mind?
                </h1>
              </div>
              {chatError ? (
                <p className="mb-4 text-center text-sm text-red-700">
                  {chatError}
                </p>
              ) : null}
              <Composer
                centered
                content={composerContent}
                disabled={creating}
                hasMessages={false}
                models={models}
                modelId={draftModelId}
                thinkingEnabled={draftThinkingEnabled}
                thinkingEffort={draftThinkingEffort}
                onContentChange={setComposerContent}
                onModelChange={setDraftModelId}
                onThinkingChange={setDraftThinkingEnabled}
                onEffortChange={setDraftThinkingEffort}
                onSend={sendMessage}
              />
            </div>
          </div>
        )}
          </>
        ) : (
          <DesktopToolPanel
            onBack={() => setWorkspacePanel("chat")}
            panel={workspacePanel}
          />
        )}
      </main>
    </div>
  );
}
