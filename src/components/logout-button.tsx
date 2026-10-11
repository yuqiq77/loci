"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function LogoutButton({
  sidebar = false,
}: {
  sidebar?: boolean;
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  async function logout() {
    setSubmitting(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      router.replace("/login");
      router.refresh();
    }
  }

  return (
    <button
      className={
        sidebar
          ? "flex w-full items-center gap-3 rounded-xl px-3.5 py-3 text-left text-sm font-semibold text-stone-500 transition hover:bg-red-50/50 hover:text-red-600 disabled:opacity-60 md:text-[13px]"
          : "rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-medium disabled:opacity-60"
      }
      disabled={submitting}
      onClick={logout}
      type="button"
    >
      {sidebar ? (
        <svg
          aria-hidden="true"
          className="size-4 shrink-0"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.8"
          viewBox="0 0 24 24"
        >
          <path d="M10 17l5-5-5-5M15 12H3M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
        </svg>
      ) : null}
      <span>{submitting ? "Signing out..." : "Sign out"}</span>
    </button>
  );
}
