"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";

import { MemoryTrace } from "@/features/diagnostics/memory-trace";
import { MEMORY_KINDS } from "@/shared/types";

import type { MemoryKind, MemoryView } from "./types";

const PAGE_SIZE = 50;
type View = "active" | "trash";
type KindFilter = "all" | MemoryKind;
const MEMORY_KIND_OPTIONS: readonly MemoryKind[] = MEMORY_KINDS;

type EditState = Pick<
  MemoryView,
  | "content"
  | "kind"
  | "importance"
  | "valence"
  | "arousal"
  | "resolved"
  | "pinned"
  | "supersededBy"
>;

function editState(memory: MemoryView): EditState {
  return {
    content: memory.content,
    kind: memory.kind,
    importance: memory.importance,
    valence: memory.valence,
    arousal: memory.arousal,
    resolved: memory.resolved,
    pinned: memory.pinned,
    supersededBy: memory.supersededBy,
  };
}

function formatMemoryDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4-4" />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="m5 12 4 4L19 6" />
    </svg>
  );
}

function XIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  );
}

export function MemoryList() {
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [view, setView] = useState<View>("active");
  const [memories, setMemories] = useState<MemoryView[]>([]);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  // The MC-123 trace drawer: one open at a time.
  const [traceId, setTraceId] = useState<string | null>(null);
  const [draft, setDraft] = useState<EditState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadMemories = useCallback(
    async (
      search: string,
      kind: KindFilter,
      pageIndex: number,
      currentView: View,
      signal: AbortSignal,
    ) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          q: search,
          limit: String(PAGE_SIZE),
          offset: String(pageIndex * PAGE_SIZE),
        });
        if (kind !== "all") {
          params.set("kind", kind);
        }
        if (currentView === "trash") {
          params.set("trash", "true");
        }
        const response = await fetch(`/api/memories?${params}`, { signal });
        if (!response.ok) {
          throw new Error("Unable to load memories.");
        }
        const data = await response.json();
        setMemories(data.memories ?? []);
        setTotal(data.total ?? 0);
      } catch (loadError) {
        if (signal.aborted) {
          return;
        }
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Unable to load memories.",
        );
      } finally {
        if (!signal.aborted) {
          setLoading(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(
      () =>
        void loadMemories(
          query,
          kindFilter,
          page,
          view,
          controller.signal,
        ),
      200,
    );
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [kindFilter, loadMemories, page, query, view]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  async function saveMemory(event: FormEvent, memory: MemoryView) {
    event.preventDefault();
    if (!draft) {
      return;
    }
    setError(null);
    const response = await fetch(`/api/memories/${memory.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    });
    if (!response.ok) {
      setError("Unable to update memory.");
      return;
    }
    const { memory: updated } = await response.json();
    setMemories((current) =>
      current.map((item) => (item.id === updated.id ? updated : item)),
    );
    setEditingId(null);
    setDraft(null);
  }

  async function deleteMemory(memory: MemoryView) {
    if (!window.confirm("Move this memory to the bin?")) {
      return;
    }
    const response = await fetch(`/api/memories/${memory.id}`, {
      method: "DELETE",
    });
    if (response.ok) {
      removeFromCurrentPage(memory.id);
    } else {
      setError("Unable to delete memory.");
    }
  }

  async function restoreDeletedMemory(memory: MemoryView) {
    const response = await fetch(`/api/memories/${memory.id}`, {
      method: "POST",
    });
    if (response.ok) {
      removeFromCurrentPage(memory.id);
    } else {
      setError("Unable to restore memory.");
    }
  }

  async function permanentlyDeleteMemory(memory: MemoryView) {
    if (
      !window.confirm(
        "Permanently delete this memory? This cannot be undone.",
      )
    ) {
      return;
    }
    const response = await fetch(
      `/api/memories/${memory.id}?permanent=true`,
      { method: "DELETE" },
    );
    if (response.ok) {
      removeFromCurrentPage(memory.id);
    } else {
      setError("Unable to permanently delete memory.");
    }
  }

  function removeFromCurrentPage(id: string) {
    setMemories((current) => current.filter((item) => item.id !== id));
    setTotal((current) => Math.max(0, current - 1));
    if (memories.length === 1 && page > 0) {
      setTraceId(null);
      setPage((current) => current - 1);
    }
  }

  function switchView(nextView: View) {
    setView(nextView);
    setPage(0);
    setMemories([]);
    setTotal(0);
    setLoading(true);
    setEditingId(null);
    setDraft(null);
    setTraceId(null);
  }

  return (
    <div className="space-y-6">
      <div className="flex gap-2" role="tablist" aria-label="Memory views">
        {(["active", "trash"] as const).map((item) => (
          <button
            aria-selected={view === item}
            className={
              view === item
                ? "rounded-xl bg-ink px-5 py-2 text-sm font-semibold text-white shadow-sm"
                : "rounded-xl border border-stone-200/50 bg-stone-100 px-5 py-2 text-sm font-semibold text-stone-600 transition hover:bg-stone-200/60"
            }
            key={item}
            onClick={() => switchView(item)}
            role="tab"
            type="button"
          >
            {item === "active" ? "Memories" : "Bin"}
          </button>
        ))}
      </div>

      <div className="grid items-end gap-4 sm:grid-cols-[1fr_220px]">
        <label className="block">
          <span className="mb-1.5 block text-xs font-bold uppercase text-stone-500">
            Search {view === "trash" ? "bin" : "memories"}
          </span>
          <span className="relative block">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-stone-400" />
            <input
              className="h-11 w-full rounded-xl border border-stone-200/80 bg-white pl-9 pr-4 text-base text-stone-800 outline-none transition placeholder:text-stone-400 focus:border-stone-400 md:text-sm"
              onChange={(event) => {
                setQuery(event.target.value);
                setTraceId(null);
                setPage(0);
              }}
              placeholder="Search by content"
              type="search"
              value={query}
            />
          </span>
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-bold uppercase text-stone-500">
            Kind
          </span>
          <select
            className="h-11 w-full rounded-xl border border-stone-200/80 bg-white px-3 text-base text-stone-700 outline-none transition focus:border-stone-400 md:text-sm"
            onChange={(event) => {
              setKindFilter(event.target.value as KindFilter);
              setTraceId(null);
              setPage(0);
            }}
            value={kindFilter}
          >
            <option value="all">All kinds</option>
            {MEMORY_KIND_OPTIONS.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error ? (
        <p className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </p>
      ) : null}
      {loading ? (
        <p className="py-8 text-center text-sm text-stone-400">
          Loading memories...
        </p>
      ) : null}
      {!loading && memories.length === 0 ? (
        <div className="rounded-3xl border border-stone-200/50 bg-white p-12 text-center">
          <SearchIcon className="mx-auto mb-3 size-7 text-stone-300" />
          <p className="text-sm font-semibold text-stone-500">
            {view === "trash" ? "The bin is empty" : "No memories found"}
          </p>
          <p className="mt-1 text-xs text-stone-400">
            Adjust the search or kind filter to see other results.
          </p>
        </div>
      ) : null}

      <ul className="space-y-4">
        {memories.map((memory) => (
          <li
            className="rounded-3xl border border-stone-200/50 bg-white p-5 shadow-[0_4px_24px_rgba(0,0,0,0.01)] transition hover:border-stone-300/80 md:p-6"
            data-memory-id={memory.id}
            key={memory.id}
          >
            {view === "active" && editingId === memory.id && draft ? (
              <form
                className="space-y-5"
                onSubmit={(event) => void saveMemory(event, memory)}
              >
                <label className="block">
                  <span className="mb-2 block text-xs font-bold uppercase text-stone-500">
                    Memory content
                  </span>
                  <textarea
                    className="min-h-28 w-full resize-y rounded-xl border border-stone-200 bg-stone-50/60 p-4 text-base leading-relaxed text-stone-800 outline-none transition focus:border-stone-400 md:text-sm"
                    onChange={(event) =>
                      setDraft({ ...draft, content: event.target.value })
                    }
                    required
                    value={draft.content}
                  />
                </label>

                <div className="flex flex-wrap items-center gap-6">
                  {(["resolved", "pinned"] as const).map((field) => (
                    <label
                      className="flex cursor-pointer items-center gap-2 text-sm font-medium text-stone-600"
                      key={field}
                    >
                      <input
                        checked={draft[field]}
                        className="size-4 accent-ink"
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            [field]: event.target.checked,
                          })
                        }
                        type="checkbox"
                      />
                      <span className="capitalize">{field}</span>
                    </label>
                  ))}
                </div>

                <div className="grid gap-5 border-t border-stone-100 pt-5 md:grid-cols-4">
                  <label className="block">
                    <span className="mb-2 block text-xs font-bold uppercase text-stone-500">
                      Kind
                    </span>
                    <select
                      className="w-full rounded-xl border border-stone-200 bg-stone-50/60 px-3 py-2.5 text-base text-stone-700 outline-none transition focus:border-stone-400 md:text-sm"
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          kind: event.target.value as MemoryKind,
                        })
                      }
                      value={draft.kind}
                    >
                      {MEMORY_KIND_OPTIONS.map((kind) => (
                        <option key={kind} value={kind}>
                          {kind}
                        </option>
                      ))}
                    </select>
                  </label>

                  {(["importance", "valence", "arousal"] as const).map(
                    (field) => (
                      <label className="block" key={field}>
                        <span className="mb-2 block text-xs font-bold uppercase text-stone-500">
                          <span className="capitalize">{field}</span>
                        </span>
                        <input
                          className="w-full rounded-xl border border-stone-200 bg-stone-50/60 px-3 py-2.5 text-base text-stone-700 outline-none transition focus:border-stone-400 md:text-sm"
                          max={1}
                          min={field === "valence" ? -1 : 0}
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              [field]: Number(event.target.value),
                            })
                          }
                          required
                          step="0.1"
                          type="number"
                          value={draft[field]}
                        />
                      </label>
                    ),
                  )}
                </div>

                <label className="block">
                  <span className="mb-2 block text-xs font-bold uppercase text-stone-500">
                    Superseded by memory ID
                  </span>
                  <input
                    className="w-full rounded-xl border border-stone-200 bg-stone-50/60 px-3 py-2.5 text-base text-stone-700 outline-none transition focus:border-stone-400 md:text-sm"
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        supersededBy: event.target.value.trim() || null,
                      })
                    }
                    placeholder="Leave empty for none"
                    type="text"
                    value={draft.supersededBy ?? ""}
                  />
                </label>

                <div className="flex items-center justify-end gap-2 border-t border-stone-100 pt-4">
                  <button
                    className="flex items-center gap-1.5 rounded-xl border border-stone-200 px-4 py-2 text-sm font-semibold text-stone-500 transition hover:bg-stone-50"
                    onClick={() => {
                      setEditingId(null);
                      setDraft(null);
                    }}
                    type="button"
                  >
                    <XIcon className="size-4" />
                    <span>Cancel</span>
                  </button>
                  <button
                    className="flex items-center gap-1.5 rounded-xl bg-ink px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-stone-800"
                    type="submit"
                  >
                    <CheckIcon className="size-4" />
                    <span>Save changes</span>
                  </button>
                </div>
              </form>
            ) : (
              <div className="space-y-4">
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-stone-900">
                  {memory.content}
                </p>
                <dl className="grid grid-cols-2 gap-x-2 gap-y-4 border-t border-stone-100/70 pt-4 sm:grid-cols-6">
                  <div>
                    <dt className="text-xs text-stone-400">Kind</dt>
                    <dd className="mt-1 truncate text-[13px] text-stone-700">
                      {memory.kind}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-stone-400">
                      Importance
                    </dt>
                    <dd className="mt-1 text-[13px] text-stone-700">
                      {memory.importance}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-stone-400">
                      Valence
                    </dt>
                    <dd className="mt-1 text-[13px] text-stone-700">
                      {memory.valence}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-stone-400">
                      Arousal
                    </dt>
                    <dd className="mt-1 text-[13px] text-stone-700">
                      {memory.arousal}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-stone-400">
                      Resolved
                    </dt>
                    <dd className="mt-1 text-[13px] text-stone-700">
                      {memory.resolved ? "Yes" : "No"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-stone-400">
                      Pinned
                    </dt>
                    <dd className="mt-1 text-[13px] text-stone-700">
                      {memory.pinned ? "Yes" : "No"}
                    </dd>
                  </div>
                </dl>
                {memory.supersededByMemory ? (
                  <div className="mt-3 rounded-lg border border-[var(--border)] bg-[#faf9f7] p-3 text-sm">
                    <p className="font-medium">Superseded by</p>
                    <p className="mt-1 text-[var(--muted)]">
                      {memory.supersededByMemory.id}
                    </p>
                    <p className="mt-1">{memory.supersededByMemory.content}</p>
                  </div>
                ) : null}
                {memory.supersedes.length > 0 ? (
                  <div className="mt-3 rounded-lg border border-[var(--border)] bg-[#faf9f7] p-3 text-sm">
                    <p className="font-medium">Supersedes</p>
                    <ul className="mt-2 space-y-2">
                      {memory.supersedes.map((item) => (
                        <li key={item.id}>
                          <p className="text-[var(--muted)]">{item.id}</p>
                          <p>{item.content}</p>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {view === "active" ? (
                  <div className="flex items-center justify-between gap-4 border-t border-stone-100 pt-3">
                    <div className="flex gap-4 text-sm font-semibold">
                      <button
                        className="text-stone-500 transition hover:text-stone-800"
                        onClick={() => {
                          setEditingId(memory.id);
                          setDraft(editState(memory));
                        }}
                        type="button"
                      >
                        Edit
                      </button>
                      <button
                        className="text-red-500/80 transition hover:text-red-600"
                        onClick={() => void deleteMemory(memory)}
                        type="button"
                      >
                        Move to bin
                      </button>
                      <button
                        className="text-stone-500 transition hover:text-stone-800"
                        onClick={() =>
                          setTraceId((current) =>
                            current === memory.id ? null : memory.id,
                          )
                        }
                        type="button"
                      >
                        Trace
                      </button>
                    </div>
                    <time className="text-[11px] text-stone-400">
                      {formatMemoryDate(memory.updatedAt)}
                    </time>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-4 border-t border-stone-100 pt-3">
                    <div className="flex gap-4 text-sm font-semibold">
                      <button
                        className="text-emerald-600 transition hover:text-emerald-700"
                        onClick={() => void restoreDeletedMemory(memory)}
                        type="button"
                      >
                        Restore
                      </button>
                      <button
                        className="text-red-500/80 transition hover:text-red-600"
                        onClick={() => void permanentlyDeleteMemory(memory)}
                        type="button"
                      >
                        Delete permanently
                      </button>
                      <button
                        className="text-stone-500 transition hover:text-stone-800"
                        onClick={() =>
                          setTraceId((current) =>
                            current === memory.id ? null : memory.id,
                          )
                        }
                        type="button"
                      >
                        Trace
                      </button>
                    </div>
                    <time className="text-[11px] text-stone-400">
                      {formatMemoryDate(memory.updatedAt)}
                    </time>
                  </div>
                )}
              </div>
            )}
            {traceId === memory.id ? (
              <MemoryTrace memoryId={memory.id} />
            ) : null}
          </li>
        ))}
      </ul>

      {totalPages > 0 ? (
        <nav
          aria-label="Memory pagination"
          className="flex items-center justify-between gap-3 text-sm text-stone-500"
        >
          <button
            className="rounded-xl border border-stone-200 bg-white px-4 py-2 font-medium text-stone-600 transition hover:bg-stone-50 disabled:opacity-50"
            disabled={page === 0 || loading}
            onClick={() => {
              setTraceId(null);
              setPage((current) => current - 1);
            }}
            type="button"
          >
            Previous
          </button>
          <span>
            Page {page + 1} of {totalPages}
          </span>
          <button
            className="rounded-xl border border-stone-200 bg-white px-4 py-2 font-medium text-stone-600 transition hover:bg-stone-50 disabled:opacity-50"
            disabled={page + 1 >= totalPages || loading}
            onClick={() => {
              setTraceId(null);
              setPage((current) => current + 1);
            }}
            type="button"
          >
            Next
          </button>
        </nav>
      ) : null}
    </div>
  );
}
