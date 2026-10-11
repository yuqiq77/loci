"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

import { forgetLastSession } from "@/shared/last-session";

export function LoginForm() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSubmitting(true);

    const formData = new FormData(event.currentTarget);
    const password = String(formData.get("password") ?? "");

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });

      if (!response.ok) {
        setError("Unable to sign in. Check the password and try again.");
        return;
      }

      // A fresh sign-in always lands on the blank new-chat state.
      forgetLastSession();
      router.replace("/");
      router.refresh();
    } catch {
      setError("Unable to sign in. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="space-y-5" onSubmit={handleSubmit}>
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <label className="text-xs font-medium text-stone-600" htmlFor="password">
            Password
          </label>
        </div>

        <div
          className={`relative flex items-center rounded-2xl border bg-white/50 transition-all duration-300 focus-within:ring-2 ${
            error
              ? "border-red-400 focus-within:ring-red-200"
              : "border-stone-200 focus-within:border-stone-400 focus-within:ring-stone-100"
          }`}
          data-login-password-field
        >
          <svg
            aria-hidden="true"
            className="ml-4 h-4 w-4 shrink-0 text-stone-400"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            viewBox="0 0 24 24"
          >
            <rect height="11" rx="2" ry="2" width="18" x="3" y="11" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>

          <input
            autoComplete="current-password"
            autoFocus
            className="w-full border-0 bg-transparent py-3.5 pl-3 pr-11 font-mono text-sm text-stone-800 outline-none placeholder:text-stone-300"
            data-login-password-input
            disabled={submitting}
            id="password"
            name="password"
            onChange={() => {
              if (error) {
                setError("");
              }
            }}
            placeholder="········"
            required
            type={showPassword ? "text" : "password"}
          />

          <button
            aria-label={showPassword ? "Hide password" : "Show password"}
            className="absolute right-3.5 rounded-lg p-1 text-stone-400 transition hover:text-stone-600 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={submitting}
            onClick={() => setShowPassword((visible) => !visible)}
            type="button"
          >
            {showPassword ? (
              <svg
                aria-hidden="true"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                viewBox="0 0 24 24"
              >
                <path d="m2 2 20 20" />
                <path d="M10.58 10.58a2 2 0 0 0 2.84 2.84" />
                <path d="M9.88 4.24A10.78 10.78 0 0 1 12 4c7 0 10 8 10 8a13.16 13.16 0 0 1-1.67 2.68" />
                <path d="M6.61 6.61C3.94 8.4 2 12 2 12s3 8 10 8a10.76 10.76 0 0 0 5.39-1.61" />
              </svg>
            ) : (
              <svg
                aria-hidden="true"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                viewBox="0 0 24 24"
              >
                <path d="M2 12s3-8 10-8 10 8 10 8-3 8-10 8-10-8-10-8Z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {error ? (
        <div
          className="flex items-center gap-2 rounded-xl border border-red-100 bg-red-50 p-3 text-xs text-red-600"
          role="alert"
        >
          <svg
            aria-hidden="true"
            className="h-4 w-4 shrink-0"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            viewBox="0 0 24 24"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4" />
            <path d="M12 16h.01" />
          </svg>
          <span>{error}</span>
        </div>
      ) : null}

      <button
        className="flex w-full items-center justify-center gap-2 rounded-2xl bg-stone-900 px-4 py-3.5 text-sm font-medium text-white shadow-sm transition-all duration-300 hover:bg-stone-800 disabled:cursor-not-allowed disabled:bg-stone-100 disabled:text-stone-400"
        disabled={submitting}
        type="submit"
      >
        {submitting ? (
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-stone-400 border-t-white" />
        ) : (
          <>
            <span>Sign in</span>
            <svg
              aria-hidden="true"
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              viewBox="0 0 24 24"
            >
              <path d="M5 12h14" />
              <path d="m12 5 7 7-7 7" />
            </svg>
          </>
        )}
      </button>
    </form>
  );
}
