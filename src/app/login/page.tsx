import { LociIcon } from "@/components/loci-icon";

import { LoginForm } from "./login-form";

export default function LoginPage() {
  return (
    <main className="relative flex min-h-screen w-full items-center justify-center overflow-hidden bg-surface px-4 py-16">
      <div
        className="absolute left-1/4 top-1/4 -z-10 h-96 w-96 animate-pulse rounded-full bg-amber-100/30 blur-3xl"
        style={{ animationDuration: "10s" }}
      />
      <div
        className="absolute bottom-1/4 right-1/4 -z-10 h-96 w-96 animate-pulse rounded-full bg-stone-200/40 blur-3xl"
        style={{ animationDuration: "14s" }}
      />

      <section className="relative w-full max-w-[420px] overflow-hidden rounded-3xl border border-white/50 bg-white/70 p-8 shadow-[0_24px_48px_rgba(0,0,0,0.04)] backdrop-blur-xl sm:p-10">
        <div className="absolute left-0 top-0 h-[3px] w-full bg-gradient-to-r from-stone-200 via-stone-400 to-stone-200" />

        <div className="flex flex-col items-center text-center">
          <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-2xl bg-stone-900 shadow-md transition-transform duration-200 hover:scale-105">
            <LociIcon filled className="h-5 w-5 text-white" />
          </div>

          <p className="mb-2 text-xs font-medium uppercase tracking-[0.2em] text-stone-500">
            LOCI
          </p>
          <h1 className="mb-2 text-2xl font-semibold tracking-tight text-stone-900">
            Private access
          </h1>
          <p className="mb-8 max-w-[280px] text-sm text-stone-500">
            Enter the owner password to unlock private workspace.
          </p>
        </div>

        <LoginForm />

        <p className="mt-8 text-center font-mono text-[11px] text-stone-400">
          Secured server-side session · v0.2.1
        </p>
      </section>
    </main>
  );
}
