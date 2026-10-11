# Design Decisions

This page collects decisions that shaped loci beyond individual features. It
records the constraint and reasoning, including reversals, so a reader can
distinguish deliberate boundaries from missing work.

## A day begins at 04:00

**Decision.** Journal entries use the server-local half-open window
`[04:00, next 04:00)`.

**Why.** Calendar midnight often divides one human episode into two records.
An early-morning boundary keeps the late evening and the hours after midnight
together. Day attribution happens in application code so it does not depend on
the database container's timezone.

## The daily journal is append-only

**Decision.** A closed day can create at most one entry. There is no automatic
edit or delete path, and a concurrent duplicate loses to the existing row.

**Why.** A generated day record is evidence of what the writer retained at
that time. Silent regeneration would replace that evidence with a later model's
interpretation. Completeness is preferred over machine trimming because the
record is not injected into every chat request.

## Edit, delete, and regenerate are one design problem

**Decision.** Automatic edit, delete, and regeneration of journal entries are
deferred together.

**Why.** Each operation changes the constitution of an append-only record and
requires the same answers: who can authorize it, what provenance survives,
what readers see during replacement, and how recovery works. Shipping only the
easy-looking operation would decide those questions accidentally.

## Non-goals are active constraints

**Decision.** The base system is single-user and single-host. It does not add
multi-tenancy, distributed services, an external queue, a graph database, or an
open-ended autonomous loop.

**Why.** These are not claims that the features are universally undesirable.
They protect a small, inspectable system until observed load or a concrete
workflow earns more machinery. A scope review is required whenever a mechanism
change makes an old non-goal newly cheap or newly necessary.

## Reversals keep their reasoning

**Decision.** When evidence overturns a design, the record preserves both the
original rationale and the reason for reversal.

**Why.** A bare latest-state document teaches neither the constraint that led
to the first choice nor the evidence that invalidated it. Keeping the chain
prevents a later refactor from “rediscovering” the rejected design without its
failure mode. Examples include replacing fold-count graduation with age-based
graduation and removing machine cuts from the daily writer while retaining a
hard budget for always-in-context narrative text.

## Retry budget belongs to logical work

**Decision.** Automatic continuity jobs derive a source identity from their
input high-water marks and a retry-policy version. A terminal failure fences
that identity until new evidence, a policy change, or an explicit owner action
re-arms it.

**Why.** A per-row attempt limit is not a retry limit if a periodic tick can
create a fresh row for the same poisoned source forever. The unit being
budgeted is the logical transformation, not a queue record. Readable source
keys and retained terminal evidence make the fence inspectable.

## One accounting domain per budget

**Decision.** A stored artifact and the read path that admits it use one token
accounting domain. Provider-reported usage remains billing and diagnostic data,
not a second enforcement ruler for the same budget.

**Why.** Two counters can disagree substantially on the same multilingual
text. A write that is legal under one counter may then be cut during assembly
under another—or the writer may discard content that the reader had room for.
Consistency matters more than the apparent precision of a remote count.

## Graph-shaped data stays in ordinary tables

**Decision.** Entities, claims, assertions, threads, evidence, and their edges
are modeled as normal PostgreSQL tables. A graph store may exist later only as
a rebuildable projection.

**Why.** The required operations are indexed adjacency reads, versioned
assertions, provenance joins, and lifecycle transitions. PostgreSQL already
provides the transactions, constraints, migrations, backup path, and debugging
tools these operations need. A second authoritative store would add failure
modes before it added necessary capability.

## Known-bad evals are expected to fail by name

**Decision.** Frozen candidates carry exact expected failure flags. A
known-bad candidate passes the regression suite only when it continues to
trigger those flags; its compliant reference is expected to clear them.

**Why.** Optimizing for an all-green set of candidates would erase the
calibration evidence. Named flags keep distinct failures—such as chronological
narration, section loss, or prompt anchoring—from trading against one aggregate
score. Prompt examples are marked separately and never presented as held-out
generalization evidence.

## Every turn reaches the narrative through some writer

**Decision.** The session summary keeps thread state only; durable facts and
preferences belong to extraction (`boundary_fact`), which runs the revised
prompt under the writer identity frame. The narrative's raw tail reads
every turn since its watermark that no summary covers, each session capped at
the summary trigger; a rebuild caps its whole tail at the same figure. What a
cap drops is logged and written onto the completed job, where the diagnostics
page shows it.

**Why.** The summary omits durable material because it is "stored
separately", and the narrative excludes summarized turns from its raw tail. A
fixed raw cap, older than the settings, then dropped the oldest uncovered
turns of any long day, and the earlier extraction prompt told the model to
prefer zero items — so a preference stated in a long session could reach no
writer at all. Tying the cap to the trigger makes coverage a property of the
settings rather than of day length; the extraction revision is what backs the
summary's "stored separately". The total an incremental run reads is bounded
by use, not by a constant. If it ever outgrows a prompt, the intended shape is
a cap on each chunk with a consolidation per chunk folded once — never a cap
on how much is read, and never a silent drop.

## The chat window seats a whole unsummarized history

**Decision.** Settings refuse a context budget that, after the reply, the
tool-loop reserve, the system prompt, and a full capsule, cannot hold the
summary trigger plus the anchor budget. The shipped trio is 96k context, 48k
recent, 72k trigger; the earlier 32k/16k/20k failed the rule.

**Why.** History is selected newest-first into whatever the window leaves,
and anchors only into what history leaves. When the window is smaller than
the trigger, the oldest unsummarized turns leave the request before any
summary covers them, and retrieval is starved in every long session. The rule
was a design note since the capsule budget grew; it now fails where the
numbers are set. A small trigger-to-recent gap also rewrote the cached summary
every few thousand tokens.

## Writers share one voice floor

**Decision.** The four writers whose text is read back inside a system
prompt — the session summary, the recent snapshot, extraction, and the
narrative — refer to the person by name when the sources give one, with the
pronouns the sources establish, otherwise with a neutral reference ("they" in
English, an explicit neutral singular form in Chinese) and never a pronoun guessed from the name;
never "you", "user", or "assistant", in any language. The first three follow
the dominant language of their sources; the narrative carries its record's
language forward. Background records do not name the assistant: Profile and
Principles leave it out and state a stance as the person's own. The wording
lives once, in `src/server/summaries/writer-voice.ts`. The daily journal is
not assembled into the prompt and keeps its own wording.

**Why.** All of this text is read again inside a system prompt that already
uses "you" for the assistant, so a writer without the rule (the snapshot had
none) could make "you" mean both parties. The naming convention was reversed:
it named the assistant in third-person sections to keep them objective and
help the model recognize itself, but it relied on a system prompt that
assigns a name. Neither the default system prompt nor the writers' identity
frame does, so the rule pointed at nothing and models filled in a name of
their own. The neutral reference names its form per language because replay
showed both failure modes: told only "they", a Chinese summary wrote the
plural form; told only "no gendered pronoun", a Chinese snapshot dropped the
subject and attributed the person's first-person statement to the assistant.
