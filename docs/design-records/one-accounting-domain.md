# One Accounting Domain: Every Budget in One Unit, Margins Instead of Conversions

## Problem

Several budgets govern what the assistant carries into every request: the
per-turn capsule that seats the long-horizon record, the recent snapshot, and
the thread summary; the targets the record, snapshot, and summary writers are asked to hit; the
cap on a manually edited record. For a while they were enforced in two units.
Writers counted with the provider's token counter when it was available and
fell back to a local estimator when it was not; per-turn assembly always used
the estimator. For the English record the estimator weighed about 1.3× the
provider's count.

Both directions of that gap were live failures. When the counter was
unavailable, a target set in provider tokens was enforced in estimator units:
the shorten retry and the end-trimmer cut whole layers out of the record to
fit a budget nobody had set. When the counter worked, a record written to its
provider-token target was about 1.3× larger in estimator units than the
capsule allowed, so assembly trimmed the oldest layer on every turn. For more
than a week the chat never saw the long-horizon layer at all, while the stored
document looked complete. The promise that a stored record always renders in
full had held only while both sides shared a unit.

## Constraints

- Providers and model generations tokenize differently. Measured against
  each provider's own counter on frozen English records, the estimator reads
  1.00× on the newest Claude generation, 1.34× on the previous one, and
  1.51× on DeepSeek; dense scripts shift the ratios again.
- The writer model estimates length loosely in any unit; a precise
  conversion would be precision the process does not have.
- Provider counting requires a separate network round trip and is unavailable
  through relays. One transient error made the fallback sticky for the rest
  of a run.
- The capsule's three sections share one limit, so no section can be judged
  against the whole.
- Settings are validated in the browser and on the server; the manual edit
  path must obey the same rule as the writers.
- The cached prompt prefix must stay byte-stable; a budget change may not
  churn what is sent.

## Evidence

The write-side failure was one console line — "token count failed; using
estimator" — followed by a run that both retried and hard-trimmed. The
read-side failure was a simulation with the production assembler: records of
about 6,900 estimated tokens against a capsule of 6,500 rendered with the
oldest layer's 2,000 characters reduced to none, heading included.

The manual edit cap compared the record alone against the whole capsule and
ignored the two sections that share it, so a reported "83 tokens of margin"
was measured against the wrong number. A derived write target that floored at
half the capsule could promise a size the reader could not keep: capsule
2,000 and snapshot 400 derived a legal 1,000-token record that assembled to
2,042 and was trimmed.

A length hint in the prompt, calibrated on one generation's tokenizer, would
have made the next generation's writer aim about a quarter short. The
measurements were taken before the design was changed.

## Decision

**One unit everywhere.** The local estimator — one token per dense-script
character, one per three other characters, rounded up — counts for the
writers, the manual save, the settings rule, and per-turn assembly. Provider
counts leave the enforcement path entirely; they remain billing and
diagnostic data.

**An independent target, a cap above it, a validated read limit.**

```text
record target          an owner setting (default 6400); the figure every prompt states
record write cap       target × 1.5      (covers the previous generation's 1.39 maximum)
snapshot / summary cap target × 2        (written by DeepSeek at 1.44–1.58)
capsule read limit     ≥ record cap + snapshot cap + summary cap + chrome
```

- The record's target is its own setting, no longer derived from the
  capsule; raising the capsule adds margin and changes nothing that is sent,
  because assembly counts the capsule's actual text.
- Between a writer's target and its cap nothing mechanical happens — the
  next run's prompt simply states the target again. Past the cap, one
  structure-preserving shorten retry asks for the target; the hard trim cuts
  only what still exceeds the cap.
- The settings refuse a capsule below the sum, naming the numbers; the
  chrome term is computed from the capsule's real layout rather than a
  constant, so it cannot drift from the assembler. An existing deployment's
  capsule is raised to at least the required sum by migration.
- Prompts state their targets as set; no per-generation factor. Tokenizer
  bias is absorbed by the margins, not converted.
- Every successful background call logs the provider's billed input and
  output tokens beside the stored text's estimated size. Adaptive thinking
  bills as output, so this line is also how a writer's model choice is
  judged. It is recorded, never enforced.

Calibrating a measured ratio per provider at each boundary — billed divided
by estimated, from live turns, within a band — is deferred behind this
change; the ruler stays fixed.

## Alternatives rejected

- **Provider counting with an estimator fallback:** the unit changed
  mid-run after one error, and relays never counted at all.
- **Per-model conversion factors in prompts:** calibrated on one tokenizer,
  wrong for the next, and finer than the writer's own sense of length.
- **A target derived from the capsule with a half-capsule floor:** two
  numbers coupled the wrong way; a legal write could still be trimmed.
- **Trim at read time until anything fits:** silent amputation of the
  oldest layer on every turn.
- **Raise the capsule and move on:** moves the cut; the units still
  disagree.
- **One number as both prompt figure and enforced cap:** no margin, so the
  retry fires on ordinary output.

## Invariants

- Every continuity budget is counted in one unit; no enforcement path uses a
  provider count.
- Each capsule writer — record, snapshot, summary — has a stated target and
  a cap above it; mechanical correction
  fires only past the cap.
- The read limit is validated against the sum of the write caps plus chrome;
  a write within its cap renders untrimmed.
- Raising the read limit never changes the assembled text.
- Prompts state the target as set; no per-generation factor exists.
- Usage is logged per call in the provider's unit beside the estimate —
  recorded, never enforced.
- The manual edit path obeys the same cap as the writer.

## Verification

The arithmetic lives in one client-safe module,
[`src/server/summaries/narrative-budget.ts`](../../src/server/summaries/narrative-budget.ts);
the estimator in
[`src/server/chat/context.ts`](../../src/server/chat/context.ts); the
settings rule in
[`src/server/settings/schema.ts`](../../src/server/settings/schema.ts); the
usage line in
[`src/server/summaries/compression.ts`](../../src/server/summaries/compression.ts).

[`tests/unit/token-budget.test.ts`](../../tests/unit/token-budget.test.ts)
pins that the writers count with the capsule estimator and nothing else and
that trimming stops exactly at the budget.
[`tests/unit/settings-schema.test.ts`](../../tests/unit/settings-schema.test.ts)
pins the refusal of a capsule that cannot seat every section at its write
cap and the target's independence from the capsule.
[`tests/unit/chat-context.test.ts`](../../tests/unit/chat-context.test.ts)
pins the estimator's weights and the capsule assembly;
[`tests/unit/consolidate-narrative.test.ts`](../../tests/unit/consolidate-narrative.test.ts)
pins the target the prompt states and the retry past the cap;
[`tests/unit/compression.test.ts`](../../tests/unit/compression.test.ts)
pins the usage line. Database tests in
[`tests/integration/narrative.test.ts`](../../tests/integration/narrative.test.ts)
and
[`tests/integration/settings.test.ts`](../../tests/integration/settings.test.ts)
cover the write path and the settings round trip; the content-discipline
suite keeps frozen records of the write-time amputation and the read-time
trim as regression cases.

The ratios were measured on twelve frozen records against the official
counter and DeepSeek's published offline tokenizer before the margins were
chosen.

## Known limits

- The margins cover the measured generations; a tokenizer much heavier than
  1.5× for the record or 2× for the snapshot and summary would trip retries on
  ordinary output.
- Dense scripts are where the estimator is least accurate — it undercounts
  the Claude generations and overcounts DeepSeek — and that gap lands on the
  chat context, the summary trigger, the memory and tool budgets, and the
  extraction span rather than on the record; it is calibrated per boundary
  later, not by this change.
- The caps and ratios are initial values to be re-read against the usage
  lines.
- The usage line is per call; there is no cross-call ledger.
- The record writer still carries every layer in its output; mechanical
  layer carry — the model writes only the delta — is the next step, and
  until then a structurally valid write within its cap can still omit
  unlabeled material.
