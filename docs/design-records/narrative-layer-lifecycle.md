# Narrative Layer Lifecycle: Resolution Changes With Age

## Problem

An always-present memory record must preserve continuity across years while
fitting inside a fixed context budget on every turn. Appending forever makes
the record unbounded. Rewriting without a lifecycle is also unsafe: a model can
replace the recent layer with the newest day, compress an old theme out of
existence, or let generated structure teach the same loss on the next run.

The task is not to keep every episode in one document. It is to preserve the
right resolution at each time horizon while raw history and atomic memories
retain recoverable detail.

## Constraints

- The record shares one capsule budget with a recent cross-session snapshot
  and the current thread summary.
- Identity-bearing sections must not lose space merely because episodic prose
  grew.
- The write path is model-generated, but section order, budgets, source
  windows, and commits must be deterministic.
- Automatic rewriting must not skip material that arrives during a model call.
- Owner edits are authoritative and must not be overwritten by an in-flight
  generation.
- Raw history and typed memories remain the source evidence; the generated
  record is a projection, not a new source corpus.

## Evidence

Early versions treated graduation as work performed on every fold. The result
behaved like a conveyor: the newest day became Recent, the former Recent moved
to Earlier, and Earlier residue reached Long-term whether or not the material
had aged. Once stored, that shape became the next generation's example, so the
record re-taught the conveyor to itself.

After graduation was keyed to age, Earlier and Long-term became stable on most
runs. A second failure remained: under a saturated budget, the writer could
replace the entire Recent layer with only the newest window. The older layers
looked preserved while a contiguous recent stretch disappeared.

Budget incidents exposed a separate invariant. When the writer and capsule
used different token counters, a document accepted at write time could be cut
again on every read. A higher cap moved the cut; it did not repair the
accounting disagreement. Once the counters agreed, a second lesson followed:
one number serving as both the prompt's figure and the enforced cap left the
writer no margin. Measured against each provider's own counter, writers land
between about 1.0× and 1.5× of a stated figure in the shared unit, depending
on their tokenizer.

## Decision

The record has durable Profile, Principles, and Approach sections plus one
Narrative section with exactly three horizons in this order:

```text
### Recent       specific texture from roughly the last weeks
### Earlier      arcs and turning points from the preceding months
### Long-term    identity-level throughlines across the full history
```

New material is woven into Recent. Existing Recent is carried forward and
thinned in place. Material graduates only after it outgrows that horizon:
Recent to Earlier after weeks, Earlier to Long-term after months. Graduation
reduces resolution; it never means moving a whole layer on every run. Durable
facts and stances promote into Profile or Principles. Superseded facts replace
their old form rather than accumulating beside it.

The layer order is structural. Both write-time and read-time emergency trims
cut the Narrative from the end, so the oldest, lowest-resolution material pays
first. Profile, Principles, and Approach together are asked to stay within
roughly one third of the narrative target.

Every budget is counted in one local unit, and each of the three capsule
writers — this record, the recent snapshot, the thread summary — is held to two
numbers: the target its prompt states and a write cap above it. The cap
absorbs the writer's tokenizer bias instead of a per-model conversion:

```text
narrative target               an owner setting; the record's normal size
narrative write cap            target × 1.5
snapshot / summary write cap   their targets × 2
capsule read limit             ≥ the three write caps + the capsule's fixed text
```

Settings refuse a read limit below that sum, so a write within its cap always
renders in full; raising the read limit adds margin and changes nothing else,
because assembly counts the capsule's actual text. Generation asks the writer
for the target. Between the target and the cap nothing mechanical happens;
past the cap, one structure-preserving shorten retry asks for the target
again, and only what still exceeds the cap meets the section-aware hard
trim.

Each automatic rewrite fixes a source-through instant before reading. A
successful transaction writes the new version and advances the watermark to
that instant; a failed call advances neither. An optimistic version guard makes
an owner edit that lands during generation win. Automatic, full rebuild, and
owner-authored versions are labeled separately and the recent version window
is retained for comparison.

## Alternatives rejected

- **Append new prose forever:** preserves detail briefly but makes every chat
  pay an unbounded context cost.
- **Graduate on every fold:** turns semantic horizons into queue mechanics and
  creates the self-teaching conveyor.
- **Replace Recent with the newest window:** loses a contiguous stretch while
  leaving the document superficially well-formed.
- **Protect every old sentence:** makes the oldest prose crowd out current
  identity and state; raw evidence already provides recovery.
- **Blind character or token trimming:** can amputate headings or an entire
  layer and conceal the loss inside a valid-looking document.
- **Let the generated record source itself:** compounds paraphrase and shape
  errors; only source evidence may introduce facts.

## Invariants

- Narrative contains exactly Recent, Earlier, and Long-term, newest to oldest.
- Age, not fold count, controls graduation.
- Recent is carried forward; no rewrite may drop an unlabeled stretch of time.
- Loss under pressure is lower resolution before missing chronology.
- Durable sections stay lean so the narrative layers own most of the budget.
- The stored version and its read path share one accounting domain, and the
  read limit is validated against every write cap rather than trusted.
- A generation commits its record and source watermark atomically.
- An owner edit cannot be overwritten by an older in-flight generation.
- Generated prose never becomes silent source evidence for its own rewrite.

## Verification

Pure tests pin section discovery, oldest-last trimming, the write caps and
the read-limit rule (across the settings ranges, every section at its cap
renders untrimmed at the required limit and one token less is refused), the
shorten retry past the cap, and the hard-trim fallback. Prompt tests pin the three
headings, their order, age-triggered movement, Recent carry-forward, and the
ban on a missing stretch of time.

Database tests cover source-window selection, fixed watermarks, optimistic
version writes, retention, owner-edit precedence, and the separation between
incremental and rebuild provenance. The content-discipline suite compares a
prior and candidate record for section stability and labeled phrase retention,
including a known-bad Recent replacement and a known-bad layer loss.

## Known limits

The current incremental writer still asks a model to carry every layer in its
output. The invariants are explicit and replay-tested, but preservation is not
yet mechanical: a structurally valid generation can still omit material that
was not separately labeled. A future revision should have the model emit only
the new delta and let deterministic assembly carry unchanged layers; with
mechanical assembly, an over-cap write is refused rather than trimmed.

The three horizons are prose conventions rather than typed records. They do
not by themselves resolve contradictory claims, expose evidence per sentence,
or answer graph-shaped questions. Those concerns belong to the typed memory
layer described in the roadmap.
