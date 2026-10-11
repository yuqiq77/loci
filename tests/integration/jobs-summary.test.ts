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

import { completeGeneration, loadCompleteHistory } from "@/server/db/chat";
import { closeDatabase } from "@/server/db/client";
import {
  buildChatContext,
  buildContinuityCapsule,
  formatContextStamp,
  formatLocalDay,
} from "@/server/chat/context";
import {
  claimNextJob,
  enqueueJob,
  recoverStaleJobs,
  retryOrFailJob,
} from "@/server/db/jobs";
import { getRecentSnapshot } from "@/server/db/recent-snapshot";
import { resetServerEnvForTests } from "@/server/env";
import {
  shouldEnqueueRecentSnapshot,
  SNAPSHOT_MIN_INTERVAL_MS,
} from "@/server/jobs/continuity";
import {
  enqueueSummaryIfNeeded,
} from "@/server/summaries/summarize";
import { COMPRESSION_MAX_OUTPUT_TOKENS } from "@/server/summaries/compression";
import { runNextJob } from "@/server/jobs/worker";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

describeWithDatabase("summary jobs", () => {
  const connection = postgres(testDatabaseUrl!, { max: 5, prepare: false });
  const database = drizzle(connection);
  const sessionIds: string[] = [];
  const memoryIds: string[] = [];

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    resetServerEnvForTests();
    await migrate(database, { migrationsFolder: "drizzle" });
  });

  beforeEach(async () => {
    await connection`
      delete from jobs
      where type in ('summarize_session', 'update_recent_snapshot')
    `;
    provider.countTokens.mockImplementation(async (request: {
      messages: { content: string }[];
    }) =>
      request.messages
        .map((message: { content: string }) => message.content)
        .join("\n\n").length,
    );
    provider.stream.mockImplementation(async function* () {
      yield { type: "text", text: "Cumulative summary" };
      yield { type: "done", finishReason: "end_turn" };
    });
  });

  afterEach(async () => {
    await connection`
      delete from jobs
      where type in ('summarize_session', 'update_recent_snapshot')
    `;
    await connection`delete from recent_continuity_snapshot`;
    if (memoryIds.length > 0) {
      await connection`
        delete from memories where id in ${connection(memoryIds)}
      `;
      memoryIds.length = 0;
    }
    if (sessionIds.length > 0) {
      await connection`
        delete from sessions where id in ${connection(sessionIds)}
      `;
      sessionIds.length = 0;
    }
    await connection`
      update settings
      set recent_message_budget = 16000,
          capsule_token_budget = 2000,
          recent_snapshot_token_budget = 400,
          summary_trigger_tokens = 20000
      where id = 1
    `;
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

  async function insertConversation(sessionId: string) {
    const rows: { id: string }[] = [];
    for (let index = 0; index < 6; index += 1) {
      const role = index % 2 === 0 ? "user" : "assistant";
      const [row] = await connection<{ id: string }[]>`
        insert into messages (
          session_id, role, content, status, model_id, completed_at, created_at
        )
        values (
          ${sessionId}, ${role}, ${String(index).repeat(30)}, 'complete',
          'default', now(),
          ${`2026-06-15T12:00:0${index}Z`}::timestamptz
        )
        returning id
      `;
      rows.push(row);
    }
    return rows;
  }

  async function insertMemory(input: {
    content: string;
    kind: string;
    importance: number;
    resolved?: boolean;
    updatedAt?: string;
  }) {
    const [memory] = await connection<{ id: string }[]>`
      insert into memories (
        content, kind, importance, resolved, content_hash, updated_at
      )
      values (
        ${input.content},
        ${input.kind},
        ${input.importance},
        ${input.resolved ?? true},
        ${`snapshot-${Date.now()}-${Math.random()}`},
        ${input.updatedAt ?? new Date().toISOString()}::timestamptz
      )
      returning id
    `;
    memoryIds.push(memory.id);
    return memory.id;
  }

  function mockProviderText(...texts: string[]) {
    let index = 0;
    provider.stream.mockImplementation(async function* () {
      const text = texts[Math.min(index, texts.length - 1)];
      index += 1;
      yield { type: "text", text };
      yield { type: "done", finishReason: "end_turn" };
    });
  }

  it("deduplicates active jobs and claims a job only once", async () => {
    const sessionId = await createSession();
    const enqueued = await Promise.all([
      enqueueJob("summarize_session", { sessionId }),
      enqueueJob("summarize_session", { sessionId }),
    ]);

    expect(enqueued.filter(Boolean)).toHaveLength(1);

    const claimed = await Promise.all([claimNextJob(), claimNextJob()]);
    expect(claimed.filter(Boolean)).toHaveLength(1);
    const claimedJob = claimed.find(Boolean);
    expect(claimedJob).toMatchObject({
      type: "summarize_session",
      attempts: 1,
    });
    const [running] = await connection<{ locked: boolean }[]>`
      select locked_at is not null as locked
      from jobs
      where id = ${claimedJob!.id}
    `;
    expect(running.locked).toBe(true);
  });

  it("deduplicates active recent snapshot jobs globally", async () => {
    const enqueued = await Promise.all([
      enqueueJob("update_recent_snapshot", {}),
      enqueueJob("update_recent_snapshot", {}),
    ]);

    expect(enqueued.filter(Boolean)).toHaveLength(1);
  });

  it("recovers a stale running lease at startup", async () => {
    const sessionId = await createSession();
    await connection`
      insert into jobs (type, payload, status, locked_at)
      values (
        'summarize_session',
        ${JSON.stringify({ sessionId })}::jsonb,
        'running',
        now() - interval '16 minutes'
      )
    `;

    expect(await recoverStaleJobs()).toBe(1);
    const [job] = await connection<
      { status: string; locked_at: Date | null }[]
    >`select status, locked_at from jobs`;
    expect(job.status).toBe("pending");
    expect(job.locked_at).toBeNull();
  });

  it("schedules retries and marks the third failed attempt terminal", async () => {
    const sessionId = await createSession();
    await enqueueJob("summarize_session", { sessionId });
    const first = await claimNextJob(new Date("2100-01-01T00:00:00Z"));
    await retryOrFailJob({
      id: first!.id,
      attempts: first!.attempts,
      error: "ProviderError",
      now: new Date("2026-06-15T12:00:00Z"),
    });
    const [retry] = await connection<
      { status: string; available_at: Date }[]
    >`select status, available_at from jobs where id = ${first!.id}`;
    expect(retry.status).toBe("pending");
    // Slow background backoff (MC-118 scope 5): +1m after the first call.
    expect(new Date(String(retry.available_at)).toISOString()).toBe(
      "2026-06-15T12:01:00.000Z",
    );

    await connection`
      update jobs set status = 'running', attempts = 3 where id = ${first!.id}
    `;
    await retryOrFailJob({
      id: first!.id,
      attempts: 3,
      error: "ProviderError",
      now: new Date("2026-06-15T12:01:00Z"),
    });
    const [failed] = await connection<
      { status: string; completed_at: Date }[]
    >`select status, completed_at from jobs where id = ${first!.id}`;
    expect(failed.status).toBe("failed");
    expect(failed.completed_at).toBeTruthy();
  });

  it("advances the summary cursor while preserving every raw message", async () => {
    const sessionId = await createSession();
    const rows = await insertConversation(sessionId);
    await connection`
      update settings
      set recent_message_budget = 20, summary_trigger_tokens = 1
      where id = 1
    `;

    expect(await enqueueSummaryIfNeeded(sessionId)).toBe(true);
    expect(await enqueueSummaryIfNeeded(sessionId)).toBe(false);
    expect(await runNextJob()).toBe(true);

    const [session] = await connection<
      { summary: string; summary_through_message_id: string }[]
    >`
      select summary, summary_through_message_id
      from sessions where id = ${sessionId}
    `;
    expect(session).toEqual({
      summary: "Cumulative summary",
      summary_through_message_id: rows[3].id,
    });
    const [{ count }] = await connection<{ count: number }[]>`
      select count(*)::int as count from messages where session_id = ${sessionId}
    `;
    expect(count).toBe(6);
    const [job] = await connection<{ status: string }[]>`
      select status from jobs where type = 'summarize_session'
    `;
    expect(job.status).toBe("complete");
    const [snapshotJob] = await connection<{ status: string }[]>`
      select status from jobs where type = 'update_recent_snapshot'
    `;
    expect(snapshotJob.status).toBe("pending");

    const history = await loadCompleteHistory(
      sessionId,
      "00000000-0000-4000-8000-000000000000",
      session.summary_through_message_id,
    );
    expect(
      history.map(({ role, content }) => ({ role, content })),
    ).toEqual([
      { role: "user", content: "4".repeat(30) },
      { role: "assistant", content: "5".repeat(30) },
    ]);
    expect(
      buildChatContext({
        settings: {
          systemPrompt: "Helpful",
          standingContext: "",
          summary: session.summary,
          summaryThroughMessageId: session.summary_through_message_id,
          capsuleTokenBudget: 2000,
          contextTokenBudget: 1000,
          maxOutputTokens: 100,
        },
        history,
        currentUserMessage: "Continue",
      }).messages,
    ).toEqual([
      { role: "system", content: "Helpful" },
      {
        role: "system",
        content:
          "Continuity capsule:\n\n## Current thread state\nCumulative summary",
      },
      ...history.map(({ role, content, completedAt }) => ({
        role,
        content: `[${formatContextStamp(completedAt)}] ${content}`,
      })),
      { role: "user", content: "Continue" },
    ]);
  });

  it("re-advances the summary cursor a rewrite swap set-nulled (MC-116B)", async () => {
    // Commit-time race: a summarize run consumed the tail exchange while
    // its replacement streamed. The swap deletes the cursor row (set-null);
    // the next summarize run rebuilds from the session start and re-advances
    // the cursor — the accepted degraded recovery path (decision 4 / AC7).
    const sessionId = await createSession();
    const rows = await insertConversation(sessionId);
    await connection`
      update sessions
      set summary = 'Stale summary.',
          summary_through_message_id = ${rows[5].id}
      where id = ${sessionId}
    `;
    // The streaming replacement pair for the tail exchange (rows 4/5).
    const [replacementUser] = await connection<{ id: string }[]>`
      insert into messages (
        session_id, role, content, status, model_id, metadata,
        created_at, completed_at
      )
      values (
        ${sessionId}, 'user', 'Edited question', 'complete', 'default',
        ${JSON.stringify({ attemptId: "att-1", supersedes: rows[4].id })}::jsonb,
        '2026-06-15T12:01:00Z'::timestamptz, '2026-06-15T12:01:00Z'::timestamptz
      )
      returning id
    `;
    const [replacementAssistant] = await connection<{ id: string }[]>`
      insert into messages (
        session_id, role, content, status, model_id, created_at
      )
      values (
        ${sessionId}, 'assistant', '', 'streaming', 'default',
        '2026-06-15T12:01:00.001Z'::timestamptz
      )
      returning id
    `;

    await completeGeneration({
      assistantMessageId: replacementAssistant.id,
      content: "Better reply",
      supersede: {
        sessionId,
        userMessageId: rows[4].id,
        assistantMessageId: rows[5].id,
        replacementUserMessageId: replacementUser.id,
      },
    });

    const [afterSwap] = await connection<
      { summary_through_message_id: string | null }[]
    >`
      select summary_through_message_id from sessions
      where id = ${sessionId}
    `;
    expect(afterSwap.summary_through_message_id).toBeNull();

    await connection`
      update settings
      set recent_message_budget = 20, summary_trigger_tokens = 1
      where id = 1
    `;
    expect(await enqueueSummaryIfNeeded(sessionId)).toBe(true);
    expect(await runNextJob()).toBe(true);

    const [session] = await connection<
      { summary: string; summary_through_message_id: string | null }[]
    >`
      select summary, summary_through_message_id
      from sessions where id = ${sessionId}
    `;
    expect(session.summary).toBe("Cumulative summary");
    expect(session.summary_through_message_id).not.toBeNull();
  });

  it("trims the summary at its write cap with the estimator, never the provider", async () => {
    const sessionId = await createSession();
    await insertConversation(sessionId);
    await connection`
      update settings
      set recent_message_budget = 20, summary_trigger_tokens = 1
      where id = 1
    `;
    // 3900 ASCII characters = 1300 estimated tokens: past the summary's
    // write cap (600 × 2 = 1200), which keeps 3600 characters (MC-121: the
    // prompt states 600, the cap absorbs the compression model's bias).
    mockProviderText("x".repeat(3900));

    await enqueueJob("summarize_session", { sessionId });
    expect(await runNextJob()).toBe(true);

    const [session] = await connection<{ summary: string }[]>`
      select summary from sessions where id = ${sessionId}
    `;
    expect(session.summary).toHaveLength(3600);
    expect(provider.countTokens).not.toHaveBeenCalled();
  });

  it("gates the tick snapshot refresh on the 24h cadence guard", async () => {
    const now = new Date();
    const newestCompletedAt = new Date(now.getTime() - 20 * 60 * 1000);

    // Fresh snapshot: idle + new material past the window end, but the last
    // refresh is too recent — the cadence guard declines.
    await connection`
      insert into recent_continuity_snapshot (id, content, version, updated_at, source_window_end)
      values (1, 'fresh snapshot', 1,
        ${new Date(now.getTime() - 60 * 60 * 1000).toISOString()}::timestamptz,
        ${new Date(now.getTime() - 60 * 60 * 1000).toISOString()}::timestamptz)
      on conflict (id) do update set
        content = excluded.content,
        updated_at = excluded.updated_at,
        source_window_end = excluded.source_window_end
    `;
    await expect(
      shouldEnqueueRecentSnapshot(newestCompletedAt, now),
    ).resolves.toBe(false);

    // Same material, refresh older than the interval — fires again.
    const staleAt = new Date(
      now.getTime() - SNAPSHOT_MIN_INTERVAL_MS - 60 * 60 * 1000,
    );
    await connection`
      update recent_continuity_snapshot
      set updated_at = ${staleAt.toISOString()}::timestamptz,
          source_window_end = ${staleAt.toISOString()}::timestamptz
      where id = 1
    `;
    await expect(
      shouldEnqueueRecentSnapshot(newestCompletedAt, now),
    ).resolves.toBe(true);

    // Missing row (first ever refresh) is never gated.
    await connection`delete from recent_continuity_snapshot`;
    await expect(
      shouldEnqueueRecentSnapshot(newestCompletedAt, now),
    ).resolves.toBe(true);
  });

  it("writes a replacement recent snapshot and skips no-op overlap runs", async () => {
    mockProviderText("Active project: finish MC-103 snapshot storage and job.");
    const sessionId = await createSession();
    const rows = await insertConversation(sessionId);
    await connection`
      update sessions
      set title = 'Snapshot work',
          summary = 'The snapshot job should land before capsule assembly.',
          summary_through_message_id = ${rows[1].id}
      where id = ${sessionId}
    `;
    const memoryId = await insertMemory({
      content: "snapshot test open thread: confirm the stale policy is seven days.",
      kind: "open_thread",
      importance: 0.9,
      resolved: false,
    });

    await enqueueJob("update_recent_snapshot", {});
    expect(await runNextJob()).toBe(true);

    const [snapshot] = await connection<
      {
        content: string;
        version: number;
        source_window_start: Date | null;
        source_window_end: Date | null;
        source_summary_ids: string[];
        source_memory_ids: string[];
        stale_after: Date;
        updated_at: Date;
      }[]
    >`
      select content, version, source_window_start, source_window_end,
             source_summary_ids, source_memory_ids, stale_after, updated_at
      from recent_continuity_snapshot
      where id = 1
    `;
    expect(snapshot.content).toBe(
      "Active project: finish MC-103 snapshot storage and job.",
    );
    expect(snapshot.version).toBe(1);
    expect(snapshot.source_window_start).toBeNull();
    expect(snapshot.source_window_end).toBeTruthy();
    expect(snapshot.source_summary_ids).toContain(rows[1].id);
    expect(snapshot.source_memory_ids).toContain(memoryId);
    expect(provider.stream).toHaveBeenCalledWith(
      expect.objectContaining({
        maxOutputTokens: COMPRESSION_MAX_OUTPUT_TOKENS,
      }),
      expect.any(AbortSignal),
    );
    expect(
      new Date(String(snapshot.stale_after)).getTime() -
        new Date(String(snapshot.updated_at)).getTime(),
    ).toBe(7 * 24 * 60 * 60 * 1000);

    await enqueueJob("update_recent_snapshot", {});
    expect(await runNextJob()).toBe(true);
    const [unchanged] = await connection<{ version: number; content: string }[]>`
      select version, content from recent_continuity_snapshot where id = 1
    `;
    expect(unchanged).toEqual({
      version: 1,
      content: "Active project: finish MC-103 snapshot storage and job.",
    });
    expect(provider.stream).toHaveBeenCalledTimes(1);
  });

  it("feeds a newly resolved open thread into the snapshot rewrite", async () => {
    mockProviderText(
      "Active: the capsule budget thread is still open.",
      "Replacement without the resolved thread.",
    );
    const sessionId = await createSession();
    await insertConversation(sessionId);
    const memoryId = await insertMemory({
      content: "Open thread: decide the capsule budget split.",
      kind: "open_thread",
      importance: 0.4,
      resolved: false,
    });

    await enqueueJob("update_recent_snapshot", {});
    expect(await runNextJob()).toBe(true);

    // Resolving a low-importance, unpinned thread is the only change in the
    // next window; it must still count as a new input and reach the prompt.
    await connection`
      update memories set resolved = true, updated_at = now()
      where id = ${memoryId}
    `;

    await enqueueJob("update_recent_snapshot", {});
    expect(await runNextJob()).toBe(true);

    const [snapshot] = await connection<
      { version: number; content: string }[]
    >`
      select version, content from recent_continuity_snapshot where id = 1
    `;
    expect(snapshot).toEqual({
      version: 2,
      content: "Replacement without the resolved thread.",
    });
    const lastCall = provider.stream.mock.calls.at(-1)?.[0] as {
      messages: { content: string }[];
    };
    expect(lastCall.messages[0].content).toContain("resolved=true");
    expect(lastCall.messages[0].content).toContain(
      "decide the capsule budget split",
    );
  });

  it("keeps a snapshot between its budget and its write cap without a rewrite", async () => {
    // 8 CJK characters = 8 estimated tokens: over the 5 budget, inside the
    // 10 cap (5 × 2) — stored as written, one provider call (MC-121).
    mockProviderText("你好世界你好世界");
    const sessionId = await createSession();
    await insertConversation(sessionId);
    await connection`
      update settings set recent_snapshot_token_budget = 5 where id = 1
    `;

    await enqueueJob("update_recent_snapshot", {});
    expect(await runNextJob()).toBe(true);

    const [snapshot] = await connection<{ content: string }[]>`
      select content from recent_continuity_snapshot where id = 1
    `;
    expect(snapshot.content).toBe("你好世界你好世界");
    expect(provider.stream).toHaveBeenCalledTimes(1);
  });

  it("rewrites and trims a snapshot past its write cap", async () => {
    mockProviderText("abcdefghi ".repeat(20), "你好世界".repeat(20));
    const sessionId = await createSession();
    await insertConversation(sessionId);
    await connection`
      update settings set recent_snapshot_token_budget = 5 where id = 1
    `;

    await enqueueJob("update_recent_snapshot", {});
    expect(await runNextJob()).toBe(true);

    const [snapshot] = await connection<{ content: string }[]>`
      select content from recent_continuity_snapshot where id = 1
    `;
    expect(snapshot.content.length).toBeGreaterThan(5);
    // Trimmed at the cap (5 × 2), not the budget.
    expect(snapshot.content.length).toBeLessThanOrEqual(10);
    expect(provider.stream).toHaveBeenCalledTimes(2);
  });

  it("returns dated recent snapshots through the read helper at every age", async () => {
    expect(await getRecentSnapshot()).toBeNull();
    const windowEnd = new Date(Date.now() - 60 * 60 * 1000);
    await connection`
      insert into recent_continuity_snapshot (
        id, content, version, source_window_end, stale_after
      )
      values (1, ' Fresh snapshot ', 4,
        ${windowEnd.toISOString()}::timestamptz,
        now() + interval '1 hour')
    `;

    await expect(getRecentSnapshot()).resolves.toEqual({
      content: "Fresh snapshot",
      version: 4,
      asOf: windowEnd,
      stale: false,
    });

    // Expiry no longer vanishes the snapshot; it only flips the
    // observability flag (MC-113).
    await connection`
      update recent_continuity_snapshot
      set stale_after = now() - interval '1 second'
      where id = 1
    `;
    await expect(getRecentSnapshot()).resolves.toEqual({
      content: "Fresh snapshot",
      version: 4,
      asOf: windowEnd,
      stale: true,
    });
  });

  it("replaces the stale dated section on the first rebuild after a return", async () => {
    // Simulated absence: the last refresh ran 10 days ago, so the snapshot
    // expired 3 days ago. It must still read back, dated by its window end.
    const staleWindowEnd = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await connection`
      insert into recent_continuity_snapshot (
        id, content, version, updated_at, source_window_end, stale_after
      )
      values (1, 'Before the absence.', 3,
        ${staleWindowEnd.toISOString()}::timestamptz,
        ${staleWindowEnd.toISOString()}::timestamptz,
        ${new Date(
          staleWindowEnd.getTime() + 7 * 24 * 60 * 60 * 1000,
        ).toISOString()}::timestamptz)
    `;

    const staleSnapshot = await getRecentSnapshot();
    expect(staleSnapshot).toEqual({
      content: "Before the absence.",
      version: 3,
      asOf: staleWindowEnd,
      stale: true,
    });
    const { text: staleCapsule } = buildContinuityCapsule({
      standingContext: "",
      snapshot: staleSnapshot,
      tokenBudget: 2000,
    });
    expect(staleCapsule).toContain(
      `## Recent continuity snapshot (as of ${formatLocalDay(
        staleWindowEnd,
      )})`,
    );
    expect(staleCapsule).toContain("Before the absence.");

    // The return: new conversation material and an advanced summary cursor
    // feed the existing rebuild machinery; the dated section is replaced.
    mockProviderText("Back again: the conversation resumed.");
    const sessionId = await createSession();
    const rows = await insertConversation(sessionId);
    await connection`
      update sessions
      set summary = 'Resumed conversation.',
          summary_through_message_id = ${rows[1].id}
      where id = ${sessionId}
    `;
    await enqueueJob("update_recent_snapshot", {});
    expect(await runNextJob()).toBe(true);

    const rebuilt = await getRecentSnapshot();
    expect(rebuilt).toMatchObject({
      content: "Back again: the conversation resumed.",
      version: 4,
      stale: false,
    });
    expect(rebuilt!.asOf.getTime()).toBeGreaterThan(staleWindowEnd.getTime());
    const { text: rebuiltCapsule } = buildContinuityCapsule({
      standingContext: "",
      snapshot: rebuilt,
      tokenBudget: 2000,
    });
    expect(rebuiltCapsule).toContain(
      `## Recent continuity snapshot (as of ${formatLocalDay(
        rebuilt!.asOf,
      )})`,
    );
    expect(rebuiltCapsule).not.toContain("Before the absence.");
  });

  it("retries recent snapshot provider failures without writing a row", async () => {
    const sessionId = await createSession();
    await insertConversation(sessionId);
    provider.stream.mockImplementation(async function* () {
      throw new Error("snapshot provider failed");
    });

    await enqueueJob("update_recent_snapshot", {});
    expect(await runNextJob()).toBe(true);

    const [job] = await connection<
      { status: string; attempts: number; last_error: string }[]
    >`select status, attempts, last_error from jobs`;
    expect(job).toMatchObject({
      status: "pending",
      attempts: 1,
      last_error: "snapshot provider failed",
    });
    const [{ count }] = await connection<{ count: number }[]>`
      select count(*)::int as count from recent_continuity_snapshot
    `;
    expect(count).toBe(0);
  });

  it("leaves the cursor unchanged when compression fails", async () => {
    const sessionId = await createSession();
    await insertConversation(sessionId);
    await connection`
      update settings set recent_message_budget = 20 where id = 1
    `;
    provider.stream.mockImplementation(async function* () {
      throw new Error("provider failed");
    });
    await enqueueJob("summarize_session", { sessionId });

    expect(await runNextJob()).toBe(true);
    const [session] = await connection<
      { summary: string | null; summary_through_message_id: string | null }[]
    >`
      select summary, summary_through_message_id
      from sessions where id = ${sessionId}
    `;
    expect(session).toEqual({
      summary: null,
      summary_through_message_id: null,
    });
    const [job] = await connection<
      { status: string; attempts: number; last_error: string }[]
    >`select status, attempts, last_error from jobs`;
    expect(job).toMatchObject({
      status: "pending",
      attempts: 1,
      last_error: "provider failed",
    });
  });
});
