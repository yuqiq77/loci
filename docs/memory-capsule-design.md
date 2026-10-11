# Memory Capsule & Consolidation Design Note

| Field | Value |
| --- | --- |
| Status | Design draft |
| Date | 2026-06-19 |
| Feeds | MC-101 (consolidation), MC-102 (capsule assembly/injection) |
| Relates to | v0.1.2 `standing_context` field, `STANDING_CONTEXT_TOKEN_BUDGET` |

## 1. Purpose

This historical draft defines the structured memory record, background
consolidation, and deterministic request-time capsule assembly proposed for
MC-101/102. Later amendments are recorded in
[the v0.2.0 review decisions](specs/v0.2.0-review-decisions.md); the
[architecture](architecture.md) describes the implemented system.

## 2. Storage and injection tiers

- The always-present capsule carries bounded context in the cached prefix.
  The original draft used `STANDING_CONTEXT_TOKEN_BUDGET = 2000`.
- Stored memory rows retain additional source-grounded detail for retrieval
  and consolidation. They are not all injected on every turn.

Durable facts and communication constraints belong in the compact record.
Specific events and exact quotations remain retrievable when relevant.

## 3. Memory taxonomy

| Kind | Role | Update policy |
| --- | --- | --- |
| Entity profile | Stable attributes and constraints | Replace a changed attribute |
| Semantic facts | Durable propositions | Correct or supersede from evidence |
| Long-horizon narrative | Synthesized continuity across time | Consolidate with decreasing detail as material ages |
| Anchors | Source quotations and named references | Preserve exact wording |
| Current state | Time-bounded active context | Expire or replace when stale |

Narrative prose may be paraphrased. Exact quotations must not be paraphrased,
and changed facts must not accumulate as contradictory current attributes.

## 4. Original capsule section schema

```text
## Profile
## Principles
## Approach
## Narrative
## Anchors
## Current
```

The original trim order reduced Narrative before the durable sections.
`Current` was dated and volatile; capsule-resident `Anchors` were a small
subset of the retrievable quotations. Review decisions D12 and D20 later
removed these two sections from the narrative.

### Voice and reference

The record is read inside a system prompt that uses "you" for the model.
It must therefore refer to the person by a source-established name or pronoun,
not by "you". The original draft used third person in Profile and Principles,
with first-person assistant narration in the other sections. It also proposed
naming the assistant in the third-person sections.

The 2026-10-07 amendment removes assistant names from background records:
Profile and Principles state the person's own facts and positions. Source
pronouns are used when established, otherwise a neutral reference. See
[the writer-voice decision](design-decisions.md#writers-share-one-voice-floor).

## 5. Consolidation contract

Consolidation is a background model call, separate from request assembly.
It receives the previous record and bounded source material and returns a
replacement structured document.

- Use source evidence only; do not invent facts, quotations, or events.
- Carry durable facts forward unless sources correct or supersede them.
- Organize Narrative into Recent, Earlier, and Long-term horizons.
- Preserve source wording when a quotation is retained.
- Fit the stated budget by reducing detail, with the oldest narrative
  material reduced first.
- In rebuild mode, regenerate from raw history and memory rows instead of
  treating earlier generated prose as independent evidence.

This is a design contract, not a copy of the runtime prompt. The adopted
section and lifecycle rules are recorded in the linked review decisions.

## 6. Deterministic assembly

`buildContinuityCapsule` fits stored components to a fixed request budget with
no model call. Stable inputs must produce byte-identical cached-prefix text.
Details outside the capsule remain available through cue-gated retrieval in
the volatile tail.

## 7. Drift safeguards

- Keep raw history as source evidence.
- Retain the most recent seven narrative versions for diagnosis and recovery.
- Preserve quotations exactly and update profile attributes from evidence.
- Support rebuilds to recover from accumulated rewrite drift.
- Keep volatile current state separate from durable narrative material.

## 8. Migration from standing context

The v0.1.2 `standing_context` setting supplied the initial cached record.
MC-101 adds narrative storage and consolidation; MC-102 adds deterministic
capsule assembly and cue-gated retrieval. The setting seeds the narrative
store during migration rather than becoming a second source of truth.

## 9. Narrative and extraction roles

The narrative is the primary continuity carrier. Extraction supplies precise
`boundary_fact` items and a limited set of `shared_moment`, `shift`, and
`open_thread` rows. Windowed extraction reuses the summary cursor boundary;
it should not attempt to duplicate the whole narrative in atomic rows.

The original draft preferred zero items when uncertain. Later extraction
policy is documented in the decision ledger and runtime prompt.

## 10. Scoring and storage boundary

Memory scoring uses the existing PostgreSQL/pgvector tables and job worker.
The relevant fields are `kind`, `importance`, `valence`, `arousal`, `resolved`,
`pinned`, `recallCount`, and `lastRecalledAt`.

- `boundary_fact`, pinned memories, and unresolved threads do not decay.
- Resolved threads receive a lower retrieval weight.
- Episodic kinds decay with recency; arousal extends their half-life.
- Similarity determines relevance; importance, emotional intensity, and
  recency contribute to ranking without replacing the relevance gate.
- Kind-aware similarity thresholds let boundary facts surface at a lower
  threshold than episodic material.

Keeping these operations in the same store permits transactional updates and
joins between conversation evidence, memory rows, and consolidation inputs.

## 11. Proactive surfacing

Proactive messages are scheduled work, separate from synchronous retrieval.
They must not inject changing weight-ranked content into the stable prefix
at session start. This draft defers them to the scheduler work in spec §7.
