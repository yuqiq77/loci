import { randomUUID } from "node:crypto";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";

import {
  beginGeneration,
  completeGeneration,
  discardGeneration,
  type GenerationStart,
} from "@/server/db/chat";
import { closeDatabase, getDatabase } from "@/server/db/client";
import {
  assistantTurnUsedTools,
  commitToolRuns,
  databaseToolRunRecorder,
  listToolRunsForAttempt,
  retractToolRuns,
} from "@/server/db/tool-runs";
import { loadExtractionWindowForTests } from "@/server/memory/extract";
import {
  loadIncrementalNarrativeSourcesForReplay,
} from "@/server/summaries/consolidate-narrative";
import { diaryDayWindow, loadDiaryDayTurns } from "@/server/summaries/diary";
import {
  computeRecentSnapshotWindow,
  loadRecentSnapshotInputsForTests,
} from "@/server/summaries/recent-snapshot";
import { loadSummaryStateForTests } from "@/server/summaries/summarize";
import { resetServerEnvForTests } from "@/server/env";
import { STALE_STREAMING_MS } from "@/shared/chat";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

describeWithDatabase("tool_runs lifecycle", () => {
  const connection = postgres(testDatabaseUrl!, { max: 1, prepare: false });
  const database = drizzle(connection);
  const sessionIds: string[] = [];

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    resetServerEnvForTests();
    await migrate(database, { migrationsFolder: "drizzle" });
  });

  afterEach(async () => {
    if (sessionIds.length > 0) {
      await connection`
        delete from sessions where id in ${connection(sessionIds)}
      `;
      sessionIds.length = 0;
    }
  });

  afterAll(async () => {
    await closeDatabase();
    await connection.end();
  });

  async function createSession(modelId = "claude-opus-4-6") {
    const [session] = await connection<{ id: string }[]>`
      insert into sessions (model_id) values (${modelId}) returning id
    `;
    sessionIds.push(session.id);
    return session.id;
  }

  async function begin(input: {
    sessionId: string;
    content: string;
    retryOfMessageId?: string;
    now?: Date;
  }): Promise<GenerationStart> {
    const result = await beginGeneration({
      attemptId: randomUUID(),
      ...input,
    });
    expect(result.kind).toBe("started");
    if (result.kind !== "started") {
      throw new Error("generation did not start");
    }
    return result.generation;
  }

  async function recordRun(
    generation: GenerationStart,
    sessionId: string,
    overrides: { providerToolUseId?: string; callIndex?: number } = {},
  ): Promise<string> {
    const runId = await databaseToolRunRecorder.start({
      attemptId: generation.attemptId,
      sessionId,
      assistantMessageId: generation.assistantMessageId,
      roundIndex: 0,
      callIndex: overrides.callIndex ?? 0,
      providerToolUseId: overrides.providerToolUseId ?? `tu-${randomUUID()}`,
      toolName: "echo_test",
      toolSchemaHash: "a".repeat(64),
      input: { text: "ping" },
      precedingText: "pre-tool prose",
      startedAt: new Date(),
    });
    await databaseToolRunRecorder.finish(runId, {
      resultContent: "echo: ping",
      isError: false,
      errorCode: null,
      finishedAt: new Date(),
    });
    return runId;
  }

  it("commits staged runs with completeGeneration and answers the echo marker", async () => {
    const sessionId = await createSession();
    const generation = await begin({ sessionId, content: "Hello" });
    await recordRun(generation, sessionId);

    await completeGeneration({
      assistantMessageId: generation.assistantMessageId,
      content: "Final.",
      attemptId: generation.attemptId,
    });

    const runs = await listToolRunsForAttempt(generation.attemptId);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("committed");
    expect(runs[0].resultContent).toBe("echo: ping");
    await expect(
      assistantTurnUsedTools(generation.assistantMessageId),
    ).resolves.toBe(true);
    await expect(assistantTurnUsedTools(randomUUID())).resolves.toBe(false);
  });

  it("retracts staged runs atomically with discardGeneration", async () => {
    const sessionId = await createSession();
    const generation = await begin({ sessionId, content: "Hello" });
    await recordRun(generation, sessionId);

    await discardGeneration({
      userMessageId: generation.userMessageId,
      assistantMessageId: generation.assistantMessageId,
      attemptId: generation.attemptId,
    });

    const runs = await listToolRunsForAttempt(generation.attemptId);
    expect(runs.map((run) => run.status)).toEqual(["retracted"]);
    const [pair] = await connection<{ count: string }[]>`
      select count(*) as count from messages
      where id in (${generation.userMessageId}, ${generation.assistantMessageId})
    `;
    expect(Number(pair.count)).toBe(0);
  });

  it("never marks committed runs retracted on a lost completion ACK", async () => {
    const sessionId = await createSession();
    const generation = await begin({ sessionId, content: "Hello" });
    await recordRun(generation, sessionId);

    await completeGeneration({
      assistantMessageId: generation.assistantMessageId,
      content: "Final.",
      attemptId: generation.attemptId,
    });
    // A retraction arriving after the commit (lost ACK, stray retry) is an
    // idempotent no-op: the transition derives from commit state.
    await retractToolRuns(getDatabase(), generation.attemptId);

    const runs = await listToolRunsForAttempt(generation.attemptId);
    expect(runs.map((run) => run.status)).toEqual(["committed"]);
    // And a duplicate commit is equally idempotent.
    await commitToolRuns(getDatabase(), generation.attemptId);
    expect(
      (await listToolRunsForAttempt(generation.attemptId)).map(
        (run) => run.status,
      ),
    ).toEqual(["committed"]);
  });

  it("flags a rewritten pair's runs superseded and commits the replacement's", async () => {
    const sessionId = await createSession();
    const first = await begin({ sessionId, content: "Original" });
    await recordRun(first, sessionId);
    await completeGeneration({
      assistantMessageId: first.assistantMessageId,
      content: "Original answer.",
      attemptId: first.attemptId,
    });

    const rewrite = await begin({
      sessionId,
      content: "Rewritten",
      retryOfMessageId: first.userMessageId,
    });
    await recordRun(rewrite, sessionId);
    await completeGeneration({
      assistantMessageId: rewrite.assistantMessageId,
      content: "Rewritten answer.",
      attemptId: rewrite.attemptId,
      supersede: {
        sessionId,
        userMessageId: first.userMessageId,
        assistantMessageId: first.assistantMessageId,
        replacementUserMessageId: rewrite.userMessageId,
      },
    });

    expect(
      (await listToolRunsForAttempt(first.attemptId)).map((run) => run.status),
    ).toEqual(["superseded"]);
    expect(
      (await listToolRunsForAttempt(rewrite.attemptId)).map(
        (run) => run.status,
      ),
    ).toEqual(["committed"]);
  });

  it("retracts a swept stale pair's staged runs in the debris sweep", async () => {
    const sessionId = await createSession();
    const now = new Date();
    const staleAt = new Date(now.getTime() - STALE_STREAMING_MS - 1000);
    const [staleAssistant] = await connection<{ id: string }[]>`
      insert into messages (session_id, role, content, status, created_at)
      values (${sessionId}, 'assistant', '', 'streaming',
        ${staleAt.toISOString()}::timestamptz)
      returning id
    `;
    const deadAttemptId = randomUUID();
    await databaseToolRunRecorder.start({
      attemptId: deadAttemptId,
      sessionId,
      assistantMessageId: staleAssistant.id,
      roundIndex: 0,
      callIndex: 0,
      providerToolUseId: "tu-dead",
      toolName: "echo_test",
      toolSchemaHash: null,
      input: { text: "lost" },
      precedingText: null,
      startedAt: staleAt,
    });

    await begin({ sessionId, content: "New message", now });

    const runs = await listToolRunsForAttempt(deadAttemptId);
    expect(runs.map((run) => run.status)).toEqual(["retracted"]);
  });

  it("purges expired run bodies but keeps ids, statuses, and timings", async () => {
    const sessionId = await createSession();
    const generation = await begin({ sessionId, content: "Hello" });
    const runId = await recordRun(generation, sessionId);
    await completeGeneration({
      assistantMessageId: generation.assistantMessageId,
      content: "Final.",
      attemptId: generation.attemptId,
    });
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await connection`
      update tool_runs set created_at = ${old.toISOString()}::timestamptz
      where id = ${runId}
    `;

    await begin({ sessionId, content: "Next turn" });

    const [run] = await listToolRunsForAttempt(generation.attemptId);
    expect(run.input).toBeNull();
    expect(run.resultContent).toBeNull();
    expect(run.precedingText).toBeNull();
    expect(run.purgedAt).not.toBeNull();
    expect(run.status).toBe("committed");
    expect(run.toolSchemaHash).toBe("a".repeat(64));
    expect(run.startedAt).not.toBeNull();
    expect(run.finishedAt).not.toBeNull();
  });

  // Retention is lazy and session-scoped (the documented behavior): another
  // session's send does not purge, so a dormant session keeps its expired
  // bodies until its own next beginGeneration.
  it("keeps a dormant session's expired bodies until that session's next beginGeneration", async () => {
    const dormantSessionId = await createSession();
    const generation = await begin({
      sessionId: dormantSessionId,
      content: "Hello",
    });
    const runId = await recordRun(generation, dormantSessionId);
    await completeGeneration({
      assistantMessageId: generation.assistantMessageId,
      content: "Final.",
      attemptId: generation.attemptId,
    });
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await connection`
      update tool_runs set created_at = ${old.toISOString()}::timestamptz
      where id = ${runId}
    `;

    await begin({ sessionId: await createSession(), content: "Elsewhere" });

    const [kept] = await listToolRunsForAttempt(generation.attemptId);
    expect(kept.purgedAt).toBeNull();
    expect(kept.input).toEqual({ text: "ping" });
    expect(kept.resultContent).toBe("echo: ping");
    expect(kept.precedingText).toBe("pre-tool prose");

    await begin({ sessionId: dormantSessionId, content: "Back again" });

    const [purged] = await listToolRunsForAttempt(generation.attemptId);
    expect(purged.purgedAt).not.toBeNull();
    expect(purged.input).toBeNull();
    expect(purged.resultContent).toBeNull();
    expect(purged.precedingText).toBeNull();
  });

  it("snapshots the tools_enabled gate at beginGeneration", async () => {
    const sessionId = await createSession();
    // The gate's environment half needs a configured embedding provider.
    process.env.EMBEDDING_API_KEY = "test";
    process.env.EMBEDDING_BASE_URL = "https://embedding.example.com";
    process.env.EMBEDDING_MODEL = "test-model";
    process.env.EMBEDDING_DIMENSIONS = "1536";
    resetServerEnvForTests();
    let initial: boolean | null = null;
    try {
      // The snapshot follows the setting as it stands — the private line
      // ships tools off, the public snapshot ships them on — and flips
      // with it; the test must not assume either default.
      [{ tools_enabled: initial }] = await connection<
        { tools_enabled: boolean }[]
      >`select tools_enabled from settings where id = 1`;
      const namesFor = (enabled: boolean) =>
        enabled ? ["search_memory"] : [];
      const first = await begin({ sessionId, content: "first state" });
      expect(first.enabledToolNames).toEqual(namesFor(initial));
      await discardGeneration({
        userMessageId: first.userMessageId,
        assistantMessageId: first.assistantMessageId,
      });

      await connection`update settings set tools_enabled = ${!initial} where id = 1`;
      const second = await begin({ sessionId, content: "second state" });
      expect(second.enabledToolNames).toEqual(namesFor(!initial));
    } finally {
      if (initial !== null) {
        await connection`update settings set tools_enabled = ${initial} where id = 1`;
      }
      delete process.env.EMBEDDING_API_KEY;
      delete process.env.EMBEDDING_BASE_URL;
      delete process.env.EMBEDDING_MODEL;
      delete process.env.EMBEDDING_DIMENSIONS;
      resetServerEnvForTests();
    }
  });

  it("rejects a duplicate provider tool_use id within one attempt", async () => {
    const sessionId = await createSession();
    const generation = await begin({ sessionId, content: "Hello" });
    await recordRun(generation, sessionId, { providerToolUseId: "tu-dup" });
    await expect(
      recordRun(generation, sessionId, {
        providerToolUseId: "tu-dup",
        callIndex: 1,
      }),
    ).rejects.toThrow();
  });
});

describeWithDatabase("continuity reader isolation", () => {
  const connection = postgres(testDatabaseUrl!, { max: 1, prepare: false });
  const database = drizzle(connection);
  const sessionIds: string[] = [];

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    resetServerEnvForTests();
    await migrate(database, { migrationsFolder: "drizzle" });
  });

  afterEach(async () => {
    if (sessionIds.length > 0) {
      await connection`
        delete from sessions where id in ${connection(sessionIds)}
      `;
      sessionIds.length = 0;
    }
  });

  afterAll(async () => {
    await closeDatabase();
    await connection.end();
  });

  it("keeps all five reader projections byte-identical when tool_runs rows appear", async () => {
    // One durable message fixture, frozen clock and windows.
    const frozenNow = new Date("2026-08-24T12:00:00Z");
    const turnAt = new Date("2026-08-24T10:00:00Z");
    const [session] = await connection<{ id: string }[]>`
      insert into sessions (model_id) values ('claude-opus-4-6') returning id
    `;
    sessionIds.push(session.id);
    for (const [role, content, offset] of [
      ["user", "How was the day?", 0],
      ["assistant", "Quiet and good.", 1],
    ] as const) {
      await connection`
        insert into messages (
          session_id, role, content, status, created_at, completed_at
        )
        values (
          ${session.id}, ${role}, ${content}, 'complete',
          ${new Date(turnAt.getTime() + offset).toISOString()}::timestamptz,
          ${new Date(turnAt.getTime() + offset).toISOString()}::timestamptz
        )
      `;
    }
    const watermark = new Date("2026-08-20T00:00:00Z");
    const snapshotWindow = computeRecentSnapshotWindow(null, frozenNow);
    const diaryWindow = diaryDayWindow("2026-08-24");

    const capture = async () =>
      JSON.stringify({
        summary: await loadSummaryStateForTests(session.id),
        extraction: await loadExtractionWindowForTests(session.id),
        snapshot: await loadRecentSnapshotInputsForTests(snapshotWindow),
        consolidation: await loadIncrementalNarrativeSourcesForReplay({
          watermark,
          sourceThrough: frozenNow,
          rawBudget: 72_000,
        }),
        diary: await loadDiaryDayTurns(diaryWindow),
      });

    const before = await capture();

    // Insert tool_runs rows only — messages untouched.
    const [assistantRow] = await connection<{ id: string }[]>`
      select id from messages
      where session_id = ${session.id} and role = 'assistant'
    `;
    for (const [status, toolUseId] of [
      ["committed", "tu-1"],
      ["retracted", "tu-2"],
      ["superseded", "tu-3"],
      ["staged", "tu-4"],
    ] as const) {
      await connection`
        insert into tool_runs (
          attempt_id, session_id, assistant_message_id, round_index,
          call_index, provider_tool_use_id, tool_name, input, result_content,
          preceding_text, status, started_at, finished_at
        )
        values (
          ${randomUUID()}, ${session.id}, ${assistantRow.id}, 0, 0,
          ${toolUseId}, 'echo_test', ${JSON.stringify({ text: "q" })}::jsonb,
          'echo: a tool result that must stay invisible',
          'pre-tool prose that must stay invisible', ${status},
          ${turnAt.toISOString()}::timestamptz,
          ${turnAt.toISOString()}::timestamptz
        )
      `;
    }

    const after = await capture();
    expect(after).toBe(before);
  });
});
