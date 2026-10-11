import { eq } from "drizzle-orm";

import { getDatabase } from "./client";
import { settings } from "./schema";

export async function getSettings() {
  const [row] = await getDatabase()
    .select()
    .from(settings)
    .where(eq(settings.id, 1))
    .limit(1);

  return row;
}

export async function updateSettings(
  patch: Partial<
    Pick<
      typeof settings.$inferSelect,
      | "systemPrompt"
      | "standingContext"
      | "temperature"
      | "maxOutputTokens"
      | "contextTokenBudget"
      | "recentMessageBudget"
      | "memoryTokenBudget"
      | "capsuleTokenBudget"
      | "narrativeTargetTokens"
      | "recentSnapshotTokenBudget"
      | "summaryTriggerTokens"
      | "memoryRetrievalLimit"
      | "webSearchEnabled"
      | "toolsEnabled"
    >
  >,
) {
  const [row] = await getDatabase()
    .update(settings)
    .set({
      ...patch,
      updatedAt: new Date(),
    })
    .where(eq(settings.id, 1))
    .returning();

  return row ?? null;
}
