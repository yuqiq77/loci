// MC-118: source-bound failure fences, request-terminal handling, exhausted
// candidates, and the host-suspension refund, driven through the diary (the
// simplest source key) and the real tick + worker.
process.env.TZ = "Europe/Zurich";

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
  getConsolidationProvider: () => provider,
  getChatBackgroundProvider: () => provider,
}));
vi.mock("@/server/env", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/env")>();
  return {
    ...original,
    getChatEnv: () => ({
      CHAT_API_KEY: "test",
      CHAT_BASE_URL: "https://api.anthropic.com",
      CHAT_MODEL: "chat-test",
    }),
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
    getConsolidationEnv: () => ({
      CONSOLIDATION_API_KEY: "test",
      CONSOLIDATION_BASE_URL: "https://api.anthropic.com",
      CONSOLIDATION_MODEL: "consolidation-test",
    }),
  };
});

import { estimateTextTokens } from "@/server/chat/context";
import { ProviderError } from "@/server/chat/provider-error";
import { closeDatabase } from "@/server/db/client";
import { enqueueJob, recordJobNote, recoverStaleJobs } from "@/server/db/jobs";
import {
  diarySourceKey,
  maybeEnqueueContinuityJobs,
  narrativeSourceKey,
  newestCompletedMessageAt,
  recentSnapshotSourceKey,
} from "@/server/jobs/continuity";
import { runNextJob, runWorkerTick } from "@/server/jobs/worker";
import { resetServerEnvForTests } from "@/server/env";
import {
  addDiaryDays,
  diaryDayOf,
  diaryDayWindow,
} from "@/server/summaries/diary";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const HOUR_MS = 60 * 60 * 1000;
const BASE_URL = "https://api.anthropic.com";

type JobRow = {
  id: string;
  status: string;
  attempts: number;
  last_error: string | null;
  payload: {
    date: string;
    sourceKey?: string;
    exhausted?: { stage: string; model: string; reason: string }[];
  };
};

describeWithDatabase("job failure fences (MC-118)", () => {
  const connection = postgres(testDatabaseUrl!, { max: 5, prepare: false });
  const database = drizzle(connection);
  const yesterday = addDiaryDays(diaryDayOf(new Date()), -1);

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    resetServerEnvForTests();
    await migrate(database, { migrationsFolder: "drizzle" });
  });

  beforeEach(async () => {
    await connection`delete from jobs`;
    await connection`delete from diary_entries`;
    await connection`delete from sessions`;
    await connection`delete from recent_continuity_snapshot`;
    await connection`delete from relationship_narrative_versions`;
    await connection`
      update relationship_narrative
      set content = 'Existing record', version = 1,
          consolidated_through = now() - interval '5 days'
      where id = 1
    `;
    await connection`
      update diary_state set epoch = now() - interval '5 days' where id = 1
    `;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await connection`delete from jobs`;
    await connection`delete from diary_entries`;
    await connection`delete from sessions`;
    await connection`delete from recent_continuity_snapshot`;
    await connection`delete from relationship_narrative_versions`;
    await connection`delete from memories where content_hash = 'mc118-review-thread'`;
    await connection`
      update relationship_narrative
      set content = '', version = 0, consolidated_through = now()
      where id = 1
    `;
    vi.resetAllMocks();
  });

  afterAll(async () => {
    await connection`update diary_state set epoch = now() where id = 1`;
    await closeDatabase();
    await connection.end();
  });

  async function seedDay(date: string) {
    const window = diaryDayWindow(date);
    const [session] = await connection<{ id: string }[]>`
      insert into sessions (model_id, title) values ('default', 'Chat')
      returning id
    `;
    for (const [role, offset] of [
      ["user", 2 * HOUR_MS],
      ["assistant", 2 * HOUR_MS + 1000],
    ] as const) {
      await connection`
        insert into messages (session_id, role, content, status, created_at, completed_at)
        values (
          ${session.id}, ${role}, ${`${role} turn of ${date}.`}, 'complete',
          ${new Date(window.start.getTime() + offset).toISOString()}::timestamptz,
          ${new Date(window.start.getTime() + offset).toISOString()}::timestamptz
        )
      `;
    }
    return session.id;
  }

  async function diaryJobs() {
    return connection<JobRow[]>`
      select id, status, attempts, last_error, payload
      from jobs where type = 'write_diary_entry' order by created_at
    `;
  }

  async function tickAndIsolateDiaryJob(now = new Date()) {
    await maybeEnqueueContinuityJobs(now);
    // Only the diary job may be claimed by runNextJob below.
    await connection`delete from jobs where type != 'write_diary_entry'`;
  }

  const terminated = async function* () {
    yield { type: "text", text: "cut off" };
    yield { type: "done", finishReason: "max_tokens" };
  };
  const completed = (text: string) =>
    async function* () {
      yield { type: "text", text };
      yield { type: "done", finishReason: "end_turn" };
    };
  const calledModels = () =>
    provider.stream.mock.calls.map(
      (call) => (call[0] as { model: string }).model,
    );

  it.each([
    { type: "update_recent_snapshot", calls: 1 },
    { type: "consolidate_narrative", calls: 2 },
  ] as const)("fences $type across ten ticks and reconnect, then admits exactly one changed source (AC1/2/5/9/10)", async ({ type, calls }) => {
    const sessionId = await seedDay(yesterday);
    provider.stream.mockImplementation(terminated);
    const tick = async (now = new Date()) => {
      await maybeEnqueueContinuityJobs(now);
      await connection`delete from jobs where type != ${type}`;
    };
    const [before] = await connection`
      select content, version, consolidated_through from relationship_narrative where id = 1
    `;

    await tick();
    expect(await runNextJob()).toBe(true);
    const [failed] = await connection`select * from jobs where type = ${type}`;
    expect(failed.status).toBe("failed");
    expect(failed.attempts).toBe(1);
    expect(failed.payload.sourceKey).toBeTruthy();
    expect(failed.last_error).toContain("max_tokens");

    // Reconnect the app's database client and run the worker's startup
    // recovery; a durable failed fence must survive both.
    await closeDatabase();
    expect(await recoverStaleJobs()).toBe(0);
    for (let minute = 1; minute <= 10; minute += 1) {
      await tick(new Date(Date.now() + minute * 60_000));
      expect(await runNextJob()).toBe(false);
    }
    expect(await connection`select * from jobs where type = ${type}`).toEqual([failed]);
    expect(provider.stream).toHaveBeenCalledTimes(calls);
    expect(await connection`select * from recent_continuity_snapshot`).toHaveLength(0);
    expect((await connection`
      select content, version, consolidated_through from relationship_narrative where id = 1
    `)[0]).toEqual(before);

    await connection`
      insert into messages (session_id, role, content, status, created_at, completed_at)
      values (${sessionId}, 'assistant', 'New source material.', 'complete',
        now() - interval '30 minutes', now() - interval '30 minutes')
    `;
    await Promise.all([tick(), tick()]);
    const rows = await connection`select * from jobs where type = ${type} order by created_at`;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(failed);
    expect(rows[1].status).toBe("pending");
    expect(rows[1].attempts).toBe(0);
    expect(rows[1].payload.sourceKey).not.toBe(failed.payload.sourceKey);
    expect(provider.stream).toHaveBeenCalledTimes(calls);
  });

  it("bounds snapshot timeouts to three calls with +1m/+10m backoff, then fences the source (AC4/10)", async () => {
    await seedDay(yesterday);
    provider.stream.mockImplementation(async function* () {
      throw new ProviderError("GENERATION_TIMEOUT", "Synthetic provider timeout.");
      yield { type: "text", text: "unreachable" };
    });
    await maybeEnqueueContinuityJobs();
    await connection`delete from jobs where type != 'update_recent_snapshot'`;
    const [original] = await connection`select id from jobs`;

    for (const delay of [60_000, 600_000, null]) {
      const before = Date.now();
      expect(await runNextJob()).toBe(true);
      const after = Date.now();
      const [row] = await connection`select * from jobs where id = ${original.id}`;
      expect(row.attempts).toBe(provider.stream.mock.calls.length);
      if (delay !== null) {
        expect(row.status).toBe("pending");
        const availableAt = new Date(row.available_at).getTime();
        expect(availableAt).toBeGreaterThanOrEqual(before + delay);
        expect(availableAt).toBeLessThanOrEqual(after + delay);
        expect(await runNextJob()).toBe(false);
        await connection`update jobs set available_at = now() where id = ${original.id}`;
      } else {
        expect(row.status).toBe("failed");
        expect(row.attempts).toBe(3);
      }
    }
    for (let minute = 1; minute <= 10; minute += 1) {
      await maybeEnqueueContinuityJobs(new Date(Date.now() + minute * 60_000));
      await connection`delete from jobs where type != 'update_recent_snapshot'`;
      expect(await runNextJob()).toBe(false);
    }
    expect(await connection`select id from jobs`).toEqual([original]);
    expect(provider.stream).toHaveBeenCalledTimes(3);
  });

  it("recovers the same stale lease with its source, attempt count, and exhausted candidate intact (AC9)", async () => {
    await seedDay(yesterday);
    const exhausted = [{ stage: "generation", model: "chat-test", baseUrl: BASE_URL, reason: "max_tokens" }];
    const id = await enqueueJob("write_diary_entry", {
      date: yesterday, sourceKey: diarySourceKey(yesterday), exhausted,
    });
    await connection`
      update jobs set status = 'running', attempts = 1,
        locked_at = now() - interval '16 minutes' where id = ${id!}
    `;
    await closeDatabase();
    expect(await recoverStaleJobs()).toBe(1);
    expect(await recoverStaleJobs()).toBe(0);
    expect((await diaryJobs())[0]).toMatchObject({
      id, status: "pending", attempts: 1,
      payload: { sourceKey: diarySourceKey(yesterday), exhausted },
    });
    provider.stream.mockImplementation(completed("Recovered by fallback."));
    expect(await runNextJob()).toBe(true);
    expect(calledModels()).toEqual(["consolidation-test"]);
    expect(await diaryJobs()).toEqual([
      expect.objectContaining({ id, status: "complete", attempts: 2 }),
    ]);
  });

  it("recovers a lease that goes stale after a restart on a later tick, without another restart (scope 6)", async () => {
    await seedDay(yesterday);
    const exhausted = [{ stage: "generation", model: "chat-test", baseUrl: BASE_URL, reason: "max_tokens" }];
    const id = await enqueueJob("write_diary_entry", {
      date: yesterday, sourceKey: diarySourceKey(yesterday), exhausted,
    });
    // The process holding the lease died and a new one started 13 minutes
    // into it (the 2026-10-11 incident): startup sees a live lease.
    const startedAt = Date.now() - 3 * 60_000;
    await connection`
      update jobs set status = 'running', attempts = 1,
        locked_at = ${new Date(startedAt - 13 * 60_000).toISOString()}::timestamptz
      where id = ${id!}
    `;
    await closeDatabase();
    for (const minute of [0, 1, 2]) {
      await runWorkerTick(new Date(startedAt + minute * 60_000));
      await connection`delete from jobs where type != 'write_diary_entry'`;
      expect(await diaryJobs()).toEqual([
        expect.objectContaining({ id, status: "running", attempts: 1 }),
      ]);
    }

    await runWorkerTick(new Date());
    await connection`delete from jobs where type != 'write_diary_entry'`;
    expect(await diaryJobs()).toEqual([
      expect.objectContaining({
        id, status: "pending", attempts: 1,
        payload: { date: yesterday, sourceKey: diarySourceKey(yesterday), exhausted },
      }),
    ]);
    provider.stream.mockImplementation(completed("Recovered on a tick."));
    expect(await runNextJob()).toBe(true);
    expect(calledModels()).toEqual(["consolidation-test"]);
    expect(await diaryJobs()).toEqual([
      expect.objectContaining({ id, status: "complete", attempts: 2 }),
    ]);
  });

  it("merges a job note into the payload and keeps the rest of it", async () => {
    const id = await enqueueJob("consolidate_narrative", { mode: "incremental" });
    await recordJobNote(id!, {
      rawTailDropped: [{ sessionId: null, turns: 2, tokens: null }],
    });
    const [row] = await connection`select payload from jobs where id = ${id!}`;
    expect(row.payload).toMatchObject({
      mode: "incremental",
      rawTailDropped: [{ sessionId: null, turns: 2, tokens: null }],
    });
  });

  it("writes a capped raw tail onto the job before generating, so a failed attempt keeps it", async () => {
    const sessionId = await seedDay(yesterday);
    const [{ summary_trigger_tokens: trigger }] = await connection<
      { summary_trigger_tokens: number }[]
    >`select summary_trigger_tokens from settings where id = 1`;
    // A one-token cap per session keeps only the day's newest turn.
    await connection`update settings set summary_trigger_tokens = 1 where id = 1`;
    try {
      await maybeEnqueueContinuityJobs();
      await connection`delete from jobs where type != 'consolidate_narrative'`;
      provider.stream.mockImplementation(terminated);
      expect(await runNextJob()).toBe(true);
      const [job] = await connection`select status, payload from jobs`;
      expect(job.status).toBe("failed");
      expect(job.payload.rawTailDropped).toEqual([
        {
          sessionId,
          turns: 1,
          tokens: estimateTextTokens(`user turn of ${yesterday}.`),
        },
      ]);
    } finally {
      await connection`update settings set summary_trigger_tokens = ${trigger} where id = 1`;
    }
  });

  it("runs a manual narrative consolidation while retaining its failed automatic fence (AC7)", async () => {
    await seedDay(yesterday);
    provider.stream.mockImplementation(terminated);
    await maybeEnqueueContinuityJobs();
    await connection`delete from jobs where type != 'consolidate_narrative'`;
    expect(await runNextJob()).toBe(true);
    const [failed] = await connection`select * from jobs`;
    expect(failed.status).toBe("failed");
    expect(await enqueueJob("consolidate_narrative", {
      mode: "incremental", sourceKey: failed.payload.sourceKey,
    })).toBeNull();
    const id = await enqueueJob("consolidate_narrative", { mode: "incremental" });
    expect(id).toBeTruthy();
    provider.stream.mockImplementation(completed("Manually retried narrative."));
    expect(await runNextJob()).toBe(true);
    expect((await connection`select * from jobs where id = ${failed.id}`)[0]).toEqual(failed);
    expect((await connection`select status from jobs where id = ${id!}`)[0].status).toBe("complete");
    expect((await connection`select content from relationship_narrative where id = 1`)[0].content)
      .toBe("Manually retried narrative.");
  });

  it.each([true, false])("handles narrative review fallback (success=%s) without committing a failed review (AC3/8)", async (succeeds) => {
    await seedDay(yesterday);
    const [thread] = await connection`
      insert into memories (content, kind, importance, resolved, content_hash)
      values ('An unresolved synthetic plan.', 'open_thread', 0.8, false, 'mc118-review-thread')
      returning id
    `;
    const [before] = await connection`select content, version, consolidated_through from relationship_narrative where id = 1`;
    provider.stream.mockImplementationOnce(completed("Generated narrative."));
    provider.stream.mockImplementationOnce(completed("not valid JSON"));
    provider.stream.mockImplementationOnce(completed(succeeds
      ? JSON.stringify({ resolved_thread_ids: [thread.id] })
      : "also not valid JSON"));
    await maybeEnqueueContinuityJobs();
    await connection`delete from jobs where type != 'consolidate_narrative'`;
    expect(await runNextJob()).toBe(true);
    const [job] = await connection`select * from jobs`;
    expect(job.status).toBe(succeeds ? "complete" : "failed");
    expect(job.attempts).toBe(1);
    expect(calledModels()).toEqual(["chat-test", "chat-test", "consolidation-test"]);
    expect(job.payload.exhausted).toHaveLength(succeeds ? 1 : 2);
    expect(job.payload.exhausted[0]).toMatchObject({ stage: "review", model: "chat-test", reason: "not_json" });
    const [narrative] = await connection`select content, version, consolidated_through from relationship_narrative where id = 1`;
    expect((await connection`select resolved from memories where id = ${thread.id}`)[0].resolved).toBe(succeeds);
    if (succeeds) {
      expect(narrative.content).toBe("Generated narrative.");
      expect(narrative.version).toBe(before.version + 1);
      expect(console.error).not.toHaveBeenCalled();
    } else {
      expect(narrative).toEqual(before);
      expect(job.last_error).toContain("Resolution review output is not valid JSON");
      expect(job.payload.exhausted[1]).toMatchObject({ stage: "review", model: "consolidation-test", reason: "not_json" });
      expect(await runNextJob()).toBe(false);
    }
  });

  it("fails the row on the first attempt when every candidate terminated, and fences the source across ticks (AC1/AC3/AC10)", async () => {
    await seedDay(yesterday);
    provider.stream.mockImplementation(terminated);

    await tickAndIsolateDiaryJob();
    expect(await runNextJob()).toBe(true);

    const [job] = await diaryJobs();
    expect(job.status).toBe("failed");
    expect(job.attempts).toBe(1);
    expect(job.payload.sourceKey).toBe(diarySourceKey(yesterday));
    expect(job.last_error).toContain("Every provider candidate failed");
    expect(job.last_error).toContain("finish reason: max_tokens");
    expect(job.payload.exhausted).toEqual([
      expect.objectContaining({
        stage: "generation",
        model: "chat-test",
        reason: "max_tokens",
      }),
      expect.objectContaining({
        stage: "generation",
        model: "consolidation-test",
        reason: "max_tokens",
      }),
    ]);

    // Ten more ticks: the failed row is the blocked marker — no sibling row,
    // no further provider call. Total calls = one per candidate.
    for (let tick = 0; tick < 10; tick += 1) {
      await tickAndIsolateDiaryJob(new Date(Date.now() + tick * 60_000));
      expect(await runNextJob()).toBe(false);
    }
    expect(await diaryJobs()).toHaveLength(1);
    expect(provider.stream).toHaveBeenCalledTimes(2);
  });

  it("lets a manual enqueue (no sourceKey) through the fence and leaves the fenced row alone (AC6/AC7)", async () => {
    await connection`
      insert into jobs (type, payload, status, attempts, completed_at)
      values (
        'write_diary_entry',
        ${JSON.stringify({ date: yesterday, sourceKey: diarySourceKey(yesterday) })}::jsonb,
        'failed', 1, now()
      )
    `;

    await expect(
      enqueueJob("write_diary_entry", {
        date: yesterday,
        sourceKey: diarySourceKey(yesterday),
      }),
    ).resolves.toBeNull();
    await expect(
      enqueueJob("write_diary_entry", { date: yesterday }),
    ).resolves.toBeTruthy();

    const rows = await diaryJobs();
    expect(rows.map((row) => row.status)).toEqual(["failed", "pending"]);
    expect(rows[0].payload.sourceKey).toBe(diarySourceKey(yesterday));
    await seedDay(yesterday);
    provider.stream.mockImplementation(completed("Manually retried diary."));
    expect(await runNextJob()).toBe(true);
    expect((await diaryJobs())[0]).toEqual(rows[0]);
    expect((await diaryJobs())[1].status).toBe("complete");
    expect((await connection`select content from diary_entries where entry_date = ${yesterday}`)[0].content)
      .toBe("Manually retried diary.");
    // A fenced day does not block another day's independent work.
    const anotherDay = addDiaryDays(yesterday, -1);
    expect(await enqueueJob("write_diary_entry", {
      date: anotherDay, sourceKey: diarySourceKey(anotherDay),
    })).toBeTruthy();
  });

  it("does not fence on a legacy failed row without a sourceKey, nor across a policy change (AC2/AC9)", async () => {
    await connection`
      insert into jobs (type, payload, status, attempts, completed_at)
      values ('write_diary_entry', ${JSON.stringify({ date: yesterday })}::jsonb, 'failed', 3, now())
    `;
    await expect(
      enqueueJob("write_diary_entry", {
        date: yesterday,
        sourceKey: diarySourceKey(yesterday),
      }),
    ).resolves.toBeTruthy();
    await connection`delete from jobs`;

    await connection`
      insert into jobs (type, payload, status, attempts, completed_at)
      values (
        'write_diary_entry',
        ${JSON.stringify({ date: yesterday, sourceKey: `${yesterday}|p0` })}::jsonb,
        'failed', 1, now()
      )
    `;
    await expect(
      enqueueJob("write_diary_entry", {
        date: yesterday,
        sourceKey: diarySourceKey(yesterday),
      }),
    ).resolves.toBeTruthy();
  });

  it("refunds the attempt on a suspected host suspension without touching the chain (AC4)", async () => {
    await seedDay(yesterday);
    provider.stream.mockImplementation(async function* () {
      throw new ProviderError(
        "HOST_SUSPENDED",
        "Anthropic request outlived its 300s timeout by wall clock.",
      );
      yield { type: "text", text: "unreachable" };
    });

    await tickAndIsolateDiaryJob();
    // Suspended on what would have been the last attempt: still a refund,
    // and the writer's loss marker must stay silent (owner review).
    await connection`update jobs set attempts = 2 where type = 'write_diary_entry'`;
    for (let suspension = 0; suspension < 3; suspension += 1) {
      expect(await runNextJob()).toBe(true);
      const [job] = await diaryJobs();
      expect(job.status).toBe("pending");
      expect(job.attempts).toBe(2);
      expect(job.last_error).toContain("outlived its 300s timeout");
      expect(job.payload.exhausted).toBeUndefined();
      await connection`update jobs set available_at = now() where id = ${job.id}`;
    }
    expect(await diaryJobs()).toHaveLength(1);
    // Each suspension stopped the walker at the first candidate.
    expect(calledModels()).toEqual(["chat-test", "chat-test", "chat-test"]);
    expect(console.error).not.toHaveBeenCalledWith(
      "diary_entry_day_lost",
      expect.anything(),
    );
  });

  it("persists an exhausted candidate on the row and skips it on the next attempt (AC3/AC8)", async () => {
    await seedDay(yesterday);
    provider.stream.mockImplementationOnce(terminated);
    provider.stream.mockImplementationOnce(async function* () {
      throw new Error("relay down");
      yield { type: "text", text: "unreachable" };
    });

    await tickAndIsolateDiaryJob();
    expect(await runNextJob()).toBe(true);

    const [afterFirst] = await diaryJobs();
    // A terminated, B transient: the row stays retryable for B only.
    expect(afterFirst.status).toBe("pending");
    expect(afterFirst.attempts).toBe(1);
    expect(afterFirst.payload.exhausted).toEqual([
      { stage: "generation", model: "chat-test", baseUrl: BASE_URL, reason: "max_tokens" },
    ]);

    await connection`update jobs set available_at = now() where id = ${afterFirst.id}`;
    provider.stream.mockImplementationOnce(completed("written by the fallback"));
    expect(await runNextJob()).toBe(true);

    const [afterSecond] = await diaryJobs();
    expect(afterSecond.status).toBe("complete");
    expect(calledModels()).toEqual([
      "chat-test",
      "consolidation-test",
      "consolidation-test",
    ]);
    const [entry] = await connection<{ content: string }[]>`
      select content from diary_entries where entry_date = ${yesterday}
    `;
    expect(entry.content).toBe("written by the fallback");
  });

  it("derives stable, readable source keys that change only with the sources (AC2/AC5)", async () => {
    const sessionId = await seedDay(yesterday);
    const newest = await newestCompletedMessageAt();

    const narrativeKey = await narrativeSourceKey(newest);
    expect(await narrativeSourceKey(newest)).toBe(narrativeKey);
    expect(narrativeKey).toMatch(/^v\d+\|through:.*\|msg:.*\|mem:.*\|p1$/);

    const snapshotKey = await recentSnapshotSourceKey(newest);
    expect(await recentSnapshotSourceKey(newest)).toBe(snapshotKey);
    expect(snapshotKey).toMatch(/^v\d+\|msg:.*\|sum:0\/0\|mem:.*\|p1$/);

    // A summary cursor landing on a second session changes the key even
    // when that cursor is older than another session's (cursor-set sum, not
    // a global max).
    const [newer] = await connection<{ id: string }[]>`
      insert into sessions (model_id, title) values ('default', 'Newer')
      returning id
    `;
    const cursorFor = async (sessionId: string, at: string) => {
      const [row] = await connection<{ id: string }[]>`
        insert into messages (session_id, role, content, status, created_at, completed_at)
        values (${sessionId}, 'assistant', 'cursor', 'complete', ${at}::timestamptz, ${at}::timestamptz)
        returning id
      `;
      await connection`update sessions set summary_through_message_id = ${row.id} where id = ${sessionId}`;
    };
    await cursorFor(newer.id, "2026-07-06T12:00:00Z");
    const withNewer = await recentSnapshotSourceKey(newest);
    expect(withNewer).not.toBe(snapshotKey);
    await cursorFor(sessionId, "2026-07-06T10:00:00Z");
    expect(await recentSnapshotSourceKey(newest)).not.toBe(withNewer);

    await connection`
      insert into messages (session_id, role, content, status, created_at, completed_at)
      values (${sessionId}, 'user', 'Later material.', 'complete', now(), now())
    `;
    const later = await newestCompletedMessageAt();
    expect(await narrativeSourceKey(later)).not.toBe(narrativeKey);
    expect(await recentSnapshotSourceKey(later)).not.toBe(snapshotKey);
  });
});
