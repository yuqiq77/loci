import {
  estimateTextTokens,
  locateNarrativeSection,
  splitTextUnits,
} from "@/server/chat/context";

export type TextTokenCounter = (text: string) => Promise<number>;

// One accounting domain (D14 as amended by MC-121): the narrative, snapshot,
// and summary writers count with the same local estimator the per-turn
// capsule assembly and the manual /profile cap use. The provider's
// count_tokens used to sit here with an estimator fallback; the ~1.3× unit
// gap between the two amputated layers at write time when the counter
// failed (every relay run; v33 on official) and trimmed Long-term at read
// time when it succeeded (v29, v30, v32, v34). No provider call, no
// fallback branch, so no run can change unit midway. Still a TextTokenCounter
// so the trim helpers below keep one injectable seam for their tests.
export const compressionTokenCounter: TextTokenCounter = async (text) =>
  estimateTextTokens(text);

// Write-time hard cap for the long-horizon narrative document (D14 backstop):
// shrinks the `## Narrative` section from the end — mirroring the capsule's
// section-aware trim priority — instead of blind end-trimming, which would eat
// `## Anchors` first. Binary-searches over whole units so the async token
// counter is called O(log n) times. Falls back to the blind trim only when no
// `## Narrative` section exists or dropping its whole body still overflows.
export async function trimNarrativeSectionToTokenBudget(input: {
  text: string;
  tokenBudget: number;
  countTokens: TextTokenCounter;
}): Promise<string> {
  const normalized = input.text.trim();
  if (!normalized || input.tokenBudget <= 0) {
    return "";
  }
  if ((await input.countTokens(normalized)) <= input.tokenBudget) {
    return normalized;
  }

  const narrative = locateNarrativeSection(normalized);
  if (narrative) {
    const split = splitTextUnits(narrative.body);
    const withNarrativeUnits = (kept: number): string =>
      narrative.rebuild(
        split.units.slice(0, kept).join(split.separator).trim(),
      );

    let low = 0;
    let high = split.units.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (
        (await input.countTokens(withNarrativeUnits(middle))) <=
        input.tokenBudget
      ) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    const trimmed = withNarrativeUnits(low);
    if ((await input.countTokens(trimmed)) <= input.tokenBudget) {
      return trimmed;
    }
    return trimTextToTokenBudget({ ...input, text: trimmed });
  }

  return trimTextToTokenBudget(input);
}

export async function trimTextToTokenBudget(input: {
  text: string;
  tokenBudget: number;
  countTokens: TextTokenCounter;
}): Promise<string> {
  const normalized = input.text.trim();
  if (!normalized || input.tokenBudget <= 0) {
    return "";
  }
  if ((await input.countTokens(normalized)) <= input.tokenBudget) {
    return normalized;
  }

  const characters = Array.from(normalized);
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = characters.slice(0, middle).join("").trim();
    if ((await input.countTokens(candidate)) <= input.tokenBudget) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }

  return characters.slice(0, low).join("").trim();
}
