"use client";

import { FormEvent, useEffect, useState } from "react";

import {
  DatabaseIcon,
  HistoryIcon,
  SaveIcon,
} from "@/components/icons";
import { Markdown } from "@/features/chat/markdown";
import { estimateTextTokens } from "@/server/chat/context";

type ProfileResponse = {
  content: string;
  source: "narrative" | "standing_context";
  version: number;
  updatedAt: string | null;
  // The narrative target (normal size) and the write cap, the paste limit
  // (MC-121), in estimator tokens.
  targetTokens: number;
  tokenBudget: number;
};

// Minute precision on purpose: versions can land several times a day
// (tick, manual actions, saves), while seconds are noise. Local wall clock.
function formatUpdatedAt(iso: string): string {
  const value = new Date(iso);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(
    value.getDate(),
  )} ${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

type ConsolidateMode = "incremental" | "rebuild";

export function ProfileEditor() {
  const [draft, setDraft] = useState<string | null>(null);
  const [editorMode, setEditorMode] = useState<"edit" | "preview">("preview");
  const [source, setSource] = useState<ProfileResponse["source"]>("narrative");
  const [version, setVersion] = useState(0);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [targetTokens, setTargetTokens] = useState<number | null>(null);
  const [tokenBudget, setTokenBudget] = useState<number | null>(null);
  const [status, setStatus] = useState<
    { text: string; error: boolean } | null
  >(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [queueing, setQueueing] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch("/api/profile", {
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error("Unable to load profile.");
        }
        const loaded = (await response.json()) as ProfileResponse;
        if (!controller.signal.aborted) {
          setDraft(loaded.content);
          setSource(loaded.source);
          setVersion(loaded.version);
          setUpdatedAt(loaded.updatedAt);
          setTargetTokens(loaded.targetTokens);
          setTokenBudget(loaded.tokenBudget);
        }
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setStatus({ text: "Unable to load profile.", error: true });
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    })();

    return () => controller.abort();
  }, []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (draft === null) {
      return;
    }

    setStatus(null);
    if (tokenBudget !== null && estimateTextTokens(draft) > tokenBudget) {
      setStatus({
        text: `Too long — the limit is about ${tokenBudget} tokens (target ${targetTokens}).`,
        error: true,
      });
      return;
    }

    setSaving(true);
    try {
      const response = await fetch("/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: draft, expectedVersion: version }),
      });
      if (response.status === 409) {
        // A background consolidation wrote a newer version while this tab
        // held the old one; saving would silently replace it.
        setStatus({
          text: "The narrative was updated in the background — reload the page to edit the latest version.",
          error: true,
        });
        return;
      }
      if (!response.ok) {
        // A rejected paste carries the projected numbers (estimated size,
        // write target, capsule, snapshot, summary, chrome).
        const failure = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setStatus({
          text: failure?.error?.message ?? "Unable to save narrative.",
          error: true,
        });
        return;
      }
      const payload = (await response.json()) as ProfileResponse;
      setDraft(payload.content);
      setSource(payload.source);
      setVersion(payload.version);
      setUpdatedAt(payload.updatedAt);
      setStatus({ text: "Narrative saved.", error: false });
    } catch {
      setStatus({ text: "Unable to save narrative.", error: true });
    } finally {
      setSaving(false);
    }
  }

  async function consolidate(mode: ConsolidateMode) {
    setStatus(null);
    setQueueing(true);
    try {
      const response = await fetch("/api/profile/consolidate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      if (!response.ok) {
        setStatus({ text: "Unable to queue consolidation.", error: true });
        return;
      }
      const payload = (await response.json()) as { queued: boolean };
      if (!payload.queued) {
        setStatus({
          text: "A consolidation of this kind is already queued.",
          error: false,
        });
      } else {
        setStatus({
          text:
            mode === "rebuild"
              ? "Rebuild queued. The narrative is rewritten from raw history in the background."
              : "Consolidation queued. New material is folded in in the background.",
          error: false,
        });
      }
    } catch {
      setStatus({ text: "Unable to queue consolidation.", error: true });
    } finally {
      setQueueing(false);
    }
  }

  if (loading) {
    return <p className="text-sm text-[var(--muted)]">Loading profile...</p>;
  }
  if (draft === null) {
    return (
      <p className="text-sm text-red-700" role="alert">
        {status?.text ?? "Unable to load profile."}
      </p>
    );
  }

  const used = estimateTextTokens(draft);

  return (
    <form className="space-y-6" noValidate onSubmit={save}>
      <section className="rounded-3xl border border-stone-200/50 bg-white p-6 shadow-[0_4px_24px_rgba(0,0,0,0.01)] md:p-8">
        <div>
          <h2 className="text-[17px] font-bold text-stone-900">
            Long-term context
          </h2>
          {source === "standing_context" ? (
            <p className="mt-3 rounded-xl border border-stone-200/70 bg-stone-50 px-4 py-3 text-sm text-stone-500">
              Showing the standing-context seed — the first save or
              consolidation migrates it into the narrative store.
            </p>
          ) : null}
        </div>
        <div className="mt-5 flex items-center justify-between gap-4">
          <span className="text-xs font-bold uppercase text-stone-400">
            Markdown
          </span>
          <div
            aria-label="Profile editor mode"
            className="flex rounded-xl bg-stone-100 p-1"
            role="tablist"
          >
            {(["preview", "edit"] as const).map((mode) => (
              <button
                aria-controls="profile-editor-panel"
                aria-selected={editorMode === mode}
                className={`rounded-lg px-3 py-1.5 text-sm font-semibold capitalize transition ${
                  editorMode === mode
                    ? "bg-white text-stone-900 shadow-sm"
                    : "text-stone-500 hover:text-stone-800"
                }`}
                id={`profile-editor-tab-${mode}`}
                key={mode}
                onClick={() => setEditorMode(mode)}
                onKeyDown={(event) => {
                  if (
                    event.key !== "ArrowLeft" &&
                    event.key !== "ArrowRight"
                  ) {
                    return;
                  }
                  event.preventDefault();
                  const next = mode === "preview" ? "edit" : "preview";
                  setEditorMode(next);
                  document
                    .getElementById(`profile-editor-tab-${next}`)
                    ?.focus();
                }}
                role="tab"
                tabIndex={editorMode === mode ? 0 : -1}
                type="button"
              >
                {mode}
              </button>
            ))}
          </div>
        </div>
        <div
          aria-labelledby={`profile-editor-tab-${editorMode}`}
          className="mt-3 overflow-hidden rounded-2xl border border-stone-200 bg-stone-50/50 transition focus-within:border-stone-400"
          id="profile-editor-panel"
          role="tabpanel"
        >
          {editorMode === "edit" ? (
            <textarea
              aria-label="Profile Markdown"
              className="min-h-80 w-full resize-y bg-transparent p-5 font-mono text-base leading-relaxed text-stone-800 outline-none md:min-h-96 md:text-sm"
              data-thin-scroll
              onChange={(event) => setDraft(event.target.value)}
              placeholder="## Profile&#10;- Core details..."
              value={draft}
            />
          ) : (
            <div
              className="h-80 overflow-y-auto p-5 text-base leading-relaxed text-stone-800 md:h-96 md:text-sm"
              data-profile-preview
              data-thin-scroll
            >
              {draft.trim() ? (
                <Markdown content={draft} />
              ) : (
                <p className="text-stone-400">Nothing to preview.</p>
              )}
            </div>
          )}
        </div>

        <div
          className={`mt-3 flex flex-wrap items-center gap-1.5 font-mono text-xs ${
            tokenBudget !== null && used > tokenBudget
              ? "text-red-700"
              : "text-stone-400"
          }`}
        >
          <span>
            ~{used} / {targetTokens ?? "?"} tokens (limit {tokenBudget ?? "?"})
          </span>
          <span>·</span>
          <span>
            {source === "narrative"
              ? `narrative v${version}`
              : "standing-context seed"}
          </span>
          {updatedAt ? (
            <>
              <span>·</span>
              <span>updated {formatUpdatedAt(updatedAt)}</span>
            </>
          ) : null}
        </div>

        <div className="mt-6 border-t border-stone-100 pt-5">
          <div className="flex flex-wrap items-center gap-3">
            <button
              className="flex items-center gap-2 rounded-xl border border-stone-200 px-4 py-2 text-sm font-semibold text-stone-700 shadow-sm transition hover:bg-stone-50 disabled:opacity-50"
              disabled={queueing}
              onClick={() => void consolidate("incremental")}
              type="button"
            >
              <DatabaseIcon className="size-4 text-stone-400" />
              <span>Consolidate now</span>
            </button>
            <button
              className="flex items-center gap-2 rounded-xl border border-stone-200 px-4 py-2 text-sm font-semibold text-stone-700 shadow-sm transition hover:bg-stone-50 disabled:opacity-50"
              disabled={queueing}
              onClick={() => void consolidate("rebuild")}
              type="button"
            >
              <HistoryIcon className="size-4 text-stone-400" />
              <span>Rebuild from history</span>
            </button>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-stone-400">
            Rebuild regenerates from raw history to shed drift; the last 7
            versions are retained.
          </p>
        </div>
      </section>

      <div className="flex items-center justify-between gap-4">
        <p
          className={
            status?.error ? "text-sm text-red-700" : "text-sm text-emerald-700"
          }
          role="status"
        >
          {status?.text}
        </p>
        <button
          className="flex items-center gap-2 rounded-xl bg-ink px-6 py-2.5 text-sm font-semibold text-white shadow-md transition hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-60"
          disabled={saving}
          type="submit"
        >
          {saving ? (
            <span className="size-4 animate-spin rounded-full border-2 border-stone-500 border-t-white" />
          ) : (
            <SaveIcon className="size-4" />
          )}
          <span>{saving ? "Saving..." : "Save narrative"}</span>
        </button>
      </div>
    </form>
  );
}
