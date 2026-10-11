import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase } from "@/server/db/client";
import {
  getSettings,
  updateSettings,
} from "@/server/db/settings";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

describeWithDatabase("settings persistence", () => {
  const connection = postgres(testDatabaseUrl!, { max: 1, prepare: false });
  const database = drizzle(connection);

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    await migrate(database, { migrationsFolder: "drizzle" });
  });

  afterAll(async () => {
    await connection`
      update settings
      set system_prompt = 'You are a thoughtful, helpful private AI assistant.',
          temperature = 0.7,
          capsule_token_budget = 12000,
          narrative_target_tokens = 6400,
          recent_snapshot_token_budget = 400,
          web_search_enabled = true
      where id = 1
    `;
    await closeDatabase();
    await connection.end();
  });

  it("updates only the singleton row and persists new values", async () => {
    const before = await getSettings();
    const updated = await updateSettings({
      systemPrompt: "Persisted settings prompt.",
      temperature: 0.3,
      capsuleTokenBudget: 1500,
      narrativeTargetTokens: 5000,
      recentSnapshotTokenBudget: 240,
      webSearchEnabled: false,
    });

    expect(updated).toMatchObject({
      id: 1,
      systemPrompt: "Persisted settings prompt.",
      temperature: 0.3,
      capsuleTokenBudget: 1500,
      narrativeTargetTokens: 5000,
      recentSnapshotTokenBudget: 240,
      webSearchEnabled: false,
    });
    expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(
      before.updatedAt.getTime(),
    );
    const [count] = await connection<{ count: number }[]>`
      select count(*)::int as count from settings
    `;
    expect(count.count).toBe(1);
    await expect(getSettings()).resolves.toMatchObject({
      systemPrompt: "Persisted settings prompt.",
      webSearchEnabled: false,
    });
  });
});
