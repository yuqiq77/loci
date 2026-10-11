# Content-Discipline Evals: Replay Instead of Waiting for Another Example

## Problem

Long-lived AI memory can be fluent and structurally valid while remembering
the wrong thing. A writer may turn a day into a chronological log, spend most
of its space on a side topic, lose an older theme during a rewrite, or imitate
the wording of an example embedded in its prompt.

Live use discovers these failures, but it is a poor regression suite. Each
observation depends on the calendar, current database state, a provider call,
and a human comparing versions. Prompt iteration needs the same evidence to be
replayable before a change reaches the live writer.

## Constraints

- Evaluation covers content selection and preservation, not scheduling,
  trigger geometry, or queue behavior.
- Source material and model output may be private. The published corpus must
  be synthetic while preserving the real fixture schemas.
- Historical model output cannot be regenerated exactly; retained versions
  may also be pruned.
- Prompt examples cannot count as held-out evidence.
- Provider generation and judging are nondeterministic and may cost money;
  the default regression run must require neither.
- A green suite must not depend on weakening thresholds after seeing a new
  failure.

## Evidence

Manual review exposed distinct failure classes that a scalar quality score
would hide: chronological narration, starvation of the labeled center,
unpaid withholding, quiet-day inflation, example anchoring, section loss, and
loss of specifically labeled details.

Two instrument failures shaped the design. First, a section-similarity score
could pass even when the sentence carrying that section's meaning vanished.
Second, a requested model arm could terminate at its output cap and fall
through to another candidate; without provenance, the fallback output looked
like the requested arm. The harness therefore keeps named checks alongside
the exact generation path.

## Decision

Store four artifacts separately: write-once sources, compact labels, frozen
candidate output, and the evaluator. A manifest binds them without requiring
the candidate to be regenerated.

```text
sources + labels ── frozen candidate ── deterministic checks
       │
       └────────── optional generation ── checks + optional judges
```

Fixtures support three writer shapes:

- **Journal (one day's entry):** a closed-day source window, its pinned starting baseline, the
  day's center and topics, plain-delta markers, forbidden example phrases,
  quiet-day status, and an optional later opening.
- **Narrative:** the prior record, source watermark, bounded source window,
  token budget, stable sections, and key phrases expected to survive.
- **Extraction:** already-paired exchanges, exact writer windows, and a short
  expected-coverage list for prompt and window-geometry comparisons.

Every fixture is explicitly `held-out` or `prompt-example`. The capture tool
has no default for this field. Prompt-example cases remain valuable as
calibration: a known-bad candidate must keep producing its pinned flags, and a
compliant reference should clear them. They do not demonstrate
generalization.

Mechanical checks run first. They are named after observable failures rather
than combined into one score. Journal checks cover chronicle structure, local
mass around the center, withholding without a plain delta, inflation, and
prompt anchoring. Narrative checks compare both section stability and labeled
detail retention, then detect journal-like dated form. Extraction checks compare
coverage while preserving the writer's pairing and window rules.

The optional behavioral evaluation uses two response arms for the same later
opening: one receives the stored journal entry and one does not. A versioned
judge asks whether the first response uses the recorded change in a way the
second could not. If no opening was pinned before evaluation, the runner
refuses the differential instead of inventing one around the candidate.

Generation is also opt-in. Reports record the requested and actual model path,
prompt arm, output cap, and finish reason. Output that ends at the provider cap
is recorded as a terminated experiment, not scored as a complete candidate.
Replay may grant extra generation headroom, but reports show both the replay
cap and the live writer's cap; production behavior is unchanged.

Fixture capture uses exclusive-write semantics. A correction creates a new
artifact or explicit schema version rather than rewriting the evidence. The
public repository carries separately authored synthetic fixtures; the same
format can be used locally with private sources.

## Alternatives rejected

- **Judge live runs by eye:** valuable for discovery, too sparse and stateful
  for regression protection.
- **One quality score:** hides which behavior changed and permits unrelated
  failures to trade against each other.
- **Treat examples as held-out:** measures imitation, not generalization.
- **Upload the private corpus:** unnecessary; the runner and judges operate
  locally, and public fixtures are synthetic.
- **Tune until everything passes:** an expected-flag case is successful when
  it continues to flag.

## Invariants

- Frozen candidates are evaluable without network access.
- Sources include their baseline and never depend on a prunable live version.
- Contamination class is explicit and machine-readable.
- Held-out and prompt-example evidence are never combined.
- Known-bad candidates retain their expected flags.
- Optional provider calls identify the path that actually produced output.
- Missing behavioral probes disable the differential.
- Evaluation code does not alter live prompts or writer jobs.

## Verification

The deterministic runner is `npm run eval:content`. Evaluator contracts and
calibration cases are exercised by
[`tests/unit/content-discipline-evals.test.ts`](../../tests/unit/content-discipline-evals.test.ts).
The implementation lives in
[`src/server/evals/content-discipline.ts`](../../src/server/evals/content-discipline.ts),
with the runner in
[`scripts/content-discipline-eval.ts`](../../scripts/content-discipline-eval.ts)
and write-once capture in
[`scripts/content-discipline-capture.ts`](../../scripts/content-discipline-capture.ts).

Tests cover detector calibration, explicit contamination, pinned baselines,
judge-result consistency, refusal of incomplete replay states, and extraction
window geometry. The manifest run compares frozen candidates with their
expected flags. Provider-backed generation and judging are never prerequisites
for deterministic verification.

An example comparison, frozen outputs, and reproduction commands are recorded
in [Synthetic Examples in the Extraction Prompt](extraction-synthetic-examples.md).

## Known limits

- Mechanical checks are failure detectors, not complete semantic judges.
- Synthetic public fixtures demonstrate the instrument, not production
  generalization.
- Model-judged results remain nondeterministic and are supporting evidence.
- Replay does not validate scheduling, trigger timing, or job interactions;
  those still require integration tests and live observation.
- A new failure class needs a new labeled fixture and calibration argument.
