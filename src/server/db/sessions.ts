import { desc, eq, isNull } from "drizzle-orm";

import type { SessionSummary, ThinkingEffort } from "@/shared/types";

import { getDatabase } from "./client";
import { sessions } from "./schema";
import { getSettings } from "./settings";

type SessionRow = typeof sessions.$inferSelect;

function toSummary(row: SessionRow): SessionSummary {
  return {
    id: row.id,
    title: row.title,
    modelId: row.modelId,
    thinkingEnabled: row.thinkingEnabled,
    thinkingEffort: row.thinkingEffort as ThinkingEffort,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listActiveSessions(): Promise<SessionSummary[]> {
  const rows = await getDatabase()
    .select()
    .from(sessions)
    .where(isNull(sessions.archivedAt))
    .orderBy(desc(sessions.updatedAt));

  return rows.map(toSummary);
}

export async function createSession(input: {
  title?: string;
  modelId?: string;
  thinkingEnabled?: boolean;
  thinkingEffort?: ThinkingEffort;
}): Promise<SessionSummary> {
  const defaults = await getSettings();
  const values: typeof sessions.$inferInsert = {
    modelId: input.modelId ?? defaults.defaultModelId,
  };
  if (input.title !== undefined) {
    values.title = input.title;
  }
  if (input.thinkingEnabled !== undefined) {
    values.thinkingEnabled = input.thinkingEnabled;
  }
  if (input.thinkingEffort !== undefined) {
    values.thinkingEffort = input.thinkingEffort;
  }

  const [row] = await getDatabase().insert(sessions).values(values).returning();
  return toSummary(row);
}

export async function updateSession(
  id: string,
  patch: {
    title?: string;
    modelId?: string;
    thinkingEnabled?: boolean;
    thinkingEffort?: ThinkingEffort;
    archived?: boolean;
  },
): Promise<SessionSummary | null> {
  const values: Partial<typeof sessions.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (patch.title !== undefined) {
    values.title = patch.title;
  }
  if (patch.modelId !== undefined) {
    values.modelId = patch.modelId;
  }
  if (patch.thinkingEnabled !== undefined) {
    values.thinkingEnabled = patch.thinkingEnabled;
  }
  if (patch.thinkingEffort !== undefined) {
    values.thinkingEffort = patch.thinkingEffort;
  }
  if (patch.archived !== undefined) {
    values.archivedAt = patch.archived ? new Date() : null;
  }

  const [row] = await getDatabase()
    .update(sessions)
    .set(values)
    .where(eq(sessions.id, id))
    .returning();

  return row ? toSummary(row) : null;
}

export async function deleteSession(id: string): Promise<boolean> {
  const rows = await getDatabase()
    .delete(sessions)
    .where(eq(sessions.id, id))
    .returning({ id: sessions.id });

  return rows.length > 0;
}

export async function sessionExists(id: string): Promise<boolean> {
  const [row] = await getDatabase()
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.id, id))
    .limit(1);

  return Boolean(row);
}
