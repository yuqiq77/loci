"use client";

import { useEffect, useState } from "react";

import { LociIcon } from "@/components/loci-icon";
import type { SessionSummary } from "@/shared/types";

const MENU_WIDTH = 144; // matches w-36
const MENU_HEIGHT = 128; // approximate rendered height of the three-item menu

function formatSessionDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
  }).format(date);
}

export function SessionList({
  sessions,
  selectedId,
  onSelect,
  onCreate,
  onRename,
  onArchive,
  onDelete,
}: {
  sessions: SessionSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: (session: SessionSummary) => void;
  onArchive: (session: SessionSummary) => void;
  onDelete: (session: SessionSummary) => void;
}) {
  const [openMenu, setOpenMenu] = useState<{
    id: string;
    top: number;
    left: number;
  } | null>(null);
  const [showTopFade, setShowTopFade] = useState(false);

  useEffect(() => {
    function closeMenu(event: PointerEvent) {
      if (!(event.target as Element).closest("[data-session-menu]")) {
        setOpenMenu(null);
      }
    }

    function closeMenuWithEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpenMenu(null);
      }
    }

    document.addEventListener("pointerdown", closeMenu);
    document.addEventListener("keydown", closeMenuWithEscape);
    return () => {
      document.removeEventListener("pointerdown", closeMenu);
      document.removeEventListener("keydown", closeMenuWithEscape);
    };
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col" id="session-navigation">
      <div className="mb-5 flex items-center gap-2.5 px-2">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-stone-900 shadow-md">
          <LociIcon filled className="size-[18px] text-white" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-stone-900">
            Loci
          </p>
          <p className="text-[11px] text-stone-400 md:text-[10px]">
            v0.2.1
          </p>
        </div>
      </div>

      <button
        className="mb-5 flex w-full items-center justify-center gap-2 rounded-full bg-stone-900 px-4 py-3 text-sm font-medium text-white shadow-sm transition hover:bg-stone-800 active:scale-[0.99]"
        onClick={onCreate}
        type="button"
      >
        <svg
          aria-hidden="true"
          className="size-4"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="2"
          viewBox="0 0 24 24"
        >
          <path d="M12 5v14M5 12h14" />
        </svg>
        <span>New chat</span>
      </button>

      <div className="relative min-h-0 flex-1">
        <ul
          className="h-full space-y-1 overflow-y-auto md:-mr-3 md:pr-1"
          data-thin-scroll
          onScroll={(event) => {
            setShowTopFade(event.currentTarget.scrollTop > 2);
            setOpenMenu(null);
          }}
        >
        {sessions.map((session) => {
          const active = session.id === selectedId;
          const menuOpen = session.id === openMenu?.id;
          const sessionDate = formatSessionDate(session.createdAt);

          return (
            <li data-session-id={session.id} key={session.id}>
              <div
                className={`group relative flex min-w-0 items-center gap-2 rounded-xl border px-3 py-2.5 transition-colors ${
                  active
                    ? "border-transparent bg-stone-200 text-stone-950"
                    : "border-transparent text-stone-600 hover:bg-stone-200/50 hover:text-stone-900"
                }`}
              >
                <button
                  aria-current={active ? "true" : undefined}
                  className="min-w-0 flex-1 text-left"
                  onClick={() => {
                    setOpenMenu(null);
                    onSelect(session.id);
                  }}
                  title={session.title}
                  type="button"
                >
                  <span className="block truncate text-sm font-medium md:text-[13px]">
                    {session.title}
                  </span>
                  {sessionDate ? (
                    <span className="mt-0.5 block text-xs text-stone-400 md:text-[11px]">
                      {sessionDate}
                    </span>
                  ) : null}
                </button>

                <div className="relative shrink-0" data-session-menu>
                  <button
                    aria-expanded={menuOpen}
                    aria-haspopup="menu"
                    aria-label={`Conversation actions for ${session.title}`}
                    className={`flex size-7 items-center justify-center rounded-lg text-stone-400 transition hover:bg-stone-200 hover:text-stone-700 md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100 ${
                      menuOpen ? "bg-stone-200 text-stone-700 md:opacity-100" : ""
                    }`}
                    onClick={(event) => {
                      const rect =
                        event.currentTarget.getBoundingClientRect();
                      setOpenMenu((current) => {
                        if (current?.id === session.id) {
                          return null;
                        }
                        const overflowsBottom =
                          rect.bottom + 4 + MENU_HEIGHT > window.innerHeight;
                        return {
                          id: session.id,
                          top: overflowsBottom
                            ? rect.top - MENU_HEIGHT - 4
                            : rect.bottom + 4,
                          left: rect.right - MENU_WIDTH,
                        };
                      });
                    }}
                    type="button"
                  >
                    <svg
                      aria-hidden="true"
                      className="size-4"
                      fill="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <circle cx="12" cy="5" r="1.6" />
                      <circle cx="12" cy="12" r="1.6" />
                      <circle cx="12" cy="19" r="1.6" />
                    </svg>
                  </button>

                  {menuOpen && openMenu ? (
                    <div
                      aria-label={`Actions for ${session.title}`}
                      className="fixed z-30 w-36 rounded-xl border border-stone-200 bg-white p-1.5 text-xs text-stone-700 shadow-lg"
                      role="menu"
                      style={{ top: openMenu.top, left: openMenu.left }}
                    >
                      <button
                        className="w-full rounded-lg px-3 py-2 text-left hover:bg-stone-100"
                        onClick={() => {
                          setOpenMenu(null);
                          onRename(session);
                        }}
                        role="menuitem"
                        type="button"
                      >
                        Rename
                      </button>
                      <button
                        className="w-full rounded-lg px-3 py-2 text-left hover:bg-stone-100"
                        onClick={() => {
                          setOpenMenu(null);
                          onArchive(session);
                        }}
                        role="menuitem"
                        type="button"
                      >
                        Archive
                      </button>
                      <button
                        className="w-full rounded-lg px-3 py-2 text-left text-red-700 hover:bg-red-50"
                        onClick={() => {
                          setOpenMenu(null);
                          onDelete(session);
                        }}
                        role="menuitem"
                        type="button"
                      >
                        Delete
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
            </li>
          );
        })}
        {sessions.length === 0 ? (
          <li className="px-3 py-2 text-sm text-stone-400">
            No conversations yet.
          </li>
        ) : null}
        </ul>
        <div
          aria-hidden="true"
          className={`pointer-events-none absolute inset-x-0 top-0 z-20 h-9 transition-opacity duration-200 md:-mr-3 ${
            showTopFade ? "opacity-100" : "opacity-0"
          }`}
          data-session-top-fade
        />
      </div>
    </div>
  );
}
