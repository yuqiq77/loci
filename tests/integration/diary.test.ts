// Pinned for deterministic day-window math (forks pool gives each file its
// own process); all seeded instants are derived from the real clock through
// the same helpers the code under test uses.
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

import { closeDatabase } from "@/server/db/client";
import {
  insertDiaryEntry,
  listDiaryEntries,
  listDiaryMonths,
} from "@/server/db/diary";
import { enqueueJob } from "@/server/db/jobs";
import {
  diaryDaysNeedingEntries,
  maybeEnqueueContinuityJobs,
  newestCompletedMessageAt,
} from "@/server/jobs/continuity";
import { runNextJob } from "@/server/jobs/worker";
import { resetServerEnvForTests } from "@/server/env";
import {
  addDiaryDays,
  diaryDayOf,
  diaryDayWindow,
  writeDiaryEntry,
} from "@/server/summaries/diary";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

describeWithDatabase("diary entries", () => {
  const connection = postgres(testDatabaseUrl!, { max: 5, prepare: false });
  const database = drizzle(connection);

  // Diary days relative to the real clock: the most recently closed day and
  // the ones behind it, exactly as the tick computes them.
  const yesterday = addDiaryDays(diaryDayOf(new Date()), -1);
  const twoDaysAgo = addDiaryDays(yesterday, -1);

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    resetServerEnvForTests();
    await migrate(database, { migrationsFolder: "drizzle" });
  });

  beforeEach(async () => {
    // The suite owns the whole surface the tick reads: any leftover message
    // or job from another suite would perturb the shared idle aggregate.
    await connection`delete from jobs`;
    await connection`delete from diary_entries`;
    await connection`delete from sessions`;
    await connection`
      update diary_state
      set epoch = now() - interval '5 days'
      where id = 1
    `;
  });

  afterEach(async () => {
    await connection`delete from jobs`;
    await connection`delete from diary_entries`;
    await connection`delete from sessions`;
    // Reset (not just clear): a skip path can leave a queued
    // mockImplementationOnce unconsumed, and it must not leak into the next
    // test's stream calls. beforeEach re-establishes countTokens.
    vi.resetAllMocks();
  });

  afterAll(async () => {
    await connection`update diary_state set epoch = now() where id = 1`;
    await closeDatabase();
    await connection.end();
  });

  async function createSession(title = "Chat") {
    const [session] = await connection<{ id: string }[]>`
      insert into sessions (model_id, title)
      values ('default', ${title})
      returning id
    `;
    return session.id;
  }

  async function addMessage(input: {
    sessionId: string;
    role: "user" | "assistant";
    content: string;
    completedAt: Date;
    usedWebSearch?: boolean;
  }) {
    const [message] = await connection<{ id: string }[]>`
      insert into messages (
        session_id, role, content, status, created_at, completed_at,
        used_web_search
      )
      values (
        ${input.sessionId}, ${input.role}, ${input.content}, 'complete',
        ${input.completedAt.toISOString()}::timestamptz,
        ${input.completedAt.toISOString()}::timestamptz,
        ${input.usedWebSearch ?? false}
      )
      returning id
    `;
    return message.id;
  }

  function mockDiaryStream(entry: string) {
    provider.stream.mockImplementationOnce(async function* () {
      yield { type: "text", text: entry };
      yield { type: "done", finishReason: "end_turn" };
    });
  }

  function promptOfCall(index: number): string {
    const request = provider.stream.mock.calls[index][0] as {
      messages: { content: string }[];
    };
    // The offline writers now carry a system identity frame at index 0;
    // the task prompt is the trailing user message.
    return request.messages.at(-1)!.content;
  }

  async function diaryJobs() {
    return connection<{ payload: { date: string }; status: string }[]>`
      select payload, status from jobs where type = 'write_diary_entry'
    `;
  }

  async function diaryRows() {
    return connection<{ entry_date: string; content: string }[]>`
      select entry_date::text, content from diary_entries
      order by entry_date asc
    `;
  }

  async function seedDay(date: string, title = "Chat") {
    const window = diaryDayWindow(date);
    const sessionId = await createSession(title);
    await addMessage({
      sessionId,
      role: "user",
      content: `User turn of ${date}.`,
      completedAt: new Date(window.start.getTime() + 2 * HOUR_MS),
    });
    await addMessage({
      sessionId,
      role: "assistant",
      content: `Assistant turn of ${date}.`,
      completedAt: new Date(window.start.getTime() + 2 * HOUR_MS + 1000),
    });
    return sessionId;
  }

  it("lists entries by month and counts the months that hold them", async () => {
    for (const entryDate of [
      "2026-06-30",
      "2026-07-01",
      "2026-07-31",
      "2026-08-01",
    ]) {
      await insertDiaryEntry({ entryDate, content: `Entry of ${entryDate}.` });
    }

    const july = await listDiaryEntries({
      limit: 31,
      offset: 0,
      month: "2026-07",
    });
    expect(july.map((entry) => entry.entryDate)).toEqual([
      "2026-07-31",
      "2026-07-01",
    ]);
    expect(await listDiaryMonths()).toEqual([
      { month: "2026-08", count: 1 },
      { month: "2026-07", count: 2 },
      { month: "2026-06", count: 1 },
    ]);
  });

  it("journals a closed day once through the tick and the worker", async () => {
    await seedDay(yesterday);
    const now = new Date();

    await maybeEnqueueContinuityJobs(now);
    await maybeEnqueueContinuityJobs(now);

    const pending = await diaryJobs();
    expect(pending).toHaveLength(1);
    expect(pending[0].payload).toMatchObject({ date: yesterday });

    // Leave only the diary job so runNextJob deterministically claims it.
    await connection`delete from jobs where type != 'write_diary_entry'`;
    mockDiaryStream("Tonight we walked the day back to its shape.");
    await expect(runNextJob()).resolves.toBe(true);

    const rows = await diaryRows();
    expect(rows).toEqual([
      {
        entry_date: yesterday,
        content: "Tonight we walked the day back to its shape.",
      },
    ]);
    const [job] = await diaryJobs();
    expect(job.status).toBe("complete");

    // The written row is the completion marker: repeat ticks re-enqueue
    // nothing and the day is never written twice.
    await maybeEnqueueContinuityJobs(new Date());
    expect(await diaryJobs()).toHaveLength(1);
  });

  it("keeps the first write on a duplicate job (append-only)", async () => {
    await seedDay(yesterday);
    mockDiaryStream("The first telling of the day.");
    await writeDiaryEntry(yesterday);

    // A duplicate job skips before paying for a generation…
    await expect(writeDiaryEntry(yesterday)).resolves.toBeUndefined();
    expect(provider.stream).toHaveBeenCalledTimes(1);

    // …and even a raced insert (both executions past the pre-check) loses
    // to the existing row instead of overwriting it.
    await expect(
      insertDiaryEntry({
        entryDate: yesterday,
        content: "A stale duplicate telling.",
      }),
    ).resolves.toBe(false);

    const rows = await diaryRows();
    expect(rows).toEqual([
      { entry_date: yesterday, content: "The first telling of the day." },
    ]);
  });

  it("records carrier provenance at generation time (the signature)", async () => {
    await seedDay(yesterday);
    mockDiaryStream("A telling with a signature.");
    await writeDiaryEntry(yesterday);

    const rows = await connection<
      { provider: string | null; model: string | null; host: string | null }[]
    >`select provider, model, host from diary_entries where entry_date = ${yesterday}`;
    expect(rows).toEqual([
      { provider: "chat", model: "chat-test", host: "api.anthropic.com" },
    ]);
  });

  it("signs with the actual fallback winner, not the chain head", async () => {
    await seedDay(yesterday);
    // The primary (chat) candidate dies mid-stream; the consolidation
    // fallback writes the entry, so its identity must be the signature —
    // silent-fallback attribution is the incident the columns exist for.
    provider.stream.mockImplementationOnce(async function* () {
      throw new Error("primary candidate exploded");
    });
    mockDiaryStream("The fallback telling of the day.");

    await writeDiaryEntry(yesterday);

    const rows = await connection<
      { provider: string | null; model: string | null; host: string | null }[]
    >`select provider, model, host from diary_entries where entry_date = ${yesterday}`;
    expect(rows).toEqual([
      {
        provider: "consolidation",
        model: "consolidation-test",
        host: "api.anthropic.com",
      },
    ]);
  });

  it("dedupes pending jobs per date and keeps distinct dates apart", async () => {
    await expect(
      enqueueJob("write_diary_entry", { date: yesterday }),
    ).resolves.toBeTruthy();
    await expect(
      enqueueJob("write_diary_entry", { date: yesterday }),
    ).resolves.toBeNull();
    await expect(
      enqueueJob("write_diary_entry", { date: twoDaysAgo }),
    ).resolves.toBeTruthy();

    expect(await diaryJobs()).toHaveLength(2);
  });

  it("sources the day's turns only, D18-filtered, chronological", async () => {
    const window = diaryDayWindow(yesterday);
    const sessionId = await createSession("Mixed day");
    await addMessage({
      sessionId,
      role: "user",
      content: "Evening question that led to a search.",
      completedAt: new Date(window.start.getTime() + 16 * HOUR_MS),
    });
    await addMessage({
      sessionId,
      role: "assistant",
      content: "Search-derived answer.",
      completedAt: new Date(window.start.getTime() + 16 * HOUR_MS + 1000),
      usedWebSearch: true,
    });
    await addMessage({
      sessionId,
      role: "assistant",
      content: "Late-night reply past midnight.",
      completedAt: new Date(window.end.getTime() - 3 * HOUR_MS),
    });
    await addMessage({
      sessionId,
      role: "user",
      content: "Turn from the day before.",
      completedAt: new Date(window.start.getTime() - 2 * HOUR_MS),
    });
    await addMessage({
      sessionId,
      role: "user",
      content: "Turn after the window closed.",
      completedAt: new Date(window.end.getTime() + HOUR_MS),
    });

    mockDiaryStream("What mattered tonight.");
    await writeDiaryEntry(yesterday);

    const prompt = promptOfCall(0);
    expect(prompt).toContain("Evening question that led to a search.");
    expect(prompt).toContain("Late-night reply past midnight.");
    expect(prompt).not.toContain("Search-derived answer.");
    expect(prompt).not.toContain("Turn from the day before.");
    expect(prompt).not.toContain("Turn after the window closed.");
    expect(prompt.indexOf("Evening question")).toBeLessThan(
      prompt.indexOf("Late-night reply"),
    );

    const rows = await diaryRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].entry_date).toBe(yesterday);
  });

  it("writes nothing for an empty or fully filtered day", async () => {
    // Empty day: the job no-ops without calling the model.
    await writeDiaryEntry(yesterday);
    expect(provider.stream).not.toHaveBeenCalled();
    expect(await diaryRows()).toHaveLength(0);

    // A day whose only material is a search-flagged assistant turn is
    // invisible to the tick too — otherwise it would re-enqueue forever,
    // since no row will ever mark it covered.
    const window = diaryDayWindow(yesterday);
    const sessionId = await createSession("Search only");
    await addMessage({
      sessionId,
      role: "assistant",
      content: "Search-derived monologue.",
      completedAt: new Date(window.start.getTime() + 5 * HOUR_MS),
      usedWebSearch: true,
    });
    await expect(
      diaryDaysNeedingEntries(await newestCompletedMessageAt(), new Date()),
    ).resolves.toEqual([]);
    await writeDiaryEntry(yesterday);
    expect(provider.stream).not.toHaveBeenCalled();
    expect(await diaryRows()).toHaveLength(0);
  });

  it("gates the tick on idle, epoch, coverage, and the backlog bound", async () => {
    const now = new Date();
    await seedDay(yesterday);
    await seedDay(twoDaysAgo, "Older chat");

    // Happy path: both closed days missing, oldest first.
    await expect(
      diaryDaysNeedingEntries(await newestCompletedMessageAt(), now),
    ).resolves.toEqual([twoDaysAgo, yesterday]);

    // Episode still active: a completion five minutes ago closes the gate.
    const activeSessionId = await createSession("Active");
    const activeMessageId = await addMessage({
      sessionId: activeSessionId,
      role: "user",
      content: "Completed five minutes ago.",
      completedAt: new Date(now.getTime() - 5 * 60 * 1000),
    });
    await expect(
      diaryDaysNeedingEntries(await newestCompletedMessageAt(), now),
    ).resolves.toEqual([]);
    await connection`delete from messages where id = ${activeMessageId}`;

    // Already journaled: the entry row is the completion marker.
    await connection`
      insert into diary_entries (entry_date, content)
      values (${twoDaysAgo}, 'Already written.')
    `;
    await expect(
      diaryDaysNeedingEntries(await newestCompletedMessageAt(), now),
    ).resolves.toEqual([yesterday]);

    // Pre-epoch days are never auto-journaled.
    await connection`update diary_state set epoch = now() where id = 1`;
    await expect(
      diaryDaysNeedingEntries(await newestCompletedMessageAt(), now),
    ).resolves.toEqual([]);
    await connection`
      update diary_state set epoch = now() - interval '5 days' where id = 1
    `;

    // Backlog bound: material older than DIARY_BACKLOG_DAYS is skipped
    // silently — backfill is a manual decision.
    await connection`delete from messages`;
    await connection`delete from diary_entries`;
    const staleSessionId = await createSession("Stale");
    await addMessage({
      sessionId: staleSessionId,
      role: "user",
      content: "Material from five days ago.",
      completedAt: new Date(now.getTime() - 5 * DAY_MS),
    });
    await expect(
      diaryDaysNeedingEntries(await newestCompletedMessageAt(), now),
    ).resolves.toEqual([]);
  });

  it("leaves no row and stays retryable when every provider fails", async () => {
    await seedDay(yesterday);
    provider.stream.mockImplementation(async function* () {
      throw new Error("provider down");
      yield { type: "text", text: "unreachable" };
    });

    await expect(writeDiaryEntry(yesterday)).rejects.toThrow("provider down");
    // The final attempt logs the lost day loudly but still surfaces the
    // failure to the job machinery.
    await expect(
      writeDiaryEntry(yesterday, { isFinalAttempt: true }),
    ).rejects.toThrow("provider down");
    expect(await diaryRows()).toHaveLength(0);
  });
});
