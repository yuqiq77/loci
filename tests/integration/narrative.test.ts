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
import { enqueueJob } from "@/server/db/jobs";
import {
  getNarrativeContentAsOf,
  getRelationshipNarrative,
  NARRATIVE_AS_OF_RETENTION_DAYS,
  NarrativeVersionConflictError,
  writeNarrativeVersion,
} from "@/server/db/narrative";
import {
  maybeEnqueueContinuityJobs,
  newestCompletedMessageAt,
  shouldEnqueueNarrativeConsolidation,
} from "@/server/jobs/continuity";
import { resetServerEnvForTests } from "@/server/env";
import { consolidateNarrative } from "@/server/summaries/consolidate-narrative";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const HOUR_MS = 60 * 60 * 1000;

describeWithDatabase("long-horizon narrative", () => {
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
    await connection`delete from jobs where type = 'consolidate_narrative'`;
    await connection`delete from relationship_narrative_versions`;
    await connection`
      update relationship_narrative
      set content = '', version = 0, updated_at = now(),
          consolidated_through = now()
      where id = 1
    `;
    provider.countTokens.mockImplementation(async (request: {
      messages: { content: string }[];
    }) =>
      request.messages
        .map((message: { content: string }) => message.content)
        .join("\n\n").length,
    );
  });

  afterEach(async () => {
    await connection`delete from jobs where type = 'consolidate_narrative'`;
    await connection`delete from jobs where type = 'update_recent_snapshot'`;
    await connection`delete from relationship_narrative_versions`;
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
      update settings set standing_context = '' where id = 1
    `;
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await closeDatabase();
    await connection.end();
  });

  async function createSession(title = "Chat") {
    const [session] = await connection<{ id: string }[]>`
      insert into sessions (model_id, title)
      values ('default', ${title})
      returning id
    `;
    sessionIds.push(session.id);
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

  async function addOpenThread(content: string, updatedAt: Date) {
    const [memory] = await connection<{ id: string }[]>`
      insert into memories (
        content, kind, importance, resolved, content_hash,
        created_at, updated_at
      )
      values (
        ${content}, 'open_thread', 0.8, false, ${`hash-${content}`},
        ${updatedAt.toISOString()}::timestamptz,
        ${updatedAt.toISOString()}::timestamptz
      )
      returning id
    `;
    memoryIds.push(memory.id);
    return memory.id;
  }

  async function setWatermark(consolidatedThrough: Date) {
    await connection`
      update relationship_narrative
      set consolidated_through = ${consolidatedThrough.toISOString()}::timestamptz
      where id = 1
    `;
  }

  function mockNarrativeStream(record: string) {
    provider.stream.mockImplementationOnce(async function* () {
      yield { type: "text", text: record };
      yield { type: "done", finishReason: "end_turn" };
    });
  }

  function mockReviewStream(resolvedIds: string[]) {
    provider.stream.mockImplementationOnce(async function* () {
      yield {
        type: "text",
        text: JSON.stringify({ resolved_thread_ids: resolvedIds }),
      };
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

  it("runs an incremental consolidation end to end", async () => {
    const now = new Date();
    const watermark = new Date(now.getTime() - 25 * HOUR_MS);
    await setWatermark(watermark);
    await connection`
      update settings
      set standing_context = '## Profile\nSeed from standing context.'
      where id = 1
    `;

    const sessionId = await createSession("Prototype review");
    await addMessage({
      sessionId,
      role: "user",
      content: "The prototype was approved this morning!",
      completedAt: new Date(now.getTime() - 2 * HOUR_MS),
    });
    await addMessage({
      sessionId,
      role: "assistant",
      content: "That is wonderful news.",
      completedAt: new Date(now.getTime() - 2 * HOUR_MS + 1000),
    });
    const resolvedThreadId = await addOpenThread(
      "Waiting on the prototype decision.",
      new Date(now.getTime() - 3 * HOUR_MS),
    );
    const ambiguousThreadId = await addOpenThread(
      "Choosing between two apartments.",
      new Date(now.getTime() - 3 * HOUR_MS),
    );

    mockNarrativeStream(
      [
        "## Profile",
        "Riley manages the sample project.",
        "",
        "## Narrative",
        "The prototype review closed today.",
        "",
        "## Current",
        "This section must be stripped.",
      ].join("\n"),
    );
    mockReviewStream([resolvedThreadId]);

    await consolidateNarrative("incremental", now);

    const narrative = await getRelationshipNarrative();
    expect(narrative).not.toBeNull();
    expect(narrative!.content).toContain("The prototype review closed today.");
    expect(narrative!.content).not.toContain("## Current");
    expect(narrative!.version).toBe(1);
    expect(narrative!.consolidatedThrough.getTime()).toBe(now.getTime());

    const versions = await connection<
      { mode: string; version: number }[]
    >`select mode, version from relationship_narrative_versions`;
    expect(versions).toEqual([{ mode: "incremental", version: 1 }]);

    const threads = await connection<
      { id: string; resolved: boolean; updated_at: string }[]
    >`
      select id, resolved, updated_at from memories
      where id in ${connection([resolvedThreadId, ambiguousThreadId])}
    `;
    expect(
      Object.fromEntries(threads.map((row) => [row.id, row.resolved])),
    ).toEqual({
      [resolvedThreadId]: true,
      [ambiguousThreadId]: false,
    });
    // Flip stamped at the job-start sourceThrough: a later stamp would sit
    // past the advanced watermark and re-enter the next run's sources.
    const flipped = threads.find((row) => row.id === resolvedThreadId);
    expect(new Date(String(flipped!.updated_at)).getTime()).toBe(
      now.getTime(),
    );

    expect(provider.stream).toHaveBeenCalledTimes(2);
    // The chat provider/model is the primary candidate; the review rides it.
    expect(
      (provider.stream.mock.calls[0][0] as { model: string }).model,
    ).toBe("chat-test");
    expect(
      (provider.stream.mock.calls[1][0] as { model: string }).model,
    ).toBe("chat-test");
    const narrativePrompt = promptOfCall(0);
    expect(narrativePrompt).toContain("Seed from standing context.");
    expect(narrativePrompt).toContain("The prototype was approved this morning!");
    const reviewPrompt = promptOfCall(1);
    expect(reviewPrompt).toContain("Waiting on the prototype decision.");
    expect(reviewPrompt).toContain("The prototype was approved this morning!");
  });

  it("falls back to the consolidation provider and rides it for the review", async () => {
    const now = new Date();
    await setWatermark(new Date(now.getTime() - 25 * HOUR_MS));
    const sessionId = await createSession("Fallback run");
    await addMessage({
      sessionId,
      role: "user",
      content: "Material consolidated by the fallback.",
      completedAt: new Date(now.getTime() - HOUR_MS),
    });
    await addOpenThread(
      "Thread reviewed on the fallback path.",
      new Date(now.getTime() - 2 * HOUR_MS),
    );

    // Primary (chat) candidate fails mid-stream; the fallback produces the
    // narrative and the D16a review must reuse the same winning candidate.
    provider.stream.mockImplementationOnce(async function* () {
      throw new Error("relay down");
      yield { type: "text", text: "unreachable" };
    });
    mockNarrativeStream("## Narrative\nWritten by the fallback.");
    mockReviewStream([]);

    await consolidateNarrative("incremental", now);

    expect(provider.stream).toHaveBeenCalledTimes(3);
    const models = provider.stream.mock.calls.map(
      (call) => (call[0] as { model: string }).model,
    );
    expect(models).toEqual([
      "chat-test",
      "consolidation-test",
      "consolidation-test",
    ]);
    const narrative = await getRelationshipNarrative();
    expect(narrative!.content).toBe("## Narrative\nWritten by the fallback.");
    expect(narrative!.version).toBe(1);
  });

  it("excludes contaminated summaries and web-search turns from the sources", async () => {
    const now = new Date();
    const watermark = new Date(now.getTime() - 25 * HOUR_MS);
    await setWatermark(watermark);

    // Clean summary session: cursor advanced in the window, no search turns.
    const cleanSessionId = await createSession("Clean session");
    const coveredId = await addMessage({
      sessionId: cleanSessionId,
      role: "user",
      content: "Covered by the clean summary.",
      completedAt: new Date(now.getTime() - 6 * HOUR_MS),
    });
    void coveredId;
    const cleanCursorId = await addMessage({
      sessionId: cleanSessionId,
      role: "assistant",
      content: "Cursor turn of the clean summary.",
      completedAt: new Date(now.getTime() - 6 * HOUR_MS + 1000),
    });
    await addMessage({
      sessionId: cleanSessionId,
      role: "user",
      content: "After the clean cursor.",
      completedAt: new Date(now.getTime() - 5 * HOUR_MS),
    });
    await connection`
      update sessions
      set summary = 'Clean compressed span.',
          summary_through_message_id = ${cleanCursorId}
      where id = ${cleanSessionId}
    `;

    // Contaminated summary session: a covered assistant turn used web search.
    const dirtySessionId = await createSession("Dirty session");
    await addMessage({
      sessionId: dirtySessionId,
      role: "user",
      content: "Question that triggered a search.",
      completedAt: new Date(now.getTime() - 4 * HOUR_MS),
    });
    const dirtyCursorId = await addMessage({
      sessionId: dirtySessionId,
      role: "assistant",
      content: "Search-derived assistant answer.",
      completedAt: new Date(now.getTime() - 4 * HOUR_MS + 1000),
      usedWebSearch: true,
    });
    await connection`
      update sessions
      set summary = 'Contaminated compressed span.',
          summary_through_message_id = ${dirtyCursorId}
      where id = ${dirtySessionId}
    `;

    mockNarrativeStream("## Narrative\nRewritten.");

    await consolidateNarrative("incremental", now);

    const prompt = promptOfCall(0);
    expect(prompt).toContain("Clean compressed span.");
    expect(prompt).not.toContain("Covered by the clean summary.");
    expect(prompt).toContain("After the clean cursor.");
    expect(prompt).not.toContain("Contaminated compressed span.");
    expect(prompt).toContain("Question that triggered a search.");
    expect(prompt).not.toContain("Search-derived assistant answer.");
  });

  it("rebuilds from raw history with an empty record and tags the version", async () => {
    const now = new Date();
    const sessionId = await createSession("History");
    await addMessage({
      sessionId,
      role: "user",
      content: "Ancient turn well before the watermark.",
      completedAt: new Date(now.getTime() - 100 * 24 * HOUR_MS),
    });
    await connection`
      update relationship_narrative
      set content = '## Narrative\nDrifted current record.', version = 3
      where id = 1
    `;

    mockNarrativeStream("## Narrative\nRebuilt from scratch.");

    await consolidateNarrative("rebuild", now);

    const prompt = promptOfCall(0);
    expect(prompt).toContain("<record>\n(none)\n</record>");
    expect(prompt).toContain("Raw conversation history (chronological):");
    expect(prompt).toContain("Ancient turn well before the watermark.");

    const narrative = await getRelationshipNarrative();
    expect(narrative!.content).toBe("## Narrative\nRebuilt from scratch.");
    expect(narrative!.version).toBe(4);
    expect(narrative!.consolidatedThrough.getTime()).toBe(now.getTime());
    const versions = await connection<
      { mode: string }[]
    >`select mode from relationship_narrative_versions`;
    expect(versions).toEqual([{ mode: "rebuild" }]);
  });

  it("skips an empty incremental run but still consumes the window", async () => {
    const now = new Date();
    await setWatermark(new Date(now.getTime() - 25 * HOUR_MS));

    await consolidateNarrative("incremental", now);

    expect(provider.stream).not.toHaveBeenCalled();
    const narrative = await getRelationshipNarrative();
    expect(narrative!.version).toBe(0);
    // The watermark advances even without a write, or the tick predicate
    // would re-enqueue a no-op job every cycle.
    expect(narrative!.consolidatedThrough.getTime()).toBe(now.getTime());
  });

  it("warns when the settings row cannot seat every write cap (MC-121)", async () => {
    const now = new Date();
    await setWatermark(new Date(now.getTime() - 25 * HOUR_MS));
    // A row the schema would refuse (target 6400 at its cap alone is 9600):
    // only an SQL edit or a later ratio change gets one into the table.
    await connection`update settings set capsule_token_budget = 2000 where id = 1`;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await consolidateNarrative("incremental", now);

      expect(warn).toHaveBeenCalledWith("continuity_budget_invalid", {
        refusal: expect.stringMatching(/^Capsule 2000 is below the \d+ a full write needs/u),
      });
    } finally {
      warn.mockRestore();
      await connection`update settings set capsule_token_budget = 12000 where id = 1`;
    }
  });

  async function writeVersions(from: number, to: number) {
    for (let index = from; index <= to; index += 1) {
      await writeNarrativeVersion({
        content: `## Narrative\nVersion ${index}.`,
        mode: "manual",
      });
    }
  }

  async function listVersionNumbers() {
    const rows = await connection<{ version: number }[]>`
      select version from relationship_narrative_versions
      order by version asc
    `;
    return rows.map((row) => row.version);
  }

  it("keeps a same-day burst whole: the time floor dominates the count", async () => {
    // 9 manual saves in one sitting — the pre-2026-07-17 count-only rule
    // would keep [3..9] and evict every version predating the day, so the
    // diary's as-of baseline for the surrounding days would silently
    // degrade to null. All of them are younger than the as-of horizon, so
    // none may be pruned yet.
    await writeVersions(1, 9);

    expect(await listVersionNumbers()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const narrative = await getRelationshipNarrative();
    expect(narrative!.version).toBe(9);
    expect(narrative!.content).toBe("## Narrative\nVersion 9.");
  });

  it("resumes count pruning past the horizon but keeps the as-of anchor", async () => {
    await writeVersions(1, 9);
    // Age the burst past the as-of horizon, then keep writing.
    const agedMs =
      (NARRATIVE_AS_OF_RETENTION_DAYS + 1) * 24 * HOUR_MS;
    const aged = new Date(Date.now() - agedMs);
    await connection`
      update relationship_narrative_versions
      set created_at = ${aged.toISOString()}::timestamptz
      where version <= 9
    `;
    await writeVersions(10, 16);

    // v1..v8 are beyond the count window, older than the horizon, and not
    // the anchor — pruned. v9 is equally old and beyond the count window
    // but is the newest pre-horizon version: it survives as the anchor, so
    // every as-of instant inside the horizon still has an answer.
    expect(await listVersionNumbers()).toEqual([
      9, 10, 11, 12, 13, 14, 15, 16,
    ]);
    const dayStart = new Date(Date.now() - 24 * HOUR_MS);
    await expect(getNarrativeContentAsOf(dayStart)).resolves.toBe(
      "## Narrative\nVersion 9.",
    );
  });

  it("answers as-of with the newest predating version, null before any", async () => {
    await expect(
      getNarrativeContentAsOf(new Date()),
    ).resolves.toBeNull();

    await writeNarrativeVersion({
      content: "## Narrative\nFirst.",
      mode: "manual",
    });
    // The first version's createdAt is stamped at writeNarrativeVersion
    // entry; a same-millisecond capture here would make the strict
    // createdAt < instant filter exclude it and flake the assertion.
    await new Promise((resolve) => setTimeout(resolve, 2));
    const betweenWrites = new Date();
    await writeNarrativeVersion({
      content: "## Narrative\nSecond.",
      mode: "manual",
    });

    await expect(
      getNarrativeContentAsOf(betweenWrites),
    ).resolves.toBe("## Narrative\nFirst.");
    // A version created at-or-after the instant never answers for it: the
    // diary must not see a same-day record (D22 baseline geometry).
    const beforeEverything = new Date(Date.now() - 24 * HOUR_MS);
    await expect(
      getNarrativeContentAsOf(beforeEverything),
    ).resolves.toBeNull();
  });

  it("manual versions never advance the watermark", async () => {
    const watermark = new Date("2026-07-01T00:00:00Z");
    await setWatermark(watermark);

    const written = await writeNarrativeVersion({
      content: "## Profile\nManual edit.",
      mode: "manual",
    });

    expect(written.version).toBe(1);
    expect(written.consolidatedThrough.getTime()).toBe(watermark.getTime());
    const versions = await connection<
      { mode: string }[]
    >`select mode from relationship_narrative_versions`;
    expect(versions).toEqual([{ mode: "manual" }]);
  });

  it("records carrier provenance on generated versions, none on manual", async () => {
    await writeNarrativeVersion({
      content: "## Narrative\nGenerated.",
      mode: "incremental",
      provenance: {
        provider: "chat",
        model: "chat-test",
        host: "api.anthropic.com",
      },
    });
    await writeNarrativeVersion({
      content: "## Narrative\nManual.",
      mode: "manual",
    });

    const versions = await connection<
      {
        mode: string;
        provider: string | null;
        model: string | null;
        host: string | null;
      }[]
    >`select mode, provider, model, host from relationship_narrative_versions order by version`;
    expect(versions).toEqual([
      {
        mode: "incremental",
        provider: "chat",
        model: "chat-test",
        host: "api.anthropic.com",
      },
      { mode: "manual", provider: null, model: null, host: null },
    ]);
  });

  it("fails the job on a manual edit landing mid-consolidation", async () => {
    const now = new Date();
    await setWatermark(new Date(now.getTime() - 25 * HOUR_MS));
    const sessionId = await createSession("Race");
    await addMessage({
      sessionId,
      role: "user",
      content: "Material for the racing consolidation.",
      completedAt: new Date(now.getTime() - HOUR_MS),
    });

    provider.stream.mockImplementationOnce(async function* () {
      await writeNarrativeVersion({
        content: "## Profile\nManual edit during the model call.",
        mode: "manual",
      });
      yield { type: "text", text: "## Narrative\nStale rewrite." };
      yield { type: "done", finishReason: "end_turn" };
    });

    await expect(consolidateNarrative("incremental", now)).rejects.toThrow(
      NarrativeVersionConflictError,
    );

    const narrative = await getRelationshipNarrative();
    expect(narrative!.content).toBe(
      "## Profile\nManual edit during the model call.",
    );
    expect(narrative!.version).toBe(1);
  });

  it("leaves the narrative and threads untouched when the provider fails", async () => {
    const now = new Date();
    const watermark = new Date(now.getTime() - 25 * HOUR_MS);
    await setWatermark(watermark);
    const sessionId = await createSession("Failing run");
    await addMessage({
      sessionId,
      role: "user",
      content: "Material that will not be consolidated.",
      completedAt: new Date(now.getTime() - HOUR_MS),
    });
    const threadId = await addOpenThread(
      "Still open after the failure.",
      new Date(now.getTime() - 2 * HOUR_MS),
    );

    // Every candidate in the provider chain fails.
    provider.stream.mockImplementation(async function* () {
      throw new Error("provider down");
      yield { type: "text", text: "unreachable" };
    });

    await expect(consolidateNarrative("incremental", now)).rejects.toThrow(
      "provider down",
    );

    const narrative = await getRelationshipNarrative();
    expect(narrative!.content).toBe("");
    expect(narrative!.version).toBe(0);
    expect(narrative!.consolidatedThrough.getTime()).toBe(
      watermark.getTime(),
    );
    const versions = await connection<
      { id: string }[]
    >`select id from relationship_narrative_versions`;
    expect(versions).toHaveLength(0);
    const [thread] = await connection<
      { resolved: boolean }[]
    >`select resolved from memories where id = ${threadId}`;
    expect(thread.resolved).toBe(false);
  });

  it("gates the tick predicate on idle, interval, and new material", async () => {
    const now = new Date();
    const sessionId = await createSession("Predicate");
    await addMessage({
      sessionId,
      role: "user",
      content: "Completed twenty minutes ago.",
      completedAt: new Date(now.getTime() - 20 * 60 * 1000),
    });

    // Interval not yet elapsed.
    await setWatermark(new Date(now.getTime() - HOUR_MS));
    await expect(
      shouldEnqueueNarrativeConsolidation(
        await newestCompletedMessageAt(),
        now,
      ),
    ).resolves.toBe(false);

    // Idle + interval elapsed + new material.
    await setWatermark(new Date(now.getTime() - 25 * HOUR_MS));
    await expect(
      shouldEnqueueNarrativeConsolidation(
        await newestCompletedMessageAt(),
        now,
      ),
    ).resolves.toBe(true);

    // Episode still active.
    await addMessage({
      sessionId,
      role: "user",
      content: "Completed five minutes ago.",
      completedAt: new Date(now.getTime() - 5 * 60 * 1000),
    });
    await expect(
      shouldEnqueueNarrativeConsolidation(
        await newestCompletedMessageAt(),
        now,
      ),
    ).resolves.toBe(false);

    // No material newer than the watermark.
    await connection`
      delete from messages where session_id = ${sessionId}
    `;
    await addMessage({
      sessionId,
      role: "user",
      content: "Completed before the watermark.",
      completedAt: new Date(now.getTime() - 26 * HOUR_MS),
    });
    await expect(
      shouldEnqueueNarrativeConsolidation(
        await newestCompletedMessageAt(),
        now,
      ),
    ).resolves.toBe(false);

    // Memory-only change past the watermark fires the predicate: the job
    // reads memory rows as sources, so the trigger must see them too.
    const memoryId = await addOpenThread(
      "Edited during a quiet period.",
      new Date(now.getTime() - 2 * HOUR_MS),
    );
    await expect(
      shouldEnqueueNarrativeConsolidation(
        await newestCompletedMessageAt(),
        now,
      ),
    ).resolves.toBe(true);

    // A row stamped exactly at the watermark (the job's own resolution
    // flips) does not re-trigger; strictly-older rows do not either.
    await connection`
      update memories
      set updated_at = (
        select consolidated_through from relationship_narrative where id = 1
      )
      where id = ${memoryId}
    `;
    await expect(
      shouldEnqueueNarrativeConsolidation(
        await newestCompletedMessageAt(),
        now,
      ),
    ).resolves.toBe(false);

    // Soft-deleted rows never enter the job's sources, so they do not
    // trigger it (known gap: pure deletions reach the narrative only via
    // rebuild — recorded in the ticket).
    await connection`
      update memories
      set updated_at = ${new Date(now.getTime() - HOUR_MS).toISOString()}::timestamptz,
          deleted_at = now()
      where id = ${memoryId}
    `;
    await expect(
      shouldEnqueueNarrativeConsolidation(
        await newestCompletedMessageAt(),
        now,
      ),
    ).resolves.toBe(false);
  });

  it("enqueues one singleton job from the tick and dedupes repeats", async () => {
    const now = new Date();
    const sessionId = await createSession("Tick");
    await addMessage({
      sessionId,
      role: "user",
      content: "Idle material past the watermark.",
      completedAt: new Date(now.getTime() - 20 * 60 * 1000),
    });
    await setWatermark(new Date(now.getTime() - 25 * HOUR_MS));

    await maybeEnqueueContinuityJobs(now);
    await maybeEnqueueContinuityJobs(now);

    const jobs = await connection<
      { payload: { mode: string } }[]
    >`
      select payload from jobs
      where type = 'consolidate_narrative' and status = 'pending'
    `;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload).toMatchObject({ mode: "incremental" });

    // Dedupe is per mode: an owner-requested rebuild queues alongside the
    // pending incremental instead of being swallowed by it, while a second
    // rebuild collapses into the first.
    await expect(
      enqueueJob("consolidate_narrative", { mode: "rebuild" }),
    ).resolves.toBeTruthy();
    await expect(
      enqueueJob("consolidate_narrative", { mode: "rebuild" }),
    ).resolves.toBeNull();
    const afterRebuild = await connection<
      { payload: { mode: string } }[]
    >`
      select payload from jobs
      where type = 'consolidate_narrative' and status = 'pending'
    `;
    expect(afterRebuild).toHaveLength(2);
  });
});
