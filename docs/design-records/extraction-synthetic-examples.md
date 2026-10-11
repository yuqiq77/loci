# Synthetic Examples in the Extraction Prompt

## Decision

The extraction prompt illustrates episodic meaning with a fictional prototype
review and illustrates the JSON shape with a fictional project-scope decision.
Both the live prompt and the historical replay arm use these examples. The
historical arm retains its earlier selection rules; it is not a byte-for-byte
archive of earlier example text.

The examples still demonstrate a source-grounded event, its significance, and
a change of state. Selection rules, writer voice, identity framing, JSON
schema, scoring, window geometry, and the five-item cap are unchanged.

## Replay evidence

On 2026-10-11, the existing synthetic `extraction/nebel` fixture was replayed
before and after the example change through the configured extraction
provider. Its reported model identifier was `claude-opus-5-5`. Both runs used
the production windows of five and six exchanges, the current framed prompt,
the fixed five-item cap per window, and the live 32,000 output-token limit.

| Run | Raw / kept candidates | Coverage | Hard flags |
| --- | --- | --- | --- |
| Baseline | 4 / 4 and 4 / 4 | 5 of 6 (0.833) | None |
| Synthetic project examples | 4 / 4 and 4 / 4 | 6 of 6 (1.000) | None |

The existing coverage floor remains 0.8. The baseline debt item was present
in meaning but missed the evaluator's literal marker list; no label or
threshold was changed. Neither run copied the prototype example into its
output. A single comparison does not establish improved model quality.

Frozen outputs and generation metadata:

- [Baseline candidates](evidence/extraction-baseline.json)
- [Synthetic-example candidates](evidence/extraction-synthetic.json)

The provider endpoint and local environment paths are not part of the public
artifacts. The input corpus is the existing explicitly fictional theatre
scenario, not captured conversation data.

## Reproduction

Recheck the frozen outputs without calling a provider or accessing a database:

```sh
node --import tsx scripts/content-discipline-eval.ts extraction extraction/nebel \
  --candidate docs/design-records/evidence/extraction-baseline.json \
  --output /tmp/extraction-baseline-check.md
node --import tsx scripts/content-discipline-eval.ts extraction extraction/nebel \
  --candidate docs/design-records/evidence/extraction-synthetic.json \
  --output /tmp/extraction-synthetic-check.md
```

Generate a new candidate with the configured provider:

```sh
DATABASE_URL=postgresql://replay:replay@127.0.0.1:9/replay_no_database \
  node --import tsx scripts/content-discipline-eval.ts extraction extraction/nebel \
  --generate --output /tmp/extraction-synthetic-replay.md
```

The deliberately unreachable database address guards this fixture-only
generation path against accidental database access. New model output is
nondeterministic; the frozen candidates are the evidence for the comparison
above. This replay checks extraction content, not worker scheduling or
database persistence.
