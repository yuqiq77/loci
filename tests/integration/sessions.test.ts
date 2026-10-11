import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

describeWithDatabase("session and message persistence", () => {
  const connection = postgres(testDatabaseUrl!, { max: 1, prepare: false });
  const database = drizzle(connection);

  beforeAll(async () => {
    await migrate(database, { migrationsFolder: "drizzle" });
  });

  afterAll(async () => {
    await connection.end();
  });

  it("creates, lists, renames, archives, and deletes with cascade", async () => {
    const [session] = await connection<{ id: string }[]>`
      insert into sessions (model_id) values ('default') returning id
    `;
    const sessionId = session.id;

    await connection`
      insert into messages (session_id, role, content, status, created_at)
      values
        (${sessionId}, 'user', 'first', 'complete', '2026-01-01T00:00:00Z'),
        (${sessionId}, 'assistant', 'second', 'failed', '2026-01-01T00:00:01Z')
    `;

    const ordered = await connection<{ content: string }[]>`
      select content from messages
      where session_id = ${sessionId}
      order by created_at asc, id asc
    `;
    expect(ordered.map((row) => row.content)).toEqual(["first", "second"]);

    await connection`
      update sessions set title = 'Renamed' where id = ${sessionId}
    `;
    const [renamed] = await connection<{ title: string }[]>`
      select title from sessions where id = ${sessionId}
    `;
    expect(renamed.title).toBe("Renamed");

    await connection`
      update sessions set archived_at = now() where id = ${sessionId}
    `;
    const active = await connection<{ id: string }[]>`
      select id from sessions where id = ${sessionId} and archived_at is null
    `;
    expect(active).toHaveLength(0);

    await connection`delete from sessions where id = ${sessionId}`;
    const remainingMessages = await connection<{ id: string }[]>`
      select id from messages where session_id = ${sessionId}
    `;
    expect(remainingMessages).toHaveLength(0);
  });
});
