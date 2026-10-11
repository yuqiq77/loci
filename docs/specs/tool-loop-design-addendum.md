# Loci Tool Loop Design Addendum

| Field | Value |
| --- | --- |
| Status | Design draft |
| Date | 2026-07-27 |
| Scope | Bounded tool-loop control flow, continuity retrieval, memory actions, scheduled autonomous memory curation, provenance, persistence, and UI outcomes |
| Relates to | [`v0.2.0.md`](v0.2.0.md) §3/§5/§6, [`v0.2.0-memory-context-addendum.md`](v0.2.0-memory-context-addendum.md) §8, [`engineering-principles.md`](engineering-principles.md) §5, the private journal ticket (not in this snapshot), [`design-records/tool-loop-attempt-semantics.md`](../design-records/tool-loop-attempt-semantics.md), the private tail-rewrite ticket (not in this snapshot) |
| Feeds | A future tool-loop implementation ticket; the journal/memory unified-search backlog item; a future autonomous-curation experiment |

## 1. Why this addendum exists

The frozen v0.2.0 specification already defines the essential tool boundary:

- a fixed allowlist;
- an owner-controlled server-side capability gate;
- a bounded
  `model -> tool_use -> execute -> tool_result -> continue` loop;
- `search_memory` as the first internal tool;
- tool results treated as untrusted data;
- no open-ended autonomous agent loop.

Those decisions stand. This note does not reopen the frozen release or replace
the continuity architecture.

The missing design detail is that not every tool should return a value and
immediately continue model generation. Some tools read, some mutate, some pause
for the owner, some render a typed UI result, and some enqueue work whose
lifetime exceeds the HTTP request. Treating all of them as one control-flow
shape would make the first read-only tool easy but force later capabilities
through the wrong abstraction.

This addendum also extends the existing journal/memory unified-search direction:
raw conversation history is the immutable source of truth and should be
searchable on demand. Memory, Phases, and raw history are different resolutions
of continuity, not competing stores.

## 2. Verified current baseline

As of this note:

- The generic application-executed tool loop is specified but not implemented or
  ticketed.
- `web_search` is already available as a provider-hosted server tool behind the
  shipped `web_search_enabled` server-boundary gate. The provider executes it
  inside one stream; it does not use a Loci client tool loop.
- `tools_enabled`, provider-neutral `tool_use` / `tool_result` blocks, and
  `search_memory` have not landed.
- `messages.content` and the provider-neutral `ModelMessage.content` remain
  text-shaped. The content-block reshape planned for tools and image input has
  not landed.
- The journal/memory unified retrieval tool is an unticketed backlog item. Phases
  is intentionally retrieval-only on the machine-facing path and does not enter
  the capsule or feed narrative consolidation.
- Raw message history remains immutable source data. Long-horizon narrative,
  recent snapshot, session summary, recent turns, and retrieved anchors retain
  their existing request-time roles.
- Web-derived assistant turns are excluded from memory extraction and
  continuity synthesis under D18. A generic tool loop must preserve and
  generalize that provenance boundary.
- MC-116A defines the current generation invariant: failed or cancelled
  attempts retract their database message pair; only successful exchanges
  remain in durable chat history.

`get_user_time`, named in the original tool allowlist as a safe first tool,
should be dropped from the first allowlist rather than re-evaluated later. The
chat path already injects server-local time as framed ambient context, and
MC-111 established the server clock as the sole time authority; under the
one-clock decision a second time surface has no remaining justification.
Re-add it only if some future behavior genuinely requires a live round-trip.

## 3. Tool calls have more than one control-flow outcome

The runtime should classify a tool separately from its JSON input schema.
At minimum, it must represent these behaviors:

| Class | Typical behavior | After execution |
| --- | --- | --- |
| Read | Search memory/history, read a source, fetch local time | Return bounded data to the model and continue |
| Mutate | Remember, correct, or forget owner-confirmed state | Stage or commit an idempotent mutation, then continue |
| Yield | Ask for a choice, clarification, or approval | Persist/render the request and end the current turn |
| Present | Show a file, structured comparison, or interactive result | Render a typed content block; continuation is tool-specific |
| Enqueue | Start an explicitly approved long-running job | Return a job reference and end or continue as declared |
| Terminal | End a workflow with no further model call | Close the current execution deliberately |

A provider-neutral outcome can be shaped conceptually as:

```ts
type ToolOutcome =
  | { kind: "continue"; result: ToolResult }
  | { kind: "yield"; block: UiBlock }
  | { kind: "present"; block: ContentBlock; continue: boolean }
  | { kind: "queued"; jobId: string; continue: boolean }
  | { kind: "terminal" };
```

This is application orchestration state, not provider-specific wire format.
Provider adapters translate between their native content blocks and the local
types.

The first implementation may ship only `continue`, but the discriminator should
exist before a UI-yielding tool lands. Otherwise an elicitation tool will be
implemented as a fake tool result followed by an unnecessary second model call.

## 4. Tool definitions are behavioral contracts

A tool is more than `name + description + JSON schema`. Its registry entry
should declare:

- **effect**: read, internal write, external write, destructive;
- **gate**: which owner setting and environment/provider condition enables it;
- **trust class**: local authoritative, owner data, retrieved memory, external
  untrusted;
- **outcome class**: continue, yield, present, enqueue, terminal;
- **visibility**: silent internal action, transient status, durable content
  block, owner approval;
- **result budget**: maximum rows/characters/tokens returned to the model;
- **persistence eligibility**: whether the result may feed any continuity
  carrier;
- **failure policy**: recoverable tool result, hard generation failure, or
  owner-visible retry;
- **idempotency policy** for mutations.

Selection guidance ("when to use", "when not to use", and prerequisites) belongs
with the tool definition or tool pack rather than accumulating indefinitely in
the core system prompt.

## 5. Continuity retrieval: three resolutions, one source chain

The existing always-on and automatic retrieval path remains:

```text
long-horizon narrative       long-term continuity
recent continuity snapshot   recent cross-session state
session summary              current-thread state
recent turns                 local raw context
automatic anchors            cheap query-relevant details
current user message         volatile input
```

Tools add deliberate, model-initiated retrieval when this assembled context is
insufficient. They do not replace the capsule, snapshot, or automatic anchors;
requiring a tool round for ordinary continuity would add latency and make
continuity depend on model initiative.

The on-demand search surface should distinguish:

| Scope | Question it answers | Typical result |
| --- | --- | --- |
| Memory rows | What endured as a durable boundary, moment, shift, or open thread? | Small self-contained atoms |
| Phases | What characterized a particular day or period? | Whole dated journal entries (amended 2026-09-12, MC-122: read by date, not excerpted) |
| Raw conversations | What was actually said, and where? | Session/message snippets with exact provenance |

This division lets the memory system forget selectively without making forgotten
detail irrecoverable. Raw history remains the evidence layer from which a
specific past exchange can be reconstructed.

### 5.1 Proposed retrieval surface

The exact public names remain a ticket-time decision. The desired semantics are:

```text
search_context(
  query,
  scopes = ["memory"],
  before?,
  after?,
  limit?
) -> short ranked snippets + opaque source references

read_context_source(
  source_ref,
  before_count?,
  after_count?
) -> one bounded source or conversation span

list_recent_sessions(
  before?,
  after?,
  limit?
) -> chronological orientation without a semantic query
```

The first ticket can preserve the frozen spec's `search_memory` name and
executor, then expand to a scoped tool after the provider loop is stable.
Alternatively, the journal/memory backlog item can become `search_context` from
the start. The choice should be made against real model tool-selection behavior,
not naming preference alone.

**Settled 2026-09-12 ([roadmap](../../ROADMAP.md)):**
per-source verbs — `search_memory` (MC-117B), `search_transcript`,
`read_context_source`, `read_diary` — with one opaque `continue` contract
for the two read tools; no scoped `search_context`. `list_recent_sessions`
stays deferred: `read_diary` with no arguments returns the entry-date list.

Search should be hierarchical:

1. Return snippets and stable references, not full documents or whole sessions.
2. Let the model expand only the source that appears relevant.
3. Bound expansion around a message or journal entry.
4. Keep every search/expand result in the volatile tool tail.

This reduces both prompt load and the risk of surfacing unrelated private
history.

### 5.2 Retrieval implementation boundaries

- Reuse the existing pgvector path for memory rows. (Phases: struck
  2026-09-12, MC-122 — entries are read whole by date.)
- Raw-conversation search: literal substring match over `messages` in
  PostgreSQL, date-bounded, no index (MC-122, 2026-09-12; the upgrade
  triggers — too slow → index, paraphrases missed → embeddings/hybrid — are
  recorded there). Do not create a second source-of-truth store.
- Search tools must be read-only: no recall-count update unless the product
  deliberately wants tool reads to affect decay. The safer first behavior is no
  decay mutation, matching retrieval dry-run semantics.
- Results must carry source type, source ID, session ID when applicable, and
  timestamps sufficient to read the exact source.
- Tool-driven retrieval should have its own trace; it must not masquerade as
  automatic anchor injection in `memory_injections`.
- The search executor should exclude memory rows already injected as automatic
  anchors for the current request (`memory_injections` knows them): the same
  row arriving twice in one turn — once framed as ambient memory, once as a
  provenance-bearing tool result — wastes budget and invites contradictory
  framing.

## 6. Memory actions inside the loop

The background extraction path remains the correct mechanism for memories that
require a completed conversational window:

- meaningful `shared_moment`;
- a `shift` visible only across several exchanges;
- an `open_thread` whose unresolved status depends on how the window ended;
- conservative whole-history interpretation.

A later hot-path write tool should cover a narrower class: explicit,
current-turn owner statements and decisions whose evidence is already present
and whose durability is clear. It should not ask the chat model to replace the
window extractor.

Candidate operations:

```text
remember_statement(content, evidence_quote, kind)
correct_memory(memory_id, replacement, evidence_quote, expected_version)
forget_memory(memory_id, expected_version)
```

Required server enforcement:

- `evidence_quote` must match the durable current owner message or another
  explicitly selected owner-authored source;
- the server, not the model, assigns trusted source IDs and source type;
- model-generated advice, search results, connector output, and unconfirmed
  inferences are ineligible;
- privacy filtering, exact-hash dedupe, near-duplicate checks, embedding, and
  supersede rules remain application responsibilities;
- correction and forgetting require an explicit owner request in the current
  turn;
- version or updated-at guards prevent blind overwrite;
- whole-subject deletion remains owner-initiated and separately confirmed if
  its scope is ambiguous.

Memory writes are best-effort for conversation quality, but their state
transition must be deterministic and observable.

### 6.1 Interaction with MC-116A failure retraction

A generation attempt now spans every provider round and internal tool execution
until it reaches a successful final answer or a successful yield.

Mutating tool calls must not accidentally survive a retracted attempt. The
recommended first design is:

1. Execute validation and stage an internal mutation under `attemptId` and
   provider `tool_call_id`.
2. Make repeated execution idempotent.
3. Commit staged mutations with the successful terminal turn/yield.
4. Delete staged mutations when the attempt is retracted or swept.

This keeps the database invariant coherent: a memory cannot remain sourced only
to a user message that MC-116A removed with a failed generation.

An external side effect cannot generally be rolled back this way. External
writes therefore stay out of the first tool phase and later require explicit
approval plus their own idempotency and reconciliation contract.

Yield turns interact with retry/edit (MC-116B), not only with failure
retraction: a mutation committed at a successful yield cannot be coherently
retracted when the owner later rewrites the tail that produced it. The
first-cut rule is therefore **an attempt may stage mutations or yield, but
not both** — Phase C ships mutations, Phase D ships yield, and their
composition (flow-scoped staging that survives across the yield boundary, or
yield turns pinned against tail rewrite) is deferred to its own recorded
decision rather than left implicit.

## 7. Provenance and trust are runtime data

Every tool result should carry machine-readable provenance rather than relying
only on prose that tells the model to be careful.

Minimum result metadata:

```text
tool_run_id
tool_name
source_type
source_refs
trust_class
generated_at
persistence_eligibility
```

Suggested source types extend the memory/context addendum's vocabulary:

```text
explicit_user
implicit_conversation
memory_row
diary_entry
raw_message
tool_output
web
connector
manual_profile
system_bootstrap
```

Rules:

- Tool results are data, never higher-priority instructions.
- External or generated results default to `persistence_eligibility = false`.
- Tool output does not enter extraction, recent snapshot, long-horizon
  narrative, or Phases merely because it appeared in a provider round.
- If the owner explicitly confirms a fetched/proposed fact or chooses a
  generated option, the confirmation is a new `explicit_user` source. The
  original tool output does not change trust class.
- A fetch-like tool should consume references granted by the owner or a prior
  search result rather than accepting arbitrary model-invented targets. This is
  capability chaining, not just prompt guidance.
- Logs and traces retain IDs and decisions, not sensitive result bodies by
  default.

D18's `used_web_search` boolean is the shipped narrow version of this policy.
The generic loop should move toward per-tool-run provenance without weakening
the existing exclusion.

### 7.1 Retrieval echo: the assistant's own prose is the leak path

Provenance metadata rides tool results, but the contamination channel that
matters most is the assistant's final durable answer: retrieved journal or raw
history gets paraphrased into ordinary conversation, and every continuity
consumer then reads it as fresh conversational evidence. Two concrete failure
shapes:

- **Journal laundering.** Phases content quoted in chat re-enters
  narrative consolidation through the transcript — reopening,
  through the assistant's own mouth, exactly the channel the journal boundary
  closed. §12.2 states "lyrical interpretation never silently upgrades into
  biographical fact" for curation runs; the chat retrieval path needs the same rule.
- **Old material re-stamped as new.** A three-week-old exchange quoted today
  can be re-extracted as a fresh shared moment carrying today's timestamp —
  the same event held twice under different dates.

Normative consequence: assistant turns that consumed tool results carry
per-scope consumed-source markers (the D18 pattern generalized — e.g.
`used_diary`, `used_raw_history`), and extraction, summary, snapshot, and
consolidation readers either exclude those turns or treat echoed material as
already-carried rather than new evidence. The exact mechanism (turn flags vs.
a tool-run join) is a ticket decision; that the exclusion is structural rather
than prompt-remembered is not.

## 8. Persistence without contaminating conversation history

Provider-native `tool_use` and `tool_result` blocks are needed to continue a
multi-round request, but they are not automatically part of the owner-visible
conversation transcript.

Persisting them as ordinary `messages` rows would create several risks:

- background summary, extraction, narrative, or journal readers may absorb tool
  output as conversation;
- a large search result may bloat the immutable transcript;
- provider-specific blocks may leak through the provider-neutral boundary;
- debugging metadata and owner-facing conversation have different retention
  needs.

The implementation ticket should compare:

1. a dedicated `tool_runs` table keyed by generation `attemptId`, with bounded
   result storage and provenance; or
2. typed message metadata/blocks plus a strict rule that continuity consumers
   read only final complete owner/assistant conversational blocks.

The first option is not merely preferred: it is the only design consistent
with this section's own closing rule. Typed blocks with consumer filters make
every present and future continuity reader responsible for remembering the
exclusion — the failure mode D18 already paid for once, when consumers read
`messages` directly and a flag had to be retrofitted — while a dedicated
table excludes tool output from every consumer by construction. A
content-block migration would have to demonstrate equivalent structural
exclusion, not merely a cleaner event log, to reopen this. In either case:

- the final assistant answer remains the durable conversational message;
- tool rounds are reconstructable enough for retry/debug;
- tool bodies have explicit retention and redaction rules;
- continuity jobs exclude tool output by construction, not by remembering to
  add another prompt instruction.

## 9. Streaming, limits, cancellation, and failure

The hard iteration cap from v0.2 remains necessary but is not sufficient. One
attempt should also have:

- a maximum total number of tool calls;
- per-tool and total result-token budgets;
- the existing request wall-clock timeout applied to the whole loop;
- cancellation propagated through the active provider call and tool executor;
- a maximum number of recoverable tool failures before the attempt ends;
- request-body and result-size limits independent of model context limits.

Lifecycle rules:

- The assistant database row remains `streaming` across intermediate provider
  rounds.
- Only the provider round that ends without further tool use can complete the
  assistant message, or a yield tool can complete the turn under its explicit
  contract.
- Intermediate text emitted before a tool call must not be mistaken for a
  complete reply or fed into continuity jobs.
- Tool failures should normally return a bounded, sanitized error result that
  lets the model recover. Authentication failures, owner-approval requirements,
  and unsafe mutations yield to the owner instead of inviting repeated model
  retries.
- Abnormal termination retracts the attempt under MC-116A, including staged
  internal mutations.
- SSE must distinguish text/thinking from tool status and durable UI blocks;
  transient execution status must not be persisted as assistant prose.

Pre-tool text is buffered until the loop reaches a final answer, not streamed.
For this product the trade is not latency versus polish: an assistant that says
something and then revises it after a tool result is a register incident, and
streamed-then-superseded text is exactly the artifact class MC-116A exists to
keep out of durable history — buffering shrinks that exposure window to zero.
Perceived latency is answered by transient tool status (§10), not by
committing prose early. Revisit only if dogfooding shows status blocks are
insufficient.

## 10. Typed presentation and owner interaction

The content-block reshape already planned jointly for tools and image input
should leave room for:

- text;
- image;
- tool status;
- source/citation reference;
- elicitation/approval UI;
- file or artifact reference;
- structured or interactive presentation.

Creating an artifact and making it available to the owner are separate actions.
A successful filesystem/database write is not sufficient if no owner-visible
block references the result.

An elicitation tool is a successful turn boundary:

```text
model decides a material owner choice is required
-> yield tool stores/renders the question
-> current turn ends
-> owner selection arrives as the next owner message
-> a new bounded generation begins
```

This should not be used for ordinary conversation, emotional processing, or
questions whose answer is already present in current context or searchable
continuity. It is a UI affordance for real decision points, not a replacement
for the assistant's judgment.

## 11. Capability loading and cache discipline

The first release should keep the fixed, small allowlist required by v0.2.
Longer term, tool policies and specialized schemas can be grouped into
capability packs loaded only when relevant.

Potential benefits:

- a smaller stable core prompt;
- fewer irrelevant schemas competing for model attention;
- tool-specific operational guidance loaded with the capability;
- cleaner owner gating for external connectors.

Costs and open questions:

- changing the `tools` request field may change provider cache keys; whatever
  ships, tool definitions must serialize deterministically (stable ordering,
  stable JSON) — the idle economics of the whole system assume stable
  prompt-cache identity (D3), and an allowlist that reorders itself is a
  cache-buster with no feature attached;
- a discovery/load round adds latency;
- dynamically supplied schemas widen the validation and security surface;
- external connector discovery is unnecessary for the current single-owner
  core.

Therefore dynamic tool packs are deferred until the bounded internal loop is
dogfooded. The first ticket should measure how the provider includes tool
definitions in prompt-cache identity before optimizing schema loading.

## 12. Scheduled autonomous memory curation

Search and autonomous curation solve different problems:

| Mode | Trigger | Read behavior | Output |
| --- | --- | --- | --- |
| Automatic anchors | Current owner message | Deterministic query retrieval | Volatile context for this answer |
| Search tool | A gap recognized during the current turn | Model chooses a query, then expands a relevant source | Evidence for this answer |
| Consolidation job | Fixed cadence/window and fixed source selection | Application supplies the bounded source set | Replacement narrative/snapshot/diary artifact |
| Curation run | Idle/cadence eligibility without a current question | Model autonomously chooses what past material to read and connect | A separate, reviewable set of proposals or reorganized knowledge |

The important distinction is not whether search infrastructure exists under the
hood. A search call starts with a question. A curation run starts with time, accumulated
material, and permission to look; the model discovers which questions are worth
asking.

### 12.1 Reference behavior

Claude Managed Agents documents
[dreaming](https://platform.claude.com/docs/en/managed-agents/dreams) as an
asynchronous process that reads an existing memory store together with selected
past session transcripts, then produces a separate reorganized memory store.
The input store is not modified, so the result can be reviewed, adopted, or
discarded. The
[product announcement](https://claude.com/blog/new-in-claude-managed-agents)
describes it as a scheduled process for finding cross-session patterns and
curating memory.

The public API exposes an explicit asynchronous job; it does not define
automatic idle detection. Loci therefore owns the trigger semantics.
Episode idle should answer only "is it safe to run now?", consistent with
MC-108. A separate cadence/materiality guard answers "is there enough new
material to justify a run?"

The non-destructive output-store pattern is the most important behavior to
retain. A speculative reflective pass must not rewrite the authoritative
continuity carriers in place.

### 12.2 Autonomous Phases reading

MC-111 originally limited the journal's machine-facing role to retrieval and
explicitly prevented it from feeding narrative consolidation.
This note refines, rather than discards, that boundary:

- Phases may be read autonomously inside a curation run, not only searched in
  response to an owner query.
- Phases still do not become a direct source for narrative
  consolidation.
- A run-derived proposal must retain journal-entry source references.
- Before a proposal can change a durable factual carrier, it must be
  corroborated against raw owner messages/existing grounded memory or explicitly
  confirmed by the owner.
- Lyrical interpretation may generate associations or questions, never silently
  upgrade itself into biographical fact.

A curation run should begin with a catalog and watermarks, not every journal body
preloaded into one prompt:

```text
recent Phase dates and source references
current narrative/memory versions
last successful curation watermark
bounded instructions for the run
```

Inside its background tool loop, the model can then choose:

```text
list_phase_entries(before?, after?, limit?)
read_phase_entry(entry_ref)
read_context_source(source_ref, before_count?, after_count?)
search_context(query, scopes)  # optional escalation, not the defining action
```

Direct `read_phase_entry` matters. If autonomous curation were implemented as one semantic
search query, the model could retrieve only what it already knew to ask for and
would miss the weak cross-day patterns the process exists to discover.

Search/read infrastructure should still land first because autonomous curation reuses its
bounded source references, provenance, redaction, and tool-run trace.

### 12.3 Trigger and lifecycle

The first trigger should reuse the existing worker/tick substrate:

1. An episode is idle; no curation run executes on the active chat path.
2. A materiality/cadence predicate checks for enough unreviewed Phases,
   sessions, or memory changes.
3. A deduplicated PostgreSQL job starts with fixed input watermarks and source
   versions.
4. The background model runs a bounded read-only tool loop.
5. The job writes a separate curation output and trace.
6. The owner reviews/adopts/discards it, or a later narrowly defined policy
   applies safe structural proposals.

Idle alone must never trigger a run every time the owner pauses. Cost scales
with the amount of material read, and frequent runs would repeatedly
reinterpret the same days. Exact cadence and materiality constants should be
chosen after a manual dry-run over real Phases.

Curation runs are whole-corpus readers — Phases plus expanded raw spans — so
the execution endpoint is part of the design, not an ops detail: they
default to the official API with an explicitly chosen model, never a relay
(the 2026-07-19 eval round demonstrated a relay silently rewriting requests;
a process that concentrates the most personal corpus does not ride one), and
the run trace records provider, model, and host the same way eval reports
do.

The job is asynchronous and should support `pending`, `running`, `completed`,
`failed`, and `canceled` states through the existing jobs machinery. One source
window/version set may have at most one active run. Cancel or failure leaves any
partial output inspectable or marks it unusable; it never mutates inputs.

### 12.4 Outputs and carrier boundaries

Autonomous curation is an orchestration mode, not automatically a new always-on memory
carrier. Candidate outputs are:

- proposed memory merges, supersedes, corrections, or resolved-thread changes;
- proposed v0.3 entity links, entity overviews, or episode groupings;
- project-context reorganization proposals;
- cross-Phase associations or questions worth revisiting;
- a human-readable curation report explaining sources and proposed changes.

The first experiment should store these as provisional output attached to a
`curation_run`, not inject them into chat and not apply them to `memories`,
the long-horizon narrative, recent snapshot, or Phases.

Adoption is a separate operation:

- **discard**: keep only minimal run metadata or archive the output;
- **adopt structural proposal**: apply through the destination carrier's normal
  version/concurrency rules;
- **confirm factual proposal**: owner confirmation becomes the grounded source;
- **read in a later chat**: retrieve explicitly as a provisional curation artifact,
  clearly separated from established memory.

Curation output must not feed the next run as its only evidence. Carry source
references forward and periodically rebuild proposals from authoritative
Phases/raw history to prevent run-to-run interpretive drift.

The journal writer's blindness extends to curation runs: their output — including
any autonomous reading *of* the Phases corpus — never enters the journal writer's
context. Series-level findings about the journal (formal convergence across
entries, recurring tics) reach the writer only as owner-adopted prompt
changes, never as ambient feedback: a daily "you have been writing
formulaically" injection would itself be one more formula rule, and would
reopen through a side door the self-imitation channel the writer's blindness
exists to close (MC-115's 2026-07-28 finding: blindness prevents copying,
not convergence — the cure for convergence is prompt iteration through the
owner, not corpus feedback through context).

### 12.5 Suggested experimental order

Precondition: MC-115 C's anti-slot journal fix lands before the first curation
dry-run. Curation runs mine cross-day patterns, and formula convergence poisons
exactly that signal — four entries sharing a skeleton read as four days
sharing a meaning, and repeated ritual sentences look like repeated
significance. The writer's tics are treated before the reader learns from
them; the dependency runs journal quality → curation quality.

1. Land continuity search/read tools and their provenance trace.
2. Add a manual `curation:dry-run` over a small owner-selected Phase range.
   One bounded instruction of the first run: *describe the formal shape of
   the last N entries* — it doubles as convergence detection (the
   interpretive layer above MC-115's mechanical skeleton-series check) and
   tests whether autonomous sequential reading finds what hand analysis
   found on 2026-07-28.
3. Produce a read-only report plus proposal JSON; mutate nothing.
4. Compare what autonomous sequential reading finds against a semantic-search
   baseline, using the MC-114 harness pattern — pinned fixtures, owner labels,
   a baseline arm, provenance-stamped reports — so autonomous curation lives inside a
   protected evaluation cycle from its first run instead of earning one after
   its first regression.
5. Add scheduled eligibility only if the dry-run produces useful,
   non-duplicative insights.
6. Add owner review/adoption before considering any automatic structural
   curation.

This keeps autonomous curation downstream of evidence access and observability, while
preserving its defining property: the model decides what to revisit without a
current owner query.

## 13. Proposed implementation sequence

### Phase A — loop substrate, read-only

- Introduce provider-neutral content blocks and `tool_use` / `tool_result`.
- Add the outcome discriminator even if only `continue` ships.
- Keep the allowlist fixed and server-gated.
- Implement iteration/call/result/time budgets, cancellation, sanitized errors,
  and tool-run tracing.
- Ship one internal read tool: the frozen spec's `search_memory`.
- Leave provider-hosted `web_search` on its current adapter path initially.

### Phase B — continuity search

- Phases and raw-conversation search ship together as MC-122 (2026-09-12):
  whole journal entries by date, literal transcript search, source expansion
  with one continuation contract, and the §7.1 boundary as one
  source-isolation predicate shared by every continuity reader.
  Recent-session orientation is the journal date list. Indexing is measured
  after shipping, not before (triggers in the ticket).
- Keep all results volatile and provenance-bearing.

### Phase C — grounded memory actions

- Add staged, evidence-bound `remember_statement`.
- Add explicit correction/forget operations with version guards.
- Preserve window-level background extraction for episodic and relational
  memories.
- Dogfood false writes, missed writes, latency, and failure retraction before
  broadening eligibility.

### Phase D — yield and presentation

- Add owner-choice/approval outcomes.
- Add durable typed content blocks only where the UI materially benefits.
- Reuse the same outcome model for later file/artifact delivery.

### Phase E — asynchronous and external capabilities

- Integrate approved long-running jobs with the existing PostgreSQL worker.
- Add external-write idempotency and reconciliation before any connector can
  mutate state.
- Consider capability packs or connector discovery only after core-tool traces
  show a need.

## 14. Explicit non-goals

- Replacing the continuity capsule with mandatory tool calls.
- Replacing automatic anchor retrieval with model initiative.
- Replacing background memory extraction with per-turn archival.
- Treating every idle episode as permission to run a curation pass.
- Letting curation output rewrite authoritative continuity carriers in place.
- Feeding curation output into the journal writer's context (§12.4): the
  writer's blindness to its own corpus includes readings of it.
- Feeding Phases directly into narrative consolidation.
- Persisting model inference, generated advice, or fetched facts as durable
  memory without a new explicit owner source.
- Exposing every application query as a model tool.
- Open-ended autonomous planning or recursive agents.
- Direct MCP integration or a second memory store.
- Shipping domain widgets, artifacts, connectors, or external writes in the
  first loop ticket.
- Reopening the frozen v0.2.0 shipped scope.

## 15. Ticket-time decisions still required

1. Public tool naming: keep `search_memory` first, or begin with scoped
   `search_context`. *Settled 2026-09-12 (MC-122): per-source verbs.*
2. Tool-run persistence: dedicated `tool_runs` table or typed event blocks with
   strict consumer filters.
3. Exact iteration, call-count, token, result-size, and timeout limits.
4. Whether provider-emitted text before `tool_use` streams immediately or is
   buffered.
5. Serial-only calls first or support for provider-requested parallel reads.
6. Raw-history indexing: full-text, embeddings, or hybrid, with CJK-heavy
   fixtures. *Settled 2026-09-12 (MC-122): no new index; literal match
   with a literal-boundary unit table in place of CJK fixtures; upgrade
   triggers recorded in the ticket.*
7. Whether tool-initiated memory reads affect recall decay.
8. Staged mutation schema and atomic commit point with MC-116A.
9. UI and persistence shape for a successful yield turn.
10. Prompt-cache behavior when tool definitions or capability packs change.
11. Trace retention and redaction limits.
12. Whether and when provider-hosted `web_search` should be normalized into the
    generic execution trace without replacing its server-side execution.
13. Curation cadence/materiality gates and source-window watermarks.
14. Curation-run/output schema, review UI, and retention.
15. Which proposal classes, if any, may eventually be auto-applied.
16. Whether a curation run may read raw conversations directly or must first justify
    expansion from a Phase/memory source reference.
17. The retrieval-echo mechanism (§7.1): per-scope consumed-source markers vs
    a tool-run join, and which continuity readers exclude vs down-weight
    echoed material. *Settled 2026-09-12 (MC-122): a `tool_runs` EXISTS
    predicate, one isolation class rather than per-carrier markers; all
    five readers keep the row and replace the assistant content with a
    placeholder; selection before substitution.*
18. Yield × MC-116B: whether yield turns are pinned against tail rewrite or
    staged mutations become flow-scoped; until decided, mutations and yield
    stay mutually exclusive within one attempt (§6.1).
19. Curation execution policy details beyond §12.3's endpoint rule: model and
    thinking configuration, recorded in the run trace.
20. Cross-turn retrieval amnesia: whether a tool result may be re-injected
    for follow-up turns or every turn re-searches (first cut: re-search —
    the durable answer usually carries enough forward).

These decisions belong in the implementation ticket with concrete schemas,
failure matrices, and acceptance tests. This note records the intended runtime
shape so the ticket does not accidentally optimize only for the first
read-and-continue tool.
