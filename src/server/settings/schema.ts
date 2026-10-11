import { z } from "zod";

import {
  capsuleBudgetRefusal,
  chatWindowRefusal,
  NARRATIVE_MIN_TARGET,
} from "@/server/summaries/narrative-budget";

export const MAX_SYSTEM_PROMPT_LENGTH = 20_000;

export const settingsSchema = z
  .object({
    systemPrompt: z
      .string()
      .trim()
      .min(1, "System prompt is required.")
      .max(
        MAX_SYSTEM_PROMPT_LENGTH,
        `System prompt must be at most ${MAX_SYSTEM_PROMPT_LENGTH} characters.`,
      ),
    temperature: z
      .number()
      .min(0, "Temperature must be at least 0.")
      .max(2, "Temperature must be at most 2."),
    maxOutputTokens: z
      .number()
      .int("Output tokens must be a whole number.")
      .min(256, "Output tokens must be at least 256.")
      .max(16_384, "Output tokens must be at most 16384."),
    contextTokenBudget: z
      .number()
      .int("Context budget must be a whole number.")
      .positive("Context budget must be positive."),
    recentMessageBudget: z
      .number()
      .int("Recent message budget must be a whole number.")
      .nonnegative("Recent message budget cannot be negative."),
    memoryTokenBudget: z
      .number()
      .int("Memory budget must be a whole number.")
      .min(0, "Memory budget cannot be negative.")
      .max(8000, "Memory budget must be at most 8000."),
    // The read limit of the per-turn capsule (MC-121): it no longer funds a
    // derived narrative target — the cross-field rule below only requires it
    // to seat every section at its write cap, so raising it adds margin. The
    // upper bound (8000 before) fits the largest target at its cap beside the
    // largest snapshot and the summary at theirs.
    capsuleTokenBudget: z
      .number()
      .int("Capsule budget must be a whole number.")
      .min(1500, "Capsule budget must be at least 1500.")
      .max(24_000, "Capsule budget must be at most 24000."),
    // The normal size of the long-horizon narrative, in estimator tokens: the
    // figure its prompts state (MC-121), independent of the capsule.
    narrativeTargetTokens: z
      .number()
      .int("Narrative target must be a whole number.")
      .min(
        NARRATIVE_MIN_TARGET,
        `Narrative target must be at least ${NARRATIVE_MIN_TARGET}.`,
      )
      .max(12_000, "Narrative target must be at most 12000."),
    recentSnapshotTokenBudget: z
      .number()
      .int("Recent snapshot budget must be a whole number.")
      .positive("Recent snapshot budget must be positive.")
      .max(2000, "Recent snapshot budget must be at most 2000."),
    summaryTriggerTokens: z
      .number()
      .int("Summary threshold must be a whole number.")
      .positive("Summary threshold must be positive."),
    memoryRetrievalLimit: z
      .number()
      .int("Memory result limit must be a whole number.")
      .min(0, "Memory result limit cannot be negative.")
      .max(20, "Memory result limit must be at most 20."),
    webSearchEnabled: z.boolean(),
    toolsEnabled: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.contextTokenBudget < value.maxOutputTokens + 2000) {
      context.addIssue({
        code: "custom",
        message:
          "Context budget must be at least output tokens plus 2000.",
        path: ["contextTokenBudget"],
      });
    }
    if (value.recentMessageBudget >= value.contextTokenBudget) {
      context.addIssue({
        code: "custom",
        message: "Recent message budget must be less than context budget.",
        path: ["recentMessageBudget"],
      });
    }
    if (value.summaryTriggerTokens <= value.recentMessageBudget) {
      context.addIssue({
        code: "custom",
        message:
          "Summary threshold must be greater than recent message budget.",
        path: ["summaryTriggerTokens"],
      });
    }
    // The capsule must seat every section at its write cap (MC-121): refused
    // here, where the numbers are set, rather than as a trim at read time.
    const refusal = capsuleBudgetRefusal(value);
    if (refusal) {
      context.addIssue({
        code: "custom",
        message: refusal,
        path: ["capsuleTokenBudget"],
      });
    }
    // The chat window must seat a full unsummarized history beside the
    // capsule (MC-108): a turn may never fall out of the window before a
    // summary covers it. Only once the basic floor above holds, so one
    // field carries one message.
    const windowRefusal =
      value.contextTokenBudget < value.maxOutputTokens + 2000
        ? null
        : chatWindowRefusal(value);
    if (windowRefusal) {
      context.addIssue({
        code: "custom",
        message: windowRefusal,
        path: ["contextTokenBudget"],
      });
    }
  });

export type SettingsInput = z.infer<typeof settingsSchema>;
