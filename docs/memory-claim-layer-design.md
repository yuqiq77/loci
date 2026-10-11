# Memory Evidence, Claim & Thread Layers — Design Note

| Field | Value |
| --- | --- |
| Date | 2026-08-18 |
| Status | Design draft |
| Accepted decision | Graph-shaped relations live in ordinary PostgreSQL tables; no graph database or graph engine is required by the base architecture. |
| Feeds | [specs/v0.3.0.md](specs/v0.3.0.md) — revises §5 organization layers and constrains §6/§7 implementation |
| Precedent | [memory-capsule-design.md](memory-capsule-design.md) played this role for v0.2.0 |

## 1. Diagnosis: four complaints, one conflation

The current system has four related weaknesses:

1. **Thread lifecycle**: consolidation auto-flips resolved (D16a); there is no
   reopen, snooze, resolution evidence, or state history.
2. **Update/supersede**: manual update overwrites a row in place; superseded-by
   chains exist, but extraction only adds or deduplicates and does not
   systematically represent corrections or changes over time.
3. **Provenance is uneven**: source provenance is a coarse pointer;
   transformation provenance lacks a common run/input shape; usage provenance
   has the strongest existing prototype in memory_injections and
   used_web_search.
4. **Memory rows feel structurally wrong**: boundary facts, shared moments,
   shifts, and open threads have different identities and lifecycles but share
   one content-plus-vector row shape.

The shared root is not merely the absence of a claim table. It is the
conflation of several different things:

- **source evidence** — what the owner actually said and the bounded exchange
  in which it was said;
- **episode or fragment** — a source-grounded but model-written account of what
  happened or mattered;
- **claim** — an assertion the system currently has reason to believe;
- **thread** — an operational object with a lifecycle;
- **retrieval projection** — the searchable, scored representation that may
  fade without changing truth or deleting evidence.

The design must make these separate first-class objects. Claim is one missing
abstraction, not the parent abstraction of all memory.

## 2. Typed memory layers

### 2.1 Source evidence

Owner messages and bounded conversation windows are the evidence of record.
Every extracted object cites exact source references that the server validates
against the extraction window. A model-generated memory row is not equivalent
to an owner-authored source.

Existing memory rows become legacy **memory fragments**: useful derived recall
atoms with a source chain and a lower trust class. A fragment may help locate
or propose a claim, but a claim should ultimately cite the underlying message
or window wherever that evidence still exists.

### 2.2 Episodes and fragments

Episodes represent something that happened or a bounded stretch of shared
experience. They retain occurrence/reference time and exact source refs. Their
prose may carry texture and meaning that should not be forced into triples.

Episodes are append-oriented derived artifacts. A later interpretation may add
another episode or supersede a retrieval projection; it does not rewrite the
owner's original messages.

### 2.3 Claims and assertions

A claim has stable identity; its assertions are append-only versions of what
the system believed about that identity:

~~~text
Claim identity:
  subject entity + canonical predicate/slot + scope/cardinality

Claim assertion:
  object entity or scalar value
  valid_from / valid_to          optional domain valid-time
  recorded_at / retired_at      explicit system/transaction-time
  status                        active | retired | disputed | retracted
  confidence
  evidence refs
~~~

The stable identity is what makes “same fact, new value” representable without
a linked-list traversal. A new assertion can retire or invalidate an old one
while both remain in history under the same claim identity.

Assertion values and source links are immutable. Closing an assertion is a
monotonic lifecycle operation — either an appended assertion-state event or a
single guarded retired-at write — never an in-place rewrite of its value.

Claims cover durable facts, preferences, constraints, and typed relations.
They do not absorb episodes or open threads merely because those objects also
contain language that sounds propositional.

### 2.4 Threads and lifecycle events

An open thread is a distinct operational object: a question, promise,
commitment, or unfinished matter that later conversation may resume.

Its state is derived from one append-only transition stream:

~~~text
thread_events(
  thread_id,
  transition,            created | snoozed | resolved | reopened | dropped
  from_state,
  to_state,              open | snoozed | resolved | dropped
  occurred_at,
  actor,                 owner | extraction_run | consolidation_run
  evidence_ref,
  reason_code
)
~~~

The current thread status may be materialized for cheap reads, but the event
stream is authoritative. Any compatibility write to memories.resolved must be
transactional with the event append while dual-write exists.

### 2.5 Retrieval projections and kinds

The current kinds conflate retrieval policy, semantic type, and lifecycle. The
new mapping is:

| Current kind | New home | Remaining retrieval behavior |
| --- | --- | --- |
| boundary_fact | claim/assertion, often a constraint predicate | low miss tolerance / boundary policy |
| shared_moment | episode or source-grounded fragment | cue-gated episodic recall |
| shift | event plus optional claim transition | recency and change-aware ranking |
| open_thread | thread plus thread events | unresolved/due eligibility |

Kind may remain temporarily as a legacy retrieval-policy tag. Semantic type
belongs to the claim predicate, episode category, or thread type; lifecycle
belongs to assertions and thread events.

### 2.6 Temporal discipline

Transaction-time is not implicit. Claim assertions explicitly store when the
system recorded and retired them; thread state comes from its explicit event
stream. This makes point-in-time belief/debug queries possible without relying
on mutable current rows.

Valid-time is added only where the domain supports it. A fictional project
status scheduled to change on November 1 has a future valid-from; an undated
preference may not. An episode instead has occurrence/reference time. Missing
temporal precision must remain unknown rather than being invented by the
extractor.

## 3. Claim identity is a write-time responsibility

Cosine similarity cannot decide “same claim, new value.” The repository's
existing calibration shows why: rephrasings and legitimately distinct items
occupy adjacent similarity bands, while a changed value often lowers
similarity precisely because the payload changed. Embeddings are a proximity
oracle, not a claim-identity oracle.

The current discourse often contains the strongest correction signal, such
as a correction to a previously stated project deadline. Identity and conflict
resolution belong in the extraction/write pipeline while that context is present. They are not,
however, exact or free. The pipeline must:

1. Resolve bounded entity and canonical-predicate candidates.
2. Load active assertions for the relevant subject/predicate slots.
3. Ask the extractor to propose one of ADD, CONFIRM, CORRECT, SUPERSEDE,
   DISPUTE, or NOOP with exact source refs.
4. Server-validate source refs, target identity, predicate/cardinality rules,
   and expected assertion version.
5. Commit the new assertion, evidence links, and retirement/invalidation of an
   old assertion atomically.

CORRECT and SUPERSEDE are distinct. A correction says the old assertion should
not have been believed; a supersede says it may have been true until a later
change. The extractor may propose the distinction, but uncertain cases remain
disputed or await owner curation rather than receiving invented valid-time.

Entity resolution and predicate resolution are the two principal quality
risks. Start with a small curated entity vocabulary and a small canonical
predicate registry with explicit cardinality. Aliases, merge/split, and owner
curation are required governance surfaces, not cleanup to add after graph
growth.

## 4. Provenance architecture

Keep the three-layer vocabulary, with a different granularity rule for claims
and synthesized prose.

### 4.1 Source provenance

- Introduce normalized, typed source refs rather than adding a growing set of
  provenance columns only to legacy memory rows.
- Extraction inputs record their window boundaries.
- Each fragment, episode, claim assertion, and thread transition cites exact
  supporting or contradicting source refs.
- The server verifies that model-emitted refs belong to the authorized input
  window and assigns the source type/trust class.
- Derived fragments retain their own source chain but do not silently acquire
  the trust class of the underlying owner message.

### 4.2 Transformation provenance

Every extraction or synthesis run records provider, model, host, prompt
version, source window/watermark, timestamps, outcome, and retry/attempt
identity.

Claims still require per-claim evidence links. Narrative and journal prose use
run-level lineage: sentence-level lineage is neither reliable nor desirable
for a deliberately re-narrated artifact. If a debugging question needs to
estimate which inputs produced one sentence, an offline eval-style judge may
compute that hypothesis without storing it as ground truth.

### 4.3 Usage provenance

memory_injections and used_web_search are healthy prototypes, not a complete
usage layer. Extend the same append-only observability pattern to:

- tool-driven memory/diary/claim retrieval;
- claim and episode candidates considered, selected, or suppressed;
- proactive candidates and sent/no-op decisions;
- source scopes consumed by a final assistant turn, so retrieval echo cannot
  re-enter extraction as fresh evidence.

Usage traces retain IDs, decisions, policy versions, and bounded/redacted
result bodies according to an explicit retention policy.

### 4.4 Retention and owner deletion

Evidence and transformations are append-only under normal system operation;
models never rewrite their own sources. This does not override the owner's
right to forget. Owner-initiated deletion, redaction, or tombstoning remains an
explicit governed path, and derived claims/projections must become ineligible
when their only permitted evidence disappears.

## 5. Storage decision accepted 2026-08-18: graph relations, not a graph database

Graph-shaped relations live in ordinary PostgreSQL tables. The base
architecture requires no second store, graph database, graph query language,
or graph execution extension.

A future graph database may be introduced only as a rebuildable derived
projection behind the typed repository. PostgreSQL remains authoritative for
identity, provenance, temporal validity, lifecycle transitions, and all
mutations.

The useful lessons from reference systems concern shape and pipeline placement:

- **Zep/Graphiti** represents facts as entity edges with explicit system-time,
  valid-time, and episode provenance. Its retrieval combines semantic,
  full-text, and graph-aware signals, and resolves contradictions during
  ingest rather than deleting history.
- **mem0 Graph Memory** stores entity relations beside vector memories and
  returns related graph context alongside vector results. Its current public
  contract does not make the graph a replacement for semantic seed retrieval.

Loci adopts those principles without adopting their storage engines:

1. Seed from vector/full-text/entity/predicate/time cues.
2. Expand through named, bounded one-hop or two-hop repository operations.
3. Filter by validity, state, trust class, and evidence eligibility.
4. Rerank and return bounded snippets plus opaque source refs.

The application uses typed operations rather than arbitrary traversal:

~~~text
expand_from_entities
find_active_claims_as_of
find_supporting_evidence
find_related_open_threads
find_contradictions
~~~

One-hop and two-hop reads may compile to explicit joins behind this repository
boundary. No generic depth-N API is introduced. Claim history uses stable
claim identity plus assertion rows, not a recursive supersede chain.

An optional executor remains possible later. pgGraph 1.0.0 was released as
stable on 2026-07-25 and operates as a derived graph runtime over ordinary
PostgreSQL tables. It is still too new and unmeasured against Loci's small,
temporal, write-sensitive workload to become a base dependency. Because the
authoritative format remains plain tables, benchmarking or adopting it later
does not require a memory-data migration.

Kuzu's upstream repository was archived in October 2025. It remains a useful
caution against binding a decades-horizon personal system to niche graph
infrastructure when ordinary relational storage already expresses the needed
semantics.

## 6. Proposed sequencing

The generic MC-117 loop substrate may proceed independently with its existing
memory-only search tool. It should not wait for the full claim migration.
Provider-neutral result/provenance contracts must remain broad enough for later
scopes.

For the memory model itself:

1. **Unified provenance substrate** — typed source refs, extraction/synthesis
   run records, source-window boundaries, and retention rules.
2. **Entity and predicate identity** — minimal curated registry, aliases,
   cardinality, merge/split governance.
3. **Claim assertion and thread state layers** — claims/assertions/evidence and
   threads/events, with compatibility projections for current rows.
4. **Dual-write extraction plus replay evals** — compare ADD/CONFIRM/CORRECT/
   SUPERSEDE/DISPUTE/NOOP decisions against pinned source windows before the
   new structures affect chat.
5. **Agent-initiated retrieval scopes** — extend the tool executor from memory
   fragments to claims, episodes/diary, entities, and later raw history; keep
   hierarchical snippet → source expansion.
6. **Proactive decision ledger** — reason-bearing candidates and first-class
   sent/no-op decisions using the same source refs and policy-version trace.
7. **Bounded relation queries** — add only when named product questions require
   them; benchmark an optional executor only after plain-table queries become
   a measured problem.

Near-term work should favor normalized structures that survive migration:

- source refs and extraction/synthesis run tables;
- exact source-window and per-output evidence links;
- a thread event stream only together with its authoritative/current-state
  projection invariant;
- scoring/prompt/policy version fields on usage traces.

Avoid adding provenance only as more columns on memories: that would improve a
legacy carrier while making the later claim/episode/thread migration repeat the
same work.

## 7. The recent-context plane: a live failure and the projection re-cut

### 7.1 The snapshot graveyard incident

One snapshot rebuild drew 30 memory inputs, of
which **28 were unresolved open threads** — the "recent continuity"
carrier rendered as a historical graveyard. Code facts, not accidents:

- `recent-snapshot.ts` feeds **all** unresolved threads into every
  snapshot as a deliberately unwindowed standing input (its own comment
  says so).
- The drop mechanism is delegated to resolution flips ("a resolution
  has to reach the prompt or the rewrite has no signal to drop the
  item") — **the snapshot's only forgetting path runs through a thread
  lifecycle that has no temporal truth** (§1). Resolution doesn't move,
  so nothing is ever dropped.
- The generation prompt receives the previous snapshot's full content:
  generation-from-a-pool-that-includes-its-own-prior-output, with no
  per-item freshness evidence. Self-solidification is structural, not a
  tendency.
- The summary trigger is tuned high for compression fidelity and almost
  never fires in dogfooding, so the intended conversational source
  starves and memory rows dominate. One dial was serving two purposes.

The same incident also exposed two execution-plane faults orthogonal to the
content failure above: the old reasoning ceiling truncated generation, and a
terminally failed job left the source watermark unchanged, so the minute tick
created a fresh three-attempt job for the same logical work indefinitely. The
8k ceiling fixed the immediate MC-110/F5-class truncation; [MC-118 source-bound
failure fences](design-records/source-bound-retry-fences.md) owns the
durable source identity, adaptive retry, and cross-tick terminal fence. Neither
change repairs the carrier described here: MC-118 bounds the cost of failure,
while this section removes the self-inheriting content architecture. Future
episode-recap writers require the same fence even after the singleton is gone.

### 7.2 The pattern and invariant

**Generated rolling documents tend to self-solidify; assembled projections
remain inspectable only when membership is recomputable from authoritative
sources.** Assembly alone does not make a carrier correct: a deterministic
query can faithfully preserve a stale lifecycle forever. The stronger
invariant is:

> A derived output must never be an input to its own regeneration, and every
> projection member must be independently eligible from source evidence or
> authoritative current state.

Every healthy carrier in this system is already one of: append-oriented
artifacts (journal, thread events, eval fixtures) or deterministic assembly
(capsule). The one carrier built as regenerate-a-single-document-from-a-pool-
including-itself is the one that rotted. The narrative shares that shape
*deliberately* and carries the full governance apparatus it demands (D20
re-narration discipline, owner revision, the eval harness); a cache deserves
source-addressable components and assembly, not its own governance program.

### 7.3 Recent-context assembly requirements

Conversation-bounded artifacts can be assembled at session start without
feeding a previous generated snapshot into its own replacement. Source refs
retain role boundaries and trust classes; bounded excerpts preserve wording
when the exact exchange matters.

The always-present plane bridges the gap between the narrative and the live
conversation. On-demand retrieval handles additional detail in the volatile
tail. The initial selector is deterministic and reserves capacity for recent
episodes, opening-turn relevance, and active projects or threads. It should
not require an unbounded prefix or a model call at session start.

### 7.4 Proposed re-cut (design direction, feeds v0.3)

The word *snapshot* currently hides four objects with different source units,
freshness rules, and failure semantics. They become explicit:

1. **Conversation compaction** — the existing high-threshold rolling session
   summary. It serves long-conversation continuation only. Its trigger remains
   tuned for compression fidelity and has no scheduling or source role in
   cross-session recent context.
2. **Episode recap** — a new append-oriented, conversation-bounded artifact.
   The source unit is an idle-bounded episode, not a session: one session may
   become active again and produce another episode. Its stable identity
   includes `session_id`, first/last completed-message ids, and policy version.
   Every closed source unit reaches a terminal processing outcome
   (`complete`, `noop`, or `failed`); this does **not** mean every trivial
   episode must spend a model call. MC-118's source-bound failure fence applies
   so an unchanged failed range cannot be rediscovered each minute.

   A completed artifact contains two distinct payloads:

   - a short model-written recap with transformation provenance (§4.2); and
   - server-validated message/span refs for bounded exact excerpts.

   "Raw" means original role-tagged message content selected through those
   refs, never prose rewritten to resemble a quote. Selection may be
   user-heavy under D18 and §2.1, while retaining assistant spans when their
   wording is itself material — for example a promise, recommendation,
   interpretation, or answer the owner later references. Reading excerpts by
   source ref also lets deletion, retraction, and retention eligibility remain
   authoritative.
3. **Active-state projection** — a deterministic, separately budgeted query
   over what is currently alive. After §2.4 lands, eligibility comes from
   thread current state/events and current claim assertions; source records
   render with ids, dates, and state rather than being rewritten into a prose
   blob. Until then, unresolved legacy rows with evidence in roughly 90 days,
   plus a hard cap, are an explicit compatibility filter rather than a truth
   rule. An old but genuinely active item must eventually survive through
   snooze/due/current-state semantics, not by defeating the recency bound.
4. **Session context manifest and assembly** — after the opening owner message
   is available, a deterministic selector pins the exact state records,
   episode-recap ids, and excerpt refs used by that session. Initial policy
   targets roughly 5–10 episodes with separate lanes: newest guaranteed slots,
   opening-turn semantic relevance, and material/active-project or thread
   association; candidates are deduplicated with diversity before unused slots
   fall back to recency. The first implementation uses no selection model.

   The capsule renders an **active-state band** and a
   **recent-conversations band** from that manifest with zero generation. The
   manifest, not a regenerated account document, is the cache boundary:
   byte-stable for later turns in the session, intentionally variable across
   sessions. On-demand MC-117 retrieval remains outside the pinned plane in the
   volatile tail.

The re-cut therefore retires the account-level
`recent_continuity_snapshot` singleton **from the serving contract**, rather
than replacing it with another two-band generated row. Retirement is staged,
not an instruction to delete the current row or drop its table immediately:
build and compare the new artifacts first; after parity, stop its writer and
capsule read path; retain the legacy row read-only for rollback/diagnosis; drop
the table and old budget setting only in a later cleanup migration. The two new
bands meet only in request-time assembly. Episode recaps and manifest assembly
are the first concrete instances of the retrieval-projections layer (§2.5) and
do not wait for claims; the final active-state eligibility contract consumes
thread events and claim assertions (§2.3–2.4).

Interim mitigations independent of the re-cut: MC-109 §3/§4 are
promoted from debt to triage — the 28 threads are largely the 47
diagnosed 2026-07-08, and one report-plus-owner-triage pass clears the
stock; a recency bound + cap on the standing input is an honest
band-aid available if the re-cut waits.

## 8. Memory lifecycle constraints

The typed layers preserve evidence and support explicit correction without
requiring a complete history in the active context.

Truth does not decay merely because time passes. Retrieval salience and active
projections may fade; claims change only through evidence, explicit correction,
supersession, or the end of a stated valid-time. Episodes retain texture without
being forced into atomic facts. The narrative keeps re-telling rather than
accumulating a complete ledger in context.

The graph connects the entities, current assertions, threads, and evidence
needed to answer real continuity questions. It is not a mandate to graph
everything that ever happened. Selective retrieval, cold/archive projections,
bounded provenance bodies, and owner-governed deletion keep forgetting
first-class.

## References

- [Zep: A Temporal Knowledge Graph Architecture for Agent Memory](https://arxiv.org/abs/2501.13956)
- [Graphiti overview](https://help.getzep.com/graphiti/getting-started/overview)
- [mem0 Graph Memory](https://docs.mem0.ai/open-source/features/graph-memory)
- [pgGraph 1.0.0 on PGXN](https://pgxn.org/dist/pggraph/1.0.0/)
- [pgGraph repository](https://github.com/Evokoa/pgGraph)
- [Kuzu archived repository](https://github.com/kuzudb/kuzu)
- In-repo: similarity calibration, MC-114/115 provenance lines,
  memory_injections usage traces, and the MC-117 tool-loop contract.
