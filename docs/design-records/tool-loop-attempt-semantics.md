# Tool-Loop Attempt Semantics: One Reply Across Many Rounds

## Problem

A tool-using reply is not one provider request. It may span context assembly,
several provider rounds, local executions, replayed results, pause
continuations, and a final answer. Treating each round as an independent
generation breaks properties the chat system already needs: one visible
reply, cancellation boundary, retry identity, cost envelope, and durable
outcome.

Intermediate provider prose creates another hazard. Text before a tool call is
provisional; streaming it immediately can leave the visible transcript with an
answer that a later round revises.

## Constraints

- Provider continuation requires complete assistant blocks, including signed
  thinking, redacted thinking, hosted-tool blocks, and client tool calls.
- Ordinary offline writers use string messages and should not inherit tool
  protocol types.
- The provider can return malformed input, unknown tools, multiple calls, a
  refusal, `pause_turn`, or an output cap while calls remain unresolved.
- Provider preferences such as disabling parallel calls are not trusted as
  runtime guarantees.
- Tool traces must follow message commit, retraction, and rewrite semantics.
- With no enabled client tools, request bytes and persistence behavior should
  stay on the original path.

## Evidence

Per-request timeouts and usage counters do not bound a multi-round reply: each
new round can reset them. Likewise, a per-result limit does not cap the sum of
results returned to the model.

Protocol replay also makes message persistence the wrong trace substrate.
Intermediate text is required on the wire but must not become conversation
history or feed memory writers. The design needs a separate record of what the
model requested and what it received.

## Decision

Treat all provider rounds and tool executions for one reply as a single,
server-authoritative **generation attempt**.

```text
begin generation
  ├─ snapshot enabled tools and schemas
  ├─ establish one absolute deadline
  └─ provider ⇄ staged tool run ⇄ executor
                 │
                 └─ bounded result replay

final answer  → atomically commit message and runs
abnormal end  → atomically retract unfinished message and staged runs
later rewrite → mark prior committed runs superseded
```

The attempt owns the immutable tool snapshot, deadline, cancellation signal,
budgets, accumulated usage, trace rows, and final message outcome. No round
can reset them.

Tool-capable attempts use **buffer-first streaming**. Pre-tool answer text is
replayed to the provider and stored, bounded, on the first run of that round,
but never streamed as answer prose or persisted as a message. Only the final
round's text completes the assistant message. Thinking and hosted-search
status retain their typed streaming channels.

Rich continuation turns live beside ordinary string messages instead of
widening the shared writer type. Thinking signatures and opaque redacted
blocks are replayed unchanged; client results reference the original provider
tool-use id.

Attempt-wide limits are code constants next to the loop:

| Limit | Value |
| --- | ---: |
| Normal rounds | 4: at most three tool rounds, then a final round |
| Client tool calls | 6 |
| One result | 800 estimated tokens |
| All results | 2,000 estimated tokens |
| Recoverable failures | 2 |
| Pause continuations | 4 |
| Absolute deadline | 5 minutes from generation start |

Every result string, including error text and its truncation marker, spends
from the same total. Usage is accumulated across rounds.

When a limit is reached, the loop first appends a final-answer instruction
while leaving automatic tool choice unchanged, preserving prompt-cache
identity. If the model requests another tool, the call is denied and recorded
as `final_round_violation`; one bounded hard-final round disables tools. A
tool request on that exceptional fifth round terminates the attempt.

Malformed input, unknown names, and permitted executor failures return
sanitized, bounded error results so the model has a limited chance to recover.
Refusal, an output cap with unresolved calls, missing protocol ids,
cancellation, and deadline expiry terminate through the normal generation
failure path. `pause_turn` is separate hosted-tool plumbing: it shares the
absolute deadline but has its own continuation cap.

Client calls execute serially in block order. Parallel use is disabled on the
wire, but multiple returned calls are still serialized and answered together.

The typed registry records effect, gate, trust class, outcome class,
visibility, result budget, persistence eligibility, failure policy,
idempotency, schema, and executor. Only the `continue` outcome is constructible
in the first production phase; future outcomes are represented but cannot be
created. Recursively stable schema serialization supplies both the provider
definition and `tool_schema_hash`.

Tool rounds persist in `tool_runs`, never in chat messages. Rows move from
`staged` to `committed` with successful completion, to `retracted` with an
abnormal attempt, or to `superseded` when a later rewrite replaces a completed
exchange. Identifiers, status, timings, and schema hashes remain for good.
Bodies (input, result, preceding text) are purged lazily. The cleanup that
runs inside the reply-start transaction purges that conversation's runs older
than seven days. Nothing else purges them, so a conversation that never starts
another reply keeps its bodies. The purge reuses that existing per-conversation
cleanup and adds no background machinery. A sweep across conversations would
belong on the job worker's periodic tick.

## Alternatives rejected

- **Persist rounds as messages:** leaks protocol scaffolding into history and
  memory sources.
- **Stream every text delta:** exposes provisional prose that cannot be
  cleanly replaced.
- **Reset budgets per round:** multiplies cost and time with round count.
- **Implement future outcome kinds now:** freezes authorization and lifecycle
  semantics before a real tool needs them.
- **Best-effort trace writes:** permits an unexplainable successful answer;
  failure to record a run fails the attempt.

## Invariants

- One visible reply maps to one server attempt.
- Tool enablement and schemas cannot change mid-attempt.
- Pre-tool prose never becomes message prose.
- All rounds share one deadline, cancellation signal, budgets, and usage
  total.
- Calls execute serially even if the provider returns several together.
- Each provider tool-use id is recorded at most once per attempt.
- Message and trace lifecycle transitions are atomic.
- Tool traces cannot become memory-writer input.
- An empty client-tool snapshot preserves the original request path.

## Verification

The runtime and constants are in
[`src/server/chat/tool-loop.ts`](../../src/server/chat/tool-loop.ts); provider
mapping is in
[`src/server/chat/anthropic.ts`](../../src/server/chat/anthropic.ts); registry
contracts and deterministic hashes are in
[`src/server/chat/tool-registry.ts`](../../src/server/chat/tool-registry.ts).
Message/run transactions live in
[`src/server/db/chat.ts`](../../src/server/db/chat.ts).

[`tests/unit/tool-loop.test.ts`](../../tests/unit/tool-loop.test.ts) exercises
buffering, serial execution, budgets, soft and hard finalization, pause
continuation, usage accumulation, cancellation, and the absolute deadline.
[`tests/unit/anthropic-tool-protocol.test.ts`](../../tests/unit/anthropic-tool-protocol.test.ts)
pins rich-block replay and malformed input handling.
[`tests/unit/tool-registry.test.ts`](../../tests/unit/tool-registry.test.ts)
pins the tool snapshot, schema hash, constructible outcomes, and static reader
boundary. Database integration tests in
[`tests/integration/tool-runs.test.ts`](../../tests/integration/tool-runs.test.ts)
cover lifecycle, lost acknowledgments, body retention, and byte-identical
memory-reader projections after trace rows are inserted.

## Known limits

- Only read-oriented `continue` tools have production semantics; mutation and
  approval outcomes remain intentionally undefined.
- Execution is serial; the design makes no latency claim for independent
  calls.
- Reserved context headroom covers bounded client results and thinking, not
  every possible hosted-tool payload or provisional text block.
- Trace rows explain tool execution but are not a complete provider-call cost
  ledger.
- Every new tool still needs its own authorization, trust, validation, budget,
  and failure decisions.
