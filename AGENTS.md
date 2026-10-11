# AGENTS.md — working agreement

Read this first. This file is the one set of rules for every agent (Claude,
Codex, …) working in this repository; tool-specific notes live in that
tool's own file and must not restate these.

## Working agreement

Follow the user's intent:
- For questions, design discussions, and reviews, provide analysis and
  recommendations. Change files only when requested.
- For implementation and fix requests, carry the work through relevant
  investigation, implementation, validation, and documentation. No separate
  mode-switch confirmation is needed.

Resolve routine, reversible implementation choices using repository context.
Ask when missing information materially changes product behavior, scope, or
data handling. Continue independent work while awaiting an answer.

Complete the requested outcome before handing back. Report what changed,
what was actually verified (the commands and their real results), and any
remaining blockers. Do not treat a first implementation or a list of
suggested test steps as completion.

## Orientation

- `README.md` — what the system is, how it is verified, how it is deployed.
- `docs/architecture.md` — the implemented boundaries, data, and request
  flows.
- `docs/design-decisions.md` — decisions and reversals with their reasoning.
- `docs/design-records/` — focused engineering records: problem,
  constraints, evidence, decision, alternatives, invariants, verification,
  known limits.
- `docs/specs/engineering-principles.md` — method, anchors, lessons.
- `ROADMAP.md` — direction, not commitments.

Two sources of truth, kept distinct:
- **Design intent**: the latest adopted decision (a design record or
  decision entry).
- **Current implementation**: the code and a reproducible verification.
When they disagree, record the inconsistency where you found it and resolve
it; never let a record stand in for actual behavior.

## Recording (change-driven, not per round)

Update the docs that a change invalidates in the same change — the
architecture document for a boundary or data change, a design record for a
decision that changes, the README for a command or behavior it describes. A
discussion that changes no state produces no routine record.

## Project constraints (each one was learned the hard way)

- **Test databases are disposable and explicit.** The app runs a real job
  worker, and in e2e the mock provider serves embeddings: worker jobs write
  into whatever database the server sees and no cleanup undoes it
  (`playwright.config.ts` refuses to run without `TEST_DATABASE_URL`).
  Integration and e2e runs need `TEST_DATABASE_URL` pointing at a throwaway
  database. Never claim a test run was safe by default.
- **Do not disturb a running dev server.** Next.js holds a per-directory
  dev lock and :3000; run e2e from a copied worktree on another port, or
  ask.
- **Prompt changes to the background writers are design changes.** The
  content-discipline suite freezes their behavior; a prompt change ships
  with its replay evidence, and a threshold is never loosened to make a new
  result pass.
- **Verification is reported as run**: name the command, the database it
  ran against, and the actual counts; if something was skipped, say so.

## Code changes

- Keep changes surgical: every changed line traces to the request; match
  existing style; remove only what your change orphaned; mention unrelated
  dead code rather than deleting it.
- Prefer the simplest form that does the job; no abstractions for
  single-use code, no speculative configurability. Special cases layered on
  shared infrastructure signal a fix at the wrong depth.
- Turn tasks into verifiable goals (a reproducing test before a fix). The
  method behind this is in `docs/specs/engineering-principles.md`.
