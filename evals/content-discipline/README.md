# Content-discipline replay evals

This suite freezes representative inputs and expected detector outcomes for
three memory-writing paths: the daily entry, the layered narrative record, and
extracted memory items. It measures whether a code or prompt change preserves
known content behavior; it does not grade general model quality.

## Method

Each fixture keeps three roles separate:

- `sources.json` is the exact input the writer or its replay consumes, with
  the baseline record pinned as it stood at the window start.
- `labels.json` is a small human-authored statement of what should matter:
  the day's center, topic markers, the plain-delta and threshold markers, the
  prompt phrases an entry must not echo, and detector thresholds.
- the candidate file is the output the deterministic checks inspect.

`manifest.json` is the only fixture index. It names every candidate, pins the
expected hard flags and advisories, and may pin source geometry (turn count,
session count, audited extraction windows). The test suite and the runner
discover fixtures through the manifest; adding a fixture never adds a path
literal to test code.

Fixtures declare their contamination class. A `held-out` fixture was not used
as a prompt example and may test generalization; a `prompt-example` fixture
may calibrate a detector but cannot establish generalization. Baselines and
source turns live in the fixture, so a replay never consults mutable live
state.

Expected flags are regression expectations, not aspirations. The suite passes
when actual results equal the pinned results, including for a deliberately
bad candidate. An expectation changes only after the candidate and labels
have been reviewed; a threshold is never loosened to turn a new result green.

## The synthetic set

The data is invented, and it is invented as a memory test rather than as
filler: every day carries at least one thing a memory system can get wrong in
a specific way. Nothing here corresponds to a real person, production, or
conversation.

**Scenario.** Mara is a lighting designer at the Kesselhaus, a small theatre in
Vienna, in the week *Die Möwe* opens. The hazer (a fog machine called Gertrud)
dies two days before the premiere. The director, Bela, wants to cut the fog;
she says no to him in a room for the first time. Ferdi owes her money. She is
nine days off cigarettes and smokes one. Her sister Lotte is in Hamburg, the
cat Herr Brösel needs a sitter, and the premiere moves by a day when the lead
loses his voice. The register is English with the German words she would
actually use (Probe, Nebel, Generalprobe).

**What each fixture tests.**

- `diary/2031-03-12` (held-out, two sessions, 18 turns). The clean stored
  entry. Its memory hooks: a confession she tried to withhold and then paid
  for ("the number is one, not zero"), a debt with a number (40 euro), and a
  line she drew that the next day will test. The pinned next-day opening is
  Bela's morning text, so the differential judge has a real probe.
- `diary/2031-03-13` (prompt-example, 12 turns). Two facts change inside the
  day: the premiere moves from Friday to Saturday, and Ferdi's 40 euro becomes
  20 paid, 20 open. A stated boundary is refined rather than reversed: the
  nickname is fine one-on-one, not in front of the ensemble, and she insists
  that is not a change of mind. The stored entry is the known-bad calibration
  case: a one-paragraph clock-order chronicle (`chronicle`), the center
  starved (`center-starvation`), and a withholding at the door with no plain
  delta paid (`threshold-stop`, hard). `reference.md` is the clean entry for
  the same sources and labels and pays the delta by naming what was kept.
- `diary/2031-03-16` (held-out, quiet day, 4 turns). Two lines of source. The
  stored entry inflates the day and echoes a prompt-example phrase
  (`quiet-day-inflation`, `prompt-anchor-reuse`, both hard); `reference.md`
  is the two-sentence entry a quiet day earns.
- `narrative/v3` (v3 → v4, incremental). The prior record is the one every
  journal day above pins as its baseline. `stored.md` carries Recent forward and
  extends it, and returns Earlier and Long-term verbatim: the clean case.
  `generated-recent-replacement.md` rewrites Recent from the new sources
  alone and loses the labeled phrases from the prior Recent
  (`key-phrase-retention`). `generated-layer-loss.md` keeps Recent but returns
  Earlier as an empty heading and no Long-term (`section-stability`).
- `extraction/nebel` (session 2, 11 exchanges, two audited windows). Window 1
  wrote four rows on the evening of the 12th; window 2, the day the facts
  changed, wrote nothing. `stored.json` is what production kept: it still
  says 40 euro and knows nothing about Saturday, so the coverage check fails
  on exactly the items that changed (`expected-coverage`). `complete.json`
  covers all six and passes. The narrative fixture's `memories` are the four
  rows window 1 wrote, so the clean v4 has to recover Saturday and the twenty
  euro from the raw tail, which is the situation the layers exist for.

**Prompt phrases.** `forbiddenPromptPhrases` are lines a prompt example
written from the 13th would carry. They are placeholders until the journal
prompt in this repository carries examples of its own; when it does, derive
the list from those examples and re-check the held-out days.

## Commands

The deterministic suite compares every manifest candidate with its pinned
flags and exits non-zero on any mismatch:

```sh
npm run eval:content
```

Inspect one candidate and write a report:

```sh
npm run eval:content -- diary diary/2031-03-13 \
  --candidate evals/content-discipline/fixtures/diary/2031-03-13/stored.md
```

`--generate`, `--judge`, and `--content-judge` call the providers configured
in the local environment. They are opt-in investigation tools and never run
in CI. Generated output is written to a report, reviewed, and added to the
manifest only when it becomes a deliberate regression case.

## Capturing your own fixtures

The capture command writes new snapshots with exclusive-create semantics and
refuses to replace an existing directory:

```sh
npm run eval:content:capture -- diary YYYY-MM-DD held-out|prompt-example output-dir
npm run eval:content:capture -- narrative PRIOR_VERSION CANDIDATE_VERSION WATERMARK SOURCE_THROUGH output-dir
npm run eval:content:capture -- extraction SESSION_ID output-dir
```

Captured material contains your own conversations. Keep it local, label its
contamination class explicitly, write the smallest label set that states what
mattered, and do not publish a fixture merely because the suite passes on it.
