// Introduced ahead of adoption (2026-10-09): no private writer imports these
// yet. Applying them is a prompt change per writer — extraction's revision has
// its own ticket, the session summary has no fixture to check a change
// against — so the private line adopts writer by writer, with evidence. The
// public snapshot applies both rules to the four capsule-adjacent writers
// (session summary, recent snapshot, extraction, narrative); the journal
// keeps its own wording in both lines.
//
// The floors every background writer shares (2026-10-07), one wording each so
// the writers cannot drift apart. What they write is read again inside a
// system prompt that already uses "you" for the assistant — the capsule, the
// anchors, the next writer's sources — so the person is never "you"
// (memory-capsule-design.md, "Voice & person"). Pronouns come from the
// sources, never from a guess at a name. The neutral fallback names its form
// per language (2026-10-07 replay): told only "they", a Chinese summary wrote
// 他们, which reads as plural; told only "no gendered pronoun", a Chinese
// snapshot dropped the subject and let the person's "我" through as the
// assistant's.
export const PERSON_REFERENCE_RULE =
  'Refer to the person by name when the sources give one, with the pronouns the sources establish; otherwise with a neutral reference — "they" in English, 对方 or TA in Chinese — never a pronoun guessed from the name. Never refer to them as "you", "user", or "assistant", or by those words\' equivalents in the language you write.';

// The language floor of the writers that follow their sources. The narrative
// alone carries its record's language forward instead, so a newest window
// never flips the record.
export const SOURCE_LANGUAGE_RULE =
  "Write in the dominant language of the sources; a verbatim quote stays in its original language, never translated or paraphrased.";
