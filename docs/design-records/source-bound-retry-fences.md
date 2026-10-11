# Source-Bound Retry Fences: A Retry Budget Belongs to the Work, Not the Row

## Problem

Background writers keep the assistant's continuity current: a recent
snapshot, the long-horizon record, the daily journal, memory extraction, a
session title. A periodic tick rediscovers unfinished work by predicate —
"the snapshot is older than its sources", "yesterday has material and no
entry" — and enqueues a job for it. The queue bounds one job row to three
attempts.

Those two facts compose badly. A deterministic failure leaves the predicate
true, so after the row fails the tick inserts a fresh row whose attempt count
starts at zero. Every row is bounded; the work is not. The failure was first
seen as an old snapshot refresh that ended on the provider's output cap on
every call: 190 failed rows and 570 provider attempts over two days, ending
only when the process stopped, with roughly two million billed tokens and no
conversation to show for them. Raising the output cap fixed that instance and
left the multiplier in place.

Two neighbouring defects surfaced with it: seven hand-sized output caps that
had each truncated legitimate output (reasoning shares the output budget,
dense scripts run near one token per character), and failures that left no
evidence — a skipped extraction window completed its row with the error
cleared, and two windows of material were lost without a trace.

## Constraints

- The queue is PostgreSQL rows claimed by a single worker; there is no ledger
  of provider requests, and one job may chain several calls (a primary
  candidate, a fallback candidate, a shorten retry, a review step).
- A global spend breaker would need accounting the system does not have;
  the fix must remove the observed unbounded multiplier without building a
  quota platform.
- The host is a laptop that sleeps. A timer-based timeout can fire after a
  suspend and resume and look exactly like a provider timeout.
- Manual actions — rebuild the record, write one day's entry — must keep
  working whatever the automatic path has decided.
- Owner-scale queue: no new job status, no failure-ledger table, no hashed
  identifiers that hide what they are made of.

## Evidence

The incident rows carried the same source high-water marks on every row and
the same `finish_reason` on every attempt: the work was identical, only the
row identity was new. Queue order is not completion order either — a retried
extraction landed a minute after the record that should have included it, so
"enqueued earlier" is no barrier.

A fallback that succeeded after a candidate hit the cap looked like the
requested model's output unless provenance was recorded. And once a fence
exists, a mis-charged attempt no longer means "wait one more cycle" but
"this source is blocked until something changes".

## Decision

Give every automatic job a **readable source key** derived from the actual
source high-water marks — never from enqueue time — and make the retry budget
belong to that key.

```text
snapshot      snapshot version | newest message cursor | summary cursor set | newest memory update | p<policy>
record        record version/watermark | newest qualifying message | newest memory update | p<policy>
journal entry date | p<policy>
```

- **A terminal failed row is the fence.** Automatic enqueue deduplicates
  against `failed` rows with the same key, not only pending and running
  ones, so the existing row keeps its attempt count and error across ticks
  and restarts. No new status, no ledger table.
- **Evidence or policy re-arms.** New source marks make a new key with a
  fresh budget. A `policyVersion` component changes when a retry-policy
  input changes — the output cap, the backoff table, a prompt fix — so
  sources fenced under the old policy re-arm without deleting history.
- **Manual paths carry no key.** Authority is the enqueue path: manual work
  neither consults nor deletes a fence. No re-arm tokens.
- **Request-terminal output failures.** One shared, generous output cap
  (32,000 tokens) replaces the seven hand-sized caps; editorial length lives
  in prompts and trimmers, never in the cap. A request that ends on the cap,
  or completes empty or unparseable, is terminal for that request on that
  candidate and is never resent unchanged; a structured record — reason,
  finish reason, stage, model, cap, usage, a bounded excerpt — lands in the
  row's error field, as diagnostic text only.
- **Candidate chains inside one attempt.** An exhausted (stage, model,
  endpoint) triple is recorded on the row *before* the next candidate is
  called, so a process exit mid-fallback cannot re-run the terminated
  request; later attempts skip exhausted pairs; the row fails only when no
  candidate remains retryable. A failed primary followed by a successful
  fallback is a successful job.
- **Transient failures** keep three bounded attempts with slow backoff: the
  first call, then one minute, then ten minutes; exhaustion fences the
  source like any failure.
- **Suspected host suspension is refunded.** A timed call whose wall clock
  outran its own timer by 1.5× or more is read as a process pause: the
  attempt is handed back uncharged, nothing is marked exhausted, no cursor
  advances. A heuristic accepted knowingly — under a fence the lenient error
  is the cheap one.
- **Extraction keeps its skip-on-final-failure policy** (the consolidation
  barrier must not wait forever), but the row reads `failed` with the old
  and new cursor in its record: a skipped window is visible.
- **Failures leave evidence.** Termination records, exhausted lists, one log
  line per failed attempt, and a diagnostics view that decodes them.

## Alternatives rejected

- **Raise the output cap and move on:** fixed the instance, not the
  invariant that let it multiply.
- **A global token or cost breaker:** no per-request ledger exists, and one
  job spans several calls; it would be a quota platform, not a fix.
- **A failure-ledger table or a new job status:** the failed row already is
  the record; a second record would drift from it.
- **Hashed source keys:** at this scale opacity buys nothing, and a readable
  key is its own debugging surface and test assertion.
- **Adaptive retry at a doubled cap:** writers do not run at temperature
  zero and newer models take no temperature at all; resending the same
  request has too low an expected value to justify a second bill.
- **Classifying unknown programming errors as terminal:** kept the bounded
  three attempts instead — more conservative until a class of them appears.

## Invariants

- One source key has one bounded retry budget, however many rows the tick
  creates for it.
- A failed automatic row with a live key blocks automatic re-enqueue of that
  key; it never blocks manual work or any other source.
- Changed source evidence or a changed policy version always re-arms.
- A request that terminated on a candidate is never resent unchanged within
  the same job.
- Exhausted candidates are persisted before the next candidate is called.
- A job fails only when no candidate remains retryable.
- A suspected suspension costs no attempt and records no exhaustion.
- Every failure leaves a bounded, structured record; no window is skipped
  silently.
- An output cap is a runaway guard, never an editorial target.

## Verification

The fence and chain live in
[`src/server/db/jobs.ts`](../../src/server/db/jobs.ts),
[`src/server/jobs/source-keys.ts`](../../src/server/jobs/source-keys.ts),
[`src/server/jobs/worker.ts`](../../src/server/jobs/worker.ts),
[`src/server/chat/suspension.ts`](../../src/server/chat/suspension.ts), and
[`src/server/summaries/compression.ts`](../../src/server/summaries/compression.ts).

[`tests/integration/jobs-fence.test.ts`](../../tests/integration/jobs-fence.test.ts)
drives the real tick and worker against a disposable database: an output-cap
failure followed by ten ticks, a client reconnect, and stale-lease recovery
yields one failed row and one or two model calls in total; new material
admits exactly one new key while the failed row stays; timeouts take three
calls at the observed backoff and then fence; a legacy row without a key and
a policy bump do not fence; manual jobs complete past a fence; a failed
review leaves the record and its open thread untouched; repeated suspected
suspensions never charge an attempt.
[`tests/unit/diary.test.ts`](../../tests/unit/diary.test.ts) pins the chain
semantics, [`tests/unit/compression.test.ts`](../../tests/unit/compression.test.ts)
the termination record, and
[`tests/integration/jobs-summary.test.ts`](../../tests/integration/jobs-summary.test.ts)
the writers outside the fence. In live operation after the change, a month
of retained automatic jobs completed with no failed rows; the diagnostics
view's fence strip is where that is read.


## Known limits

- No account-level spend ceiling: a multi-day provider outage under heavy
  use is bounded per source, not in total.
- The fence lookup reads the key from JSON without an index, and the tick
  recomputes keys every minute while a source is fenced; both are measured
  before being optimized.
- One policy version serves the three fenced writers; a per-writer prompt
  fix re-arms all three.
- Suspension detection is clock arithmetic only; there is no sleep/wake
  integration.
- The error field is bounded, so a second candidate's record can be cut.
- Unknown error classes still receive three attempts.
- The daily journal's manual re-arm is an API route without a control in the
  interface.
