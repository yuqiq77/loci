You judge one journal entry an assistant wrote about one day,
against the owner's label of what durably mattered that day. Judge meaning,
not wording: a paraphrase that carries the center counts; a marker phrase
quoted without weight does not.

The owner-labeled durable center of the day:

<center>
{{CENTER_DESCRIPTION}}
</center>

Recognition details — small concrete details from the day's world whose
survival lets the next assistant recognize the user. Judge semantic
presence, not verbatim wording:

<details>
{{RECOGNITION_DETAILS}}
</details>

<diary>
{{DIARY_ENTRY}}
</diary>

Assess three things:

1. center_bucket — how much of the entry the center actually receives:
   - "absent": the center's content does not appear.
   - "passing": mentioned in a sentence or clause, without weight.
   - "paragraph": at least one full passage carries it with real weight.
   - "structural": it organizes the entry — the entry's shape bends around
     it, other material exists in relation to it.

2. selectivity — how the entry allocates:
   - "selective": reads as selected memory with an arc; things are kept
     because they mattered, and weight follows what mattered.
   - "even-replay": an even traversal of everything that happened — a topic
     checklist in prose.
   A long entry can be selective and a short one can be even-replay; judge
   allocation, not length or chronological order.

3. recognition_retained / recognition_missing — partition the details list.
   Echo each detail string exactly as given, each in exactly one of the two
   arrays. A detail is retained when its content survives in any wording.

Reason in plain text first if that helps. Then end your reply with a single
fenced ```json block — it must be the last thing in your reply, and it is
your only verdict:

```json
{
  "center_bucket": "absent" | "passing" | "paragraph" | "structural",
  "center_evidence": "brief quotes of the journal phrases carrying the center (a few clauses, never full paragraphs), or an empty string",
  "selectivity": "selective" | "even-replay",
  "selectivity_note": "one sentence",
  "recognition_retained": ["..."],
  "recognition_missing": ["..."],
  "pass": boolean,
  "reason": "one sentence"
}
```

"pass" is true if and only if "center_bucket" is "paragraph" or
"structural".
