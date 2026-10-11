import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const provider = vi.hoisted(() => ({
  stream: vi.fn(),
  countTokens: vi.fn(),
}));

vi.mock("@/server/chat/anthropic", () => ({
  getCompressionProvider: () => provider,
  getExtractionProvider: () => provider,
}));
vi.mock("@/server/env", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/env")>();
  return {
    ...original,
    getCompressionEnv: () => ({
      COMPRESSION_API_KEY: "test",
      COMPRESSION_BASE_URL: "https://api.anthropic.com",
      COMPRESSION_MODEL: "compression-test",
    }),
    getExtractionEnv: () => ({
      EXTRACTION_API_KEY: "test",
      EXTRACTION_BASE_URL: "https://api.anthropic.com",
      EXTRACTION_MODEL: "compression-test",
    }),
  };
});

import { closeDatabase } from "@/server/db/client";
import { enqueueJob } from "@/server/db/jobs";
import { resetServerEnvForTests } from "@/server/env";
import { runNextJob } from "@/server/jobs/worker";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

describeWithDatabase("session title jobs", () => {
  const connection = postgres(testDatabaseUrl!, { max: 5, prepare: false });
  const database = drizzle(connection);
  const sessionIds: string[] = [];

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    resetServerEnvForTests();
    await migrate(database, { migrationsFolder: "drizzle" });
  });

  beforeEach(async () => {
    await connection`delete from jobs where type = 'title_session'`;
    provider.stream.mockImplementation(async function* () {
      yield { type: "text", text: "Weekend camping plan" };
      yield { type: "done", finishReason: "end_turn" };
    });
  });

  afterEach(async () => {
    await connection`delete from jobs where type = 'title_session'`;
    if (sessionIds.length > 0) {
      await connection`
        delete from sessions where id in ${connection(sessionIds)}
      `;
      sessionIds.length = 0;
    }
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await closeDatabase();
    await connection.end();
  });

  async function createSession() {
    const [session] = await connection<{ id: string }[]>`
      insert into sessions (model_id) values ('default') returning id
    `;
    sessionIds.push(session.id);
    return session.id;
  }

  async function insertExchange(
    sessionId: string,
    rows: { role: string; content: string; status?: string }[],
  ) {
    for (const [index, row] of rows.entries()) {
      await connection`
        insert into messages (
          session_id, role, content, status, model_id, completed_at, created_at
        )
        values (
          ${sessionId}, ${row.role}, ${row.content},
          ${row.status ?? "complete"}, 'default', now(),
          ${new Date(Date.UTC(2026, 5, 15, 12, 0, index)).toISOString()}::timestamptz
        )
      `;
    }
  }

  async function sessionTitle(sessionId: string) {
    const [session] = await connection<{ title: string }[]>`
      select title from sessions where id = ${sessionId}
    `;
    return session.title;
  }

  it("titles a session once from its first exchange and dedupes", async () => {
    const sessionId = await createSession();
    await insertExchange(sessionId, [
      { role: "user", content: "帮我规划周末的露营" },
      { role: "assistant", content: "好,我们先看天气。" },
    ]);
    provider.stream.mockImplementation(async function* () {
      yield { type: "text", text: '\n "Weekend  camping\nplan" ' };
      yield { type: "done", finishReason: "end_turn" };
    });

    const enqueued = await Promise.all([
      enqueueJob("title_session", { sessionId }),
      enqueueJob("title_session", { sessionId }),
    ]);
    expect(enqueued.filter(Boolean)).toHaveLength(1);

    expect(await runNextJob()).toBe(true);

    expect(await sessionTitle(sessionId)).toBe("Weekend camping plan");
    const [job] = await connection<{ status: string }[]>`
      select status from jobs where type = 'title_session'
    `;
    expect(job.status).toBe("complete");
    expect(provider.stream).toHaveBeenCalledTimes(1);
  });

  it("pairs only adjacent completed messages when picking the exchange", async () => {
    const sessionId = await createSession();
    await insertExchange(sessionId, [
      { role: "user", content: "First try that was cancelled" },
      { role: "assistant", content: "half a reply", status: "cancelled" },
      { role: "user", content: "Second try" },
      { role: "assistant", content: "Full reply." },
    ]);

    await enqueueJob("title_session", { sessionId });
    expect(await runNextJob()).toBe(true);

    const request = provider.stream.mock.calls[0][0] as {
      messages: { content: string }[];
    };
    expect(request.messages[0].content).toContain("USER: Second try");
    expect(request.messages[0].content).not.toContain("First try");
  });

  it("lets a manual rename that lands mid-job win without failing the job", async () => {
    const sessionId = await createSession();
    await insertExchange(sessionId, [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there." },
    ]);
    // The rename lands after the job has read the still-default session but
    // before it writes: the conditional update must no-op successfully.
    provider.stream.mockImplementation(async function* () {
      await connection`
        update sessions set title = 'Manual title' where id = ${sessionId}
      `;
      yield { type: "text", text: "Generated title" };
      yield { type: "done", finishReason: "end_turn" };
    });

    await enqueueJob("title_session", { sessionId });
    expect(await runNextJob()).toBe(true);

    expect(await sessionTitle(sessionId)).toBe("Manual title");
    const [job] = await connection<{ status: string }[]>`
      select status from jobs where type = 'title_session'
    `;
    expect(job.status).toBe("complete");
  });

  it("no-ops without a model call when the title is already custom", async () => {
    const sessionId = await createSession();
    await insertExchange(sessionId, [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there." },
    ]);
    await connection`
      update sessions set title = 'Renamed first' where id = ${sessionId}
    `;

    await enqueueJob("title_session", { sessionId });
    expect(await runNextJob()).toBe(true);

    expect(await sessionTitle(sessionId)).toBe("Renamed first");
    expect(provider.stream).not.toHaveBeenCalled();
    const [job] = await connection<{ status: string }[]>`
      select status from jobs where type = 'title_session'
    `;
    expect(job.status).toBe("complete");
  });

  it("no-ops when the session has no completed exchange yet", async () => {
    const sessionId = await createSession();
    await insertExchange(sessionId, [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "half a reply", status: "cancelled" },
    ]);

    await enqueueJob("title_session", { sessionId });
    expect(await runNextJob()).toBe(true);

    expect(await sessionTitle(sessionId)).toBe("New chat");
    expect(provider.stream).not.toHaveBeenCalled();
  });

  it("leaves the default title and the job pending retry when the provider fails", async () => {
    const sessionId = await createSession();
    await insertExchange(sessionId, [
      { role: "user", content: "测试一下session自动命名能不能成功" },
      { role: "assistant", content: "Hi there." },
    ]);
    provider.stream.mockImplementation(async function* () {
      throw new Error("title provider failed");
    });

    await enqueueJob("title_session", { sessionId });
    expect(await runNextJob()).toBe(true);

    expect(await sessionTitle(sessionId)).toBe("New chat");
    const [job] = await connection<
      { status: string; attempts: number; last_error: string }[]
    >`
      select status, attempts, last_error from jobs
      where type = 'title_session'
    `;
    expect(job).toMatchObject({
      status: "pending",
      attempts: 1,
      last_error: "title provider failed",
    });
  });

  it("leaves the default title and fails the row when generation hits max tokens (MC-118)", async () => {
    const sessionId = await createSession();
    await insertExchange(sessionId, [
      { role: "user", content: "测试一下session自动命名能不能成功" },
      { role: "assistant", content: "可以,我们试一下。" },
    ]);
    provider.stream.mockImplementation(async function* () {
      yield { type: "text", text: "This title response ignored the instruction" };
      yield { type: "done", finishReason: "max_tokens" };
    });

    await enqueueJob("title_session", { sessionId });
    expect(await runNextJob()).toBe(true);

    expect(await sessionTitle(sessionId)).toBe("New chat");
    const [job] = await connection<
      { status: string; attempts: number; last_error: string }[]
    >`
      select status, attempts, last_error from jobs
      where type = 'title_session'
    `;
    // A model-output termination is never re-sent unchanged: the single
    // candidate is exhausted, so the row fails on its first attempt with
    // the termination record.
    expect(job).toMatchObject({
      status: "failed",
      attempts: 1,
    });
    expect(job.last_error).toContain("finish reason: max_tokens");
    expect(job.last_error).toContain("[stage=title model=compression-test");
  });

  it("retries instead of writing a generated title equal to the default", async () => {
    const sessionId = await createSession();
    await insertExchange(sessionId, [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there." },
    ]);
    provider.stream.mockImplementation(async function* () {
      yield { type: "text", text: '"New chat"' };
      yield { type: "done", finishReason: "end_turn" };
    });

    await enqueueJob("title_session", { sessionId });
    expect(await runNextJob()).toBe(true);

    expect(await sessionTitle(sessionId)).toBe("New chat");
    const [job] = await connection<
      { status: string; last_error: string }[]
    >`
      select status, last_error from jobs where type = 'title_session'
    `;
    expect(job).toMatchObject({
      status: "pending",
      last_error: "Compression model returned an unusable title.",
    });
  });

  it("finds the first completed exchange behind many cancelled turns", async () => {
    const sessionId = await createSession();
    const cancelledTurns = Array.from({ length: 25 }, (_, index) => [
      { role: "user", content: `Cancelled try ${index}` },
      { role: "assistant", content: "half a reply", status: "cancelled" },
    ]).flat();
    await insertExchange(sessionId, [
      ...cancelledTurns,
      { role: "user", content: "帮我规划周末的露营" },
      { role: "assistant", content: "好,我们先看天气。" },
    ]);

    await enqueueJob("title_session", { sessionId });
    expect(await runNextJob()).toBe(true);

    expect(await sessionTitle(sessionId)).toBe("Weekend camping plan");
    const request = provider.stream.mock.calls[0][0] as {
      messages: { content: string }[];
    };
    expect(request.messages[0].content).toContain("USER: 帮我规划周末的露营");
    expect(request.messages[0].content).not.toContain("Cancelled try");
  });
});
