# Roadmap

loci is a working snapshot. These are the next architectural directions
that follow from the current system and its observed failure modes.

## Typed memory layers

Move from one overloaded memory row toward explicit source evidence, episodes,
versioned claims, and open threads. A correction should supersede an earlier
assertion without erasing the evidence that made either assertion reasonable.
Time changes confidence and retrieval priority; it does not make a true claim
false. The proposed model is developed in
[`docs/memory-claim-layer-design.md`](docs/memory-claim-layer-design.md).

## Deeper diagnostics

Extend the current `/diagnostics` surface with retrieval dry-runs, score
breakdowns, pinned-memory pressure, and before/after context projections. The
goal is to answer “why did this memory appear?” and “why did that one not
appear?” without running ad-hoc SQL.

## Tool loop phases B and C

Add bounded history search and then grounded memory actions on top of the
existing attempt protocol. Each new tool must define authorization, provenance,
budgets, failure semantics, and whether its output may enter memory. Mutating
tools do not ship until their approval and rollback model is explicit.

## Scheduled autonomous curation

Move continuity maintenance from an idle-process tick toward an explicit
schedule with visible runs and owner controls. The writers stay source-bound,
idempotent, and independently retryable; scheduling must not turn them into an
open-ended agent.

## Per-call cost attribution

Introduce a `model_calls` trace that covers foreground rounds and background
writers with the same provider, model, endpoint, usage, timing, cache, and
outcome fields. Message-level totals and job logs are useful today, but they do
not provide one accounting view across every call.
