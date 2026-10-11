# Loci — Engineering Principles

| Field | Value |
| --- | --- |
| Status | Living document (durable; no dated status here) |
| Origin | Distilled from the v0.2.1 session handoff (2026-07-13) and the incidents since; the dated halves of that handoff now live in `docs/STATUS.md` and the tickets |

## How decisions get made here

1. **Dogfood → mechanism → minimal fix → record → verify next cycle.**
   Diagnose the mechanism, never patch the symptom. The owner reads real
   version diffs and job logs; findings arrive as concrete artifacts.
2. **Verify before asserting; re-run claims.** A claim first asserted from
   construction is checked, and honest correction of one's own earlier claim
   is part of the method. Verification the owner reports is re-run, not
   trusted.
3. **Each class of problem has one home.** Frequency lives in triggers;
   content discipline lives in prompts; identity lives in the call frame;
   structure lives in sources. Fixing frequency with prompt wording fails
   quietly.
4. **Prompts are executed operationally.** Models follow do-instructions
   over is-definitions; documents teach their own shape (a record carrying
   day-residue re-teaches the conveyor on every rewrite), so a one-time
   reshape is part of a prompt fix. Stating the *why* inside an instruction
   improves compliance. When an instruction should inform judgment rather
   than trigger behavior, write it as an is-statement, not a do-statement.
5. **Owner reversals are recorded with their reasoning.** Both the original
   idea and the correction live in the decision ledger.
6. **Preserve the adopted memory constraints.** Narrative detail may
   decrease with age; factual claims remain grounded in evidence. The daily
   journal is append-only. Time supplies context, while explicit scheduling
   rules determine execution. Changes to these constraints require a reasoned
   design decision.
7. **Simplicity first, surgical changes.** No abstractions for single-use
   code; special cases layered on shared infrastructure signal a fix at the
   wrong depth. Reviews pass on the actual repo (a `/code-review high` plus
   the owner's own pass); fixes fold into the feature commit.

## Failure-mode lessons (each earned by an incident)

- **Thresholds come from the real distribution.** A gate above the
  observable ceiling never fires (STRONG_REPEAT 0.85, NEAR_DUPLICATE 0.95
  both did this). Measure first; the calibration SQL is in the decision
  ledger's neighborhood (see handoff §7 history).
- **A `max_tokens` cap is a runaway guard, not an editorial target.**
  Seven per-writer caps were each sized for the expected text and each
  truncated legitimate output (reasoning shares `max_tokens`, CJK runs 1–2
  tokens a character, rich windows overshoot). One shared generous cap;
  editorial length lives in prompts and post-generation count/trim.
- **Re-sending an unchanged failed request has too little expected value
  to pay for** — no determinism argument needed.
- **Queue order is not completion order** once retries have backoff. Use
  data cursors as barriers, never the jobs table.
- **Per-row retry budget × tick rediscovery is unbounded.** Failure
  identity must be bound to the source (readable `sourceKey`; a terminal
  failed row is the fence). New evidence, a policy version, or an owner
  action re-arms; nothing else.
- **Failures must leave evidence.** A skipped window with no trace, a
  `complete` row that hides a loss, a generic error string — each cost a
  day of data. Model-output failures carry a bounded excerpt into
  `last_error`; skipped windows record old → new cursor.
- **Derived output never feeds its own regeneration.** Generative rolling
  documents self-calcify; assembled projections do not (the snapshot
  graveyard incident).
- **Capture fixtures the day you think of them.** Narrative versions are
  retained 7 deep / 5 days; model output is not reconstructible.
- **A guard written before the knowledge exists becomes a wall when the
  knowledge arrives.** When a ticket changes what information the model
  receives, grep the standing instructions that constrain that surface.
- **Owner edits are the provenance of record.** A misunderstanding the
  owner deleted will resurface from replay fixtures; never rescue text from
  replay output.
- **Do not bolt provenance columns onto legacy rows.** Window bounds live
  on run records (design-note anti-pattern).
- **Re-read Out-of-Scope when a mechanism changes its cost.** A mis-charged
  sleep timeout used to cost one retry; under a fence it blocks a source for
  good — so the heuristic came back in scope.

## Consolidation-model behavior catalogue (dogfooded)

- Overshoots the asked budget ~1.5× at low temperature; the shorten-retry
  recovers it. A hard trim firing is the layer-amputation signature — check
  the job log's `shortenRetried` before blaming the trimmer.
- Conveyor tendency under daily cadence (recent = yesterday, invented
  "earlier still", day residue reaching long-term): root cause was
  fold-keyed graduation wording plus the record teaching its own shape;
  graduation is keyed to age now.
- Long-term is the thinnest-evidence layer: fragile in rebuild, stable
  under incremental carry-forward.
- Bare single-message calls read as a clerk summarizing someone else's
  transcript and flatten register; the offline writers pass
  `WRITER_IDENTITY_FRAME`.
- Judge-shaped tasks deliberate in prose and self-revise (prose plus two
  fenced JSON blocks, the last one real); parsers take the last parseable
  block, prompts end with the format rule.
- Token accounting differs per endpoint (~1.7× on the same CJK prompt);
  never compare token numbers across accounting domains. When billing
  jumps with zero client change, suspect the provider side first.

## Operating rules

- One clock: server-local time is the only authority (day windows in Node,
  never the Postgres container's UTC).
- Working agreement, recording rules, and repository constraints live in
  `AGENTS.md` (single copy; not restated here).
