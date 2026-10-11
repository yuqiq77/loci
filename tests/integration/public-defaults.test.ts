import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

describeWithDatabase("public defaults", () => {
  const connection = postgres(testDatabaseUrl!, { max: 1, prepare: false });
  const database = drizzle(connection);

  beforeAll(async () => {
    await migrate(database, { migrationsFolder: "drizzle" });
  });

  afterAll(async () => {
    await connection.end();
  });

  it("enables client tools for newly inserted settings rows", async () => {
    const [column] = await connection<
      { column_default: string | null; is_nullable: string }[]
    >`
      select column_default, is_nullable
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'settings'
        and column_name = 'tools_enabled'
    `;

    expect(column).toEqual({ column_default: "true", is_nullable: "NO" });
  });
});
