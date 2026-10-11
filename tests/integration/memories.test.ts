import { NextRequest } from "next/server";
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
  embed: vi.fn(),
}));

vi.mock("@/server/auth/request", () => ({
  requireOwner: vi.fn(async () => null),
}));
vi.mock("@/server/chat/anthropic", () => ({
  getCompressionProvider: () => ({ stream: provider.stream }),
  getExtractionProvider: () => ({ stream: provider.stream }),
}));
vi.mock("@/server/memory/embedding", () => ({
  getEmbeddingProvider: () => ({
    dimensions: 1536,
    embed: provider.embed,
  }),
  isMemoryEnabled: () => true,
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

import {
  countActive,
  permanentlyDeleteMemory,
  insertMemory,
  retrieveByVector,
  restoreMemory,
  searchActive,
  searchDeleted,
  softDeleteMemory,
  updateMemoryEmbedding,
  updateRecall,
} from "@/server/db/memories";
import { ProviderError } from "@/server/chat/provider-error";
import { enqueueJob } from "@/server/db/jobs";
import { closeDatabase } from "@/server/db/client";
import { runNextJob } from "@/server/jobs/worker";
import {
  EPISODE_IDLE_MS,
  MAX_EXTRACTION_SPAN_TOKENS,
  maybeEnqueueContinuityJobs,
  sessionsNeedingMemoryExtraction,
} from "@/server/jobs/continuity";
import { completeGeneration } from "@/server/db/chat";
import { hashMemoryContent } from "@/server/memory/extract";
import { retrieveMemories } from "@/server/memory/retrieve";
import {
  SUPPRESSION_REASON_CUE,
  SUPPRESSION_REASON_LIMIT,
  SUPPRESSION_REASON_SESSION_REPEAT,
} from "@/server/memory/score";
import { PATCH } from "@/app/api/memories/[id]/route";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

function vector(first: number, second = 0): number[] {
  return [first, second, ...Array.from({ length: 1534 }, () => 0)];
}

describeWithDatabase("long-term memories", () => {
  const connection = postgres(testDatabaseUrl!, { max: 5, prepare: false });
  const database = drizzle(connection);
  const sessionIds: string[] = [];

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    await migrate(database, { migrationsFolder: "drizzle" });
  });

  beforeEach(async () => {
    await connection`delete from jobs`;
    await connection`delete from memory_injections`;
    await connection`delete from memories`;
    await connection`delete from sessions`;
    sessionIds.length = 0;
    provider.stream.mockImplementation(async function* () {
      yield {
        type: "text",
        text: JSON.stringify({
          memories: [
            {
              content: "The user prefers concise technical explanations.",
              importance: 0.7,
              valence: 0.1,
              arousal: 0.2,
              resolved: true,
            },
          ],
        }),
      };
      yield { type: "done", finishReason: "end_turn" };
    });
    provider.embed.mockImplementation(async (inputs: string[]) =>
      inputs.map(() => vector(1)),
    );
  });

  afterEach(async () => {
    await connection`
      delete from jobs
      where type in (
        'extract_memories',
        'embed_memory',
        'update_recent_snapshot',
        'consolidate_narrative'
      )
    `;
    // The defer test rewinds the singleton narrative watermark; the test
    // database persists across files and runs, so restore it here.
    await connection`
      update relationship_narrative
      set consolidated_through = now()
      where id = 1
    `;
    await connection`delete from memories`;
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
      insert into sessions (model_id) values ('claude-opus-4-6') returning id
    `;
    sessionIds.push(session.id);
    return session.id;
  }

  async function createUserMessage(
    sessionId: string,
    content: string,
    createdAt: Date,
  ) {
    const [message] = await connection<{ id: string }[]>`
      insert into messages (
        session_id, role, content, status, model_id, created_at, completed_at
      ) values (
        ${sessionId},
        'user',
        ${content},
        'complete',
        'claude-opus-4-6',
        ${createdAt.toISOString()}::timestamptz,
        ${createdAt.toISOString()}::timestamptz
      ) returning id
    `;
    return message;
  }

  async function createCompletedTurn(input: {
    sessionId: string;
    userContent: string;
    assistantContent: string;
    createdAt: Date;
    usedWebSearch?: boolean;
  }) {
    const user = await createUserMessage(
      input.sessionId,
      input.userContent,
      input.createdAt,
    );
    const assistantAt = new Date(input.createdAt.getTime() + 1000);
    const [assistant] = await connection<{ id: string }[]>`
      insert into messages (
        session_id,
        role,
        content,
        status,
        model_id,
        used_web_search,
        created_at,
        completed_at
      ) values (
        ${input.sessionId},
        'assistant',
        ${input.assistantContent},
        'complete',
        'claude-opus-4-6',
        ${input.usedWebSearch ?? false},
        ${assistantAt.toISOString()}::timestamptz,
        ${assistantAt.toISOString()}::timestamptz
      ) returning id
    `;
    return { user, assistant };
  }

  function memoryCandidate(input: {
    content: string;
    kind?: string;
    embedding?: number[];
    importance?: number;
    arousal?: number;
    resolved?: boolean;
  }) {
    return {
      content: input.content,
      kind: input.kind ?? "shared_moment",
      embedding: input.embedding ?? vector(0.8, 0.6),
      importance: input.importance ?? 0.5,
      valence: 0,
      arousal: input.arousal ?? 0,
      resolved: input.resolved ?? false,
      sourceSessionId: null,
      sourceMessageId: null,
      contentHash: input.content,
    };
  }

  it("extracts once and skips an exact active duplicate", async () => {
    const firstSessionId = await createSession();
    const secondSessionId = await createSession();
    await createCompletedTurn({
      sessionId: firstSessionId,
      userContent: "Please keep explanations concise.",
      assistantContent: "Understood.",
      createdAt: new Date("2026-07-06T10:00:00Z"),
    });
    await createCompletedTurn({
      sessionId: secondSessionId,
      userContent: "Concise answers are still preferred.",
      assistantContent: "Understood.",
      createdAt: new Date("2026-07-06T10:05:00Z"),
    });
    await enqueueJob("extract_memories", { sessionId: firstSessionId });
    await enqueueJob("extract_memories", { sessionId: secondSessionId });

    expect(await runNextJob()).toBe(true);
    expect(await runNextJob()).toBe(true);

    const rows = await connection<{ content: string; content_hash: string }[]>`
      select content, content_hash from memories
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].content_hash).toBe(
      await hashMemoryContent(rows[0].content),
    );
  });

  it("enqueues one idle windowed extraction per session from the continuity tick", async () => {
    const now = new Date("2026-07-06T12:00:00Z");
    const sessionId = await createSession();
    await createCompletedTurn({
      sessionId,
      userContent: "Please remember this after the episode.",
      assistantContent: "I will consider it after the idle boundary.",
      createdAt: new Date(now.getTime() - EPISODE_IDLE_MS - 60_000),
    });

    await maybeEnqueueContinuityJobs(now);
    await maybeEnqueueContinuityJobs(now);

    const rows = await connection<
      { type: string; payload: { sessionId?: string } }[]
    >`
      select type, payload
      from jobs
      where type in ('extract_memories', 'update_recent_snapshot')
      order by type
    `;
    expect(rows).toEqual([
      { type: "extract_memories", payload: { sessionId } },
      {
        type: "update_recent_snapshot",
        payload: { sourceKey: expect.stringMatching(/\|p1$/) },
      },
    ]);
  });

  it("defers narrative consolidation until extraction is caught up", async () => {
    const now = new Date("2026-07-06T12:00:00Z");
    const sessionId = await createSession();
    const turn = await createCompletedTurn({
      sessionId,
      userContent: "Please retain this before updating the narrative.",
      assistantContent: "I will extract it first.",
      createdAt: new Date(now.getTime() - EPISODE_IDLE_MS - 60_000),
    });
    await connection`
      update relationship_narrative
      set consolidated_through = ${new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString()}::timestamptz
      where id = 1
    `;

    await maybeEnqueueContinuityJobs(now);
    const beforeExtraction = await connection<{ type: string }[]>`
      select type from jobs
      where type in ('extract_memories', 'consolidate_narrative')
      order by type
    `;
    expect(beforeExtraction).toEqual([{ type: "extract_memories" }]);

    await connection`
      update sessions
      set extracted_through_message_id = ${turn.assistant.id}
      where id = ${sessionId}
    `;
    await maybeEnqueueContinuityJobs(new Date(now.getTime() + 60_000));

    const afterExtraction = await connection<{ type: string }[]>`
      select type from jobs
      where type = 'consolidate_narrative'
    `;
    expect(afterExtraction).toEqual([{ type: "consolidate_narrative" }]);
  });

  it("uses the token-span backstop before the episode is idle", async () => {
    const now = new Date("2026-07-06T12:00:00Z");
    const sessionId = await createSession();
    await createCompletedTurn({
      sessionId,
      userContent: "x".repeat(MAX_EXTRACTION_SPAN_TOKENS * 3),
      assistantContent: "Recent but too large to wait.",
      createdAt: new Date(now.getTime() - 60_000),
    });

    await expect(
      sessionsNeedingMemoryExtraction(now),
    ).resolves.toContain(sessionId);
  });

  it("advances the extraction cursor for an empty window and excludes web-search exchanges", async () => {
    const sessionId = await createSession();
    const searched = await createCompletedTurn({
      sessionId,
      userContent: "Search the web for the current deployment policy.",
      assistantContent: "Web-derived answer.",
      usedWebSearch: true,
      createdAt: new Date("2026-07-06T10:00:00Z"),
    });
    const normal = await createCompletedTurn({
      sessionId,
      userContent: "This local preference can be reviewed.",
      assistantContent: "Understood without using web search.",
      createdAt: new Date("2026-07-06T10:05:00Z"),
    });
    const prompts: string[] = [];
    provider.stream.mockImplementation(async function* (request: {
      messages: { content: string }[];
    }) {
      // Extraction carries the system identity frame at index 0; the task
      // prompt is the trailing user message.
      prompts.push(request.messages.at(-1)!.content);
      yield { type: "text", text: JSON.stringify({ memories: [] }) };
      yield { type: "done", finishReason: "end_turn" };
    });

    await enqueueJob("extract_memories", { sessionId });
    expect(await runNextJob()).toBe(true);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain("Search the web");
    expect(prompts[0]).not.toContain(searched.assistant.id);
    expect(prompts[0]).toContain("This local preference can be reviewed.");
    const [session] = await connection<
      { extracted_through_message_id: string | null }[]
    >`
      select extracted_through_message_id
      from sessions
      where id = ${sessionId}
    `;
    expect(session.extracted_through_message_id).toBe(normal.assistant.id);
    const [{ count }] = await connection<{ count: number }[]>`
      select count(*)::int as count from memories
    `;
    expect(count).toBe(0);
  });

  it("re-advances the extraction cursor a rewrite swap set-nulled without duplicate memories (MC-116B)", async () => {
    // Commit-time race (MC-116B decision 4 / AC7): extraction consumed the
    // old tail pair while its replacement streamed; the swap deletes the
    // cursor row (FK set-null) and the next extraction pass replays the
    // whole session — the exact contentHash guard blocks duplicates and
    // the cursor re-advances to the replacement tail.
    const sessionId = await createSession();
    await createCompletedTurn({
      sessionId,
      userContent: "Please keep explanations short.",
      assistantContent: "Noted.",
      createdAt: new Date("2026-07-06T10:00:00Z"),
    });
    const old = await createCompletedTurn({
      sessionId,
      userContent: "Old tail question",
      assistantContent: "Old tail reply",
      createdAt: new Date("2026-07-06T10:05:00Z"),
    });

    await enqueueJob("extract_memories", { sessionId });
    expect(await runNextJob()).toBe(true);
    const [afterFirst] = await connection<
      { extracted_through_message_id: string | null }[]
    >`
      select extracted_through_message_id from sessions
      where id = ${sessionId}
    `;
    expect(afterFirst.extracted_through_message_id).toBe(old.assistant.id);

    // The streaming replacement pair, then the swap.
    const [replacementUser] = await connection<{ id: string }[]>`
      insert into messages (
        session_id, role, content, status, model_id, metadata,
        created_at, completed_at
      ) values (
        ${sessionId}, 'user', 'Edited tail question', 'complete',
        'claude-opus-4-6',
        ${JSON.stringify({ supersedes: old.user.id })}::jsonb,
        '2026-07-06T10:10:00Z'::timestamptz,
        '2026-07-06T10:10:00Z'::timestamptz
      ) returning id
    `;
    const [replacementAssistant] = await connection<{ id: string }[]>`
      insert into messages (
        session_id, role, content, status, model_id, created_at
      ) values (
        ${sessionId}, 'assistant', '', 'streaming', 'claude-opus-4-6',
        '2026-07-06T10:10:00.001Z'::timestamptz
      ) returning id
    `;
    await completeGeneration({
      assistantMessageId: replacementAssistant.id,
      content: "Better tail reply",
      supersede: {
        sessionId,
        userMessageId: old.user.id,
        assistantMessageId: old.assistant.id,
        replacementUserMessageId: replacementUser.id,
      },
    });
    const [afterSwap] = await connection<
      { extracted_through_message_id: string | null }[]
    >`
      select extracted_through_message_id from sessions
      where id = ${sessionId}
    `;
    expect(afterSwap.extracted_through_message_id).toBeNull();

    // The replay re-generates the same candidate (default mock): exact
    // contentHash blocks the insert, the cursor re-advances.
    await enqueueJob("extract_memories", { sessionId });
    expect(await runNextJob()).toBe(true);
    const [afterReplay] = await connection<
      { extracted_through_message_id: string | null }[]
    >`
      select extracted_through_message_id from sessions
      where id = ${sessionId}
    `;
    expect(afterReplay.extracted_through_message_id).toBe(
      replacementAssistant.id,
    );
    const memories = await connection<{ content: string }[]>`
      select content from memories
    `;
    expect(memories).toHaveLength(1);
    expect(memories[0].content).toBe(
      "The user prefers concise technical explanations.",
    );
  });

  it("skips near-duplicate extraction inserts by same-kind embedding similarity", async () => {
    const sessionId = await createSession();
    await createCompletedTurn({
      sessionId,
      userContent: "Please keep explanations short.",
      assistantContent: "I will keep that in mind.",
      createdAt: new Date("2026-07-06T10:00:00Z"),
    });
    const existing = await insertMemory({
      content: "Existing concise-answer boundary",
      kind: "boundary_fact",
      embedding: vector(1),
      importance: 0.8,
      valence: 0,
      arousal: 0,
      resolved: true,
      sourceSessionId: null,
      sourceMessageId: null,
      contentHash: "existing-boundary",
    });
    provider.stream.mockImplementation(async function* () {
      yield {
        type: "text",
        text: JSON.stringify({
          memories: [
            {
              content: "They prefer concise technical answers.",
              kind: "boundary_fact",
              importance: 0.8,
              valence: 0,
              arousal: 0,
              resolved: true,
            },
          ],
        }),
      };
      yield { type: "done", finishReason: "end_turn" };
    });
    const consoleInfo = vi
      .spyOn(console, "info")
      .mockImplementation(() => undefined);

    await enqueueJob("extract_memories", { sessionId });
    expect(await runNextJob()).toBe(true);

    const rows = await connection<{ id: string }[]>`
      select id from memories order by created_at
    `;
    expect(rows.map((row) => row.id)).toEqual([existing.id]);
    expect(consoleInfo).toHaveBeenCalledWith(
      "memory_near_duplicate_skip",
      expect.objectContaining({
        path: "extract",
        matchedMemoryId: existing.id,
      }),
    );
    consoleInfo.mockRestore();
  });

  it("deletes a manual memory at embed time when it is a near duplicate", async () => {
    const existing = await insertMemory({
      content: "Existing duplicate candidate",
      kind: "shared_moment",
      embedding: vector(1),
      importance: 0.7,
      valence: 0,
      arousal: 0,
      resolved: true,
      sourceSessionId: null,
      sourceMessageId: null,
      contentHash: "existing-shared",
    });
    const [duplicate] = await connection<{ id: string; content_hash: string }[]>`
      insert into memories (
        content,
        kind,
        importance,
        valence,
        arousal,
        resolved,
        content_hash
      ) values (
        'Manual duplicate candidate',
        'shared_moment',
        0.7,
        0,
        0,
        true,
        'manual-duplicate'
      ) returning id, content_hash
    `;
    const consoleInfo = vi
      .spyOn(console, "info")
      .mockImplementation(() => undefined);

    await enqueueJob("embed_memory", { memoryId: duplicate.id });
    expect(await runNextJob()).toBe(true);

    const rows = await connection<{ id: string }[]>`
      select id from memories order by created_at
    `;
    expect(rows.map((row) => row.id)).toEqual([existing.id]);
    expect(consoleInfo).toHaveBeenCalledWith(
      "memory_near_duplicate_skip",
      expect.objectContaining({
        path: "embed",
        memoryId: duplicate.id,
        matchedMemoryId: existing.id,
      }),
    );
    consoleInfo.mockRestore();
  });

  it("filters superseded memories out of vector retrieval and exposes the chain", async () => {
    const replacement = await insertMemory(
      memoryCandidate({
        content: "Replacement boundary memory",
        kind: "boundary_fact",
        embedding: vector(1),
      }),
    );
    const old = await insertMemory(
      memoryCandidate({
        content: "Old boundary memory",
        kind: "boundary_fact",
        embedding: vector(0.99, Math.sqrt(1 - 0.99 ** 2)),
      }),
    );
    await connection`
      update memories set superseded_by = ${replacement.id}
      where id = ${old.id}
    `;

    await expect(
      retrieveByVector(vector(1)),
    ).resolves.toMatchObject([{ id: replacement.id }]);
    const rows = await searchActive({
      query: "boundary memory",
      limit: 50,
      offset: 0,
    });
    expect(rows.map((row) => row.id).sort()).toEqual(
      [old.id, replacement.id].sort(),
    );
  });

  it("lets content matching only a superseded memory re-enter through extraction", async () => {
    const sessionId = await createSession();
    await createCompletedTurn({
      sessionId,
      userContent: "The sample project uses the west region again.",
      assistantContent: "Good to know — updating the project region.",
      createdAt: new Date("2026-07-06T10:00:00Z"),
    });
    const content = "The sample project uses the west region again.";
    const replacement = await insertMemory(
      memoryCandidate({
        content: "The sample project uses the east region now.",
        kind: "boundary_fact",
        embedding: vector(0, 1),
      }),
    );
    const old = await insertMemory({
      ...memoryCandidate({
        content,
        kind: "boundary_fact",
        embedding: vector(1),
      }),
      contentHash: await hashMemoryContent(content),
    });
    await connection`
      update memories set superseded_by = ${replacement.id}
      where id = ${old.id}
    `;
    provider.stream.mockImplementation(async function* () {
      yield {
        type: "text",
        text: JSON.stringify({
          memories: [
            {
              content,
              kind: "boundary_fact",
              importance: 0.8,
              valence: 0,
              arousal: 0,
              resolved: true,
            },
          ],
        }),
      };
      yield { type: "done", finishReason: "end_turn" };
    });

    await enqueueJob("extract_memories", { sessionId });
    expect(await runNextJob()).toBe(true);

    const rows = await connection<
      { content: string; superseded_by: string | null }[]
    >`
      select content, superseded_by from memories order by created_at
    `;
    expect(rows).toHaveLength(3);
    expect(rows[2]).toEqual({ content, superseded_by: null });
  });

  it("keeps a manual memory at embed time when its only near duplicate is superseded", async () => {
    const replacement = await insertMemory(
      memoryCandidate({
        content: "Replacement shared moment",
        embedding: vector(0, 1),
      }),
    );
    const old = await insertMemory(
      memoryCandidate({
        content: "Old shared moment",
        embedding: vector(1),
      }),
    );
    await connection`
      update memories set superseded_by = ${replacement.id}
      where id = ${old.id}
    `;
    const [manual] = await connection<{ id: string }[]>`
      insert into memories (
        content, kind, importance, valence, arousal, resolved, content_hash
      ) values (
        'Manual re-add of the moment', 'shared_moment', 0.7, 0, 0, true,
        'manual-re-add'
      ) returning id
    `;

    await enqueueJob("embed_memory", { memoryId: manual.id });
    expect(await runNextJob()).toBe(true);

    const [row] = await connection<{ embedding: string | null }[]>`
      select embedding::text as embedding from memories where id = ${manual.id}
    `;
    expect(row.embedding).not.toBeNull();
  });

  it("rejects a supersede edit that would close a cycle", async () => {
    const first = await insertMemory(
      memoryCandidate({ content: "First chain memory" }),
    );
    const second = await insertMemory(
      memoryCandidate({ content: "Second chain memory" }),
    );

    const forward = await PATCH(
      new NextRequest(`http://localhost/api/memories/${first.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ supersededBy: second.id }),
      }),
      { params: Promise.resolve({ id: first.id }) },
    );
    expect(forward.status).toBe(200);

    const backward = await PATCH(
      new NextRequest(`http://localhost/api/memories/${second.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ supersededBy: first.id }),
      }),
      { params: Promise.resolve({ id: second.id }) },
    );
    expect(backward.status).toBe(400);
    const [row] = await connection<{ superseded_by: string | null }[]>`
      select superseded_by from memories where id = ${second.id}
    `;
    expect(row.superseded_by).toBeNull();
  });

  it("skips the window and fails the row when extraction output is truncated (MC-118)", async () => {
    const sessionId = await createSession();
    const turn = await createCompletedTurn({
      sessionId,
      userContent: "A rich window that overflows the output budget.",
      assistantContent: "The reply the model wants to memorialize at length.",
      createdAt: new Date("2026-07-06T10:00:00Z"),
    });
    provider.stream.mockImplementation(async function* () {
      yield { type: "text", text: '{"memories": [' };
      yield { type: "done", finishReason: "max_tokens" };
    });

    await enqueueJob("extract_memories", { sessionId });
    expect(await runNextJob()).toBe(true);

    const [job] = await connection<
      { status: string; last_error: string | null }[]
    >`
      select status, last_error from jobs where type = 'extract_memories'
    `;
    const [session] = await connection<
      { extracted_through_message_id: string | null }[]
    >`
      select extracted_through_message_id from sessions where id = ${sessionId}
    `;
    // A model-output termination is never re-sent: the MC-106 skip policy
    // runs at once, the row reads failed (never complete), and last_error
    // carries old → new cursor plus the termination record.
    expect(job.status).toBe("failed");
    expect(job.last_error).toContain("Memory extraction window skipped");
    expect(job.last_error).toContain("ended early (finish reason: max_tokens)");
    expect(session.extracted_through_message_id).toBe(turn.assistant.id);
    expect(
      await connection<{ id: string }[]>`select id from memories`,
    ).toHaveLength(0);
  });

  it("skips the window and fails the row when extraction output is unparseable (MC-118)", async () => {
    const sessionId = await createSession();
    const turn = await createCompletedTurn({
      sessionId,
      userContent: "This reply will come back malformed.",
      assistantContent: "The model answers in broken JSON this time.",
      createdAt: new Date("2026-07-06T10:00:00Z"),
    });
    provider.stream.mockImplementation(async function* () {
      yield { type: "text", text: '{"memories": [}' };
      yield { type: "done", finishReason: "end_turn" };
    });

    await enqueueJob("extract_memories", { sessionId });
    expect(await runNextJob()).toBe(true);

    const [job] = await connection<
      { status: string; last_error: string | null }[]
    >`
      select status, last_error from jobs where type = 'extract_memories'
    `;
    const [session] = await connection<
      { extracted_through_message_id: string | null }[]
    >`
      select extracted_through_message_id from sessions where id = ${sessionId}
    `;
    expect(job.status).toBe("failed");
    expect(job.last_error).toContain("not valid JSON");
    expect(job.last_error).toContain("excerpt:");
    expect(session.extracted_through_message_id).toBe(turn.assistant.id);
  });

  it("skips a failing extraction window on the final attempt", async () => {
    const sessionId = await createSession();
    const turn = await createCompletedTurn({
      sessionId,
      userContent: "This window will fail extraction.",
      assistantContent: "The raw history remains recoverable.",
      createdAt: new Date("2026-07-06T10:00:00Z"),
    });
    provider.stream.mockImplementation(async function* () {
      throw new Error("compression unavailable");
    });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    await connection`
      insert into jobs (type, payload, attempts)
      values (
        'extract_memories',
        ${JSON.stringify({ sessionId })}::jsonb,
        2
      )
    `;

    expect(await runNextJob()).toBe(true);

    const [job] = await connection<{ status: string }[]>`
      select status from jobs where type = 'extract_memories'
    `;
    const [session] = await connection<
      { extracted_through_message_id: string | null }[]
    >`
      select extracted_through_message_id from sessions where id = ${sessionId}
    `;
    // Skipped is a loss, and the row says so: failed, never complete.
    expect(job.status).toBe("failed");
    expect(session.extracted_through_message_id).toBe(turn.assistant.id);
    expect(consoleError).toHaveBeenCalledWith(
      "Memory extraction window skipped after final failure.",
      expect.objectContaining({ sessionId }),
    );
    consoleError.mockRestore();
  });

  it("keeps the window and re-pends on a transient, non-final failure", async () => {
    const sessionId = await createSession();
    await createCompletedTurn({
      sessionId,
      userContent: "The relay is down for a moment.",
      assistantContent: "This window must survive the outage.",
      createdAt: new Date("2026-07-06T10:00:00Z"),
    });
    provider.stream.mockImplementation(async function* () {
      throw new ProviderError("PROVIDER_UNAVAILABLE", "relay down");
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await enqueueJob("extract_memories", { sessionId });
    expect(await runNextJob()).toBe(true);

    const [job] = await connection<
      { status: string; attempts: number; last_error: string | null }[]
    >`
      select status, attempts, last_error from jobs where type = 'extract_memories'
    `;
    const [session] = await connection<
      { extracted_through_message_id: string | null }[]
    >`
      select extracted_through_message_id from sessions where id = ${sessionId}
    `;
    expect(job).toMatchObject({ status: "pending", attempts: 1 });
    expect(job.last_error).toContain("relay down");
    expect(session.extracted_through_message_id).toBeNull();
    expect(
      await connection<{ id: string }[]>`select id from memories`,
    ).toHaveLength(0);
  });

  it("moves memories to trash, restores them, and permanently deletes them", async () => {
    const common = {
      kind: "shared_moment",
      importance: 0.5,
      valence: 0,
      arousal: 0,
      resolved: false,
      sourceSessionId: null,
      sourceMessageId: null,
    };
    const first = await insertMemory({
      ...common,
      content: "Closest memory",
      embedding: vector(1),
      contentHash: "closest",
    });
    const second = await insertMemory({
      ...common,
      content: "Less similar memory",
      embedding: vector(0.5, 0.5),
      contentHash: "second",
    });

    expect(
      (await retrieveByVector(vector(1))).map((memory) => memory.id),
    ).toEqual([first.id, second.id]);
    expect(await softDeleteMemory(first.id)).toBe(true);
    expect(
      (await retrieveByVector(vector(1))).map((memory) => memory.id),
    ).toEqual([second.id]);
    expect(
      (await searchDeleted({ limit: 50, offset: 0 })).map(
        (memory) => memory.id,
      ),
    ).toContain(first.id);

    expect(await restoreMemory(first.id)).toBe(true);
    expect(
      (await retrieveByVector(vector(1))).map((memory) => memory.id),
    ).toEqual([first.id, second.id]);
    expect(await permanentlyDeleteMemory(first.id)).toBe(false);

    expect(await softDeleteMemory(first.id)).toBe(true);
    expect(await permanentlyDeleteMemory(first.id)).toBe(true);
    const [{ count }] = await connection<{ count: number }[]>`
      select count(*)::int as count from memories where id = ${first.id}
    `;
    expect(count).toBe(0);
  });

  it("filters active memories by kind", async () => {
    const boundary = await insertMemory(
      memoryCandidate({
        content: "Kind filtered boundary memory",
        kind: "boundary_fact",
      }),
    );
    await insertMemory(
      memoryCandidate({
        content: "Kind filtered shared memory",
        kind: "shared_moment",
      }),
    );

    await expect(
      searchActive({
        query: "Kind filtered",
        kind: "boundary_fact",
        limit: 50,
        offset: 0,
      }),
    ).resolves.toMatchObject([{ id: boundary.id }]);
    await expect(
      countActive("Kind filtered", "boundary_fact"),
    ).resolves.toBe(1);
  });

  it("clears stale embeddings and enqueues re-embedding after content edits", async () => {
    const memory = await insertMemory({
      content: "Original durable memory",
      kind: "shared_moment",
      embedding: vector(1),
      importance: 0.5,
      valence: 0,
      arousal: 0,
      resolved: false,
      sourceSessionId: null,
      sourceMessageId: null,
      contentHash: "original",
    });
    const request = new NextRequest(
      `http://localhost/api/memories/${memory.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Updated durable memory content" }),
      },
    );

    const response = await PATCH(request, {
      params: Promise.resolve({ id: memory.id }),
    });

    expect(response.status).toBe(200);
    const [updated] = await connection<
      { content: string; embedding: string | null }[]
    >`
      select content, embedding::text as embedding
      from memories where id = ${memory.id}
    `;
    expect(updated).toEqual({
      content: "Updated durable memory content",
      embedding: null,
    });
    const [job] = await connection<{ type: string; payload: unknown }[]>`
      select type, payload from jobs
    `;
    expect(job).toEqual({
      type: "embed_memory",
      payload: { memoryId: memory.id },
    });
  });

  it("does not let an in-flight old embedding overwrite a newer edit", async () => {
    const memory = await insertMemory({
      content: "Original concurrent memory",
      kind: "shared_moment",
      embedding: vector(1),
      importance: 0.5,
      valence: 0,
      arousal: 0,
      resolved: false,
      sourceSessionId: null,
      sourceMessageId: null,
      contentHash: await hashMemoryContent("Original concurrent memory"),
    });
    let releaseEmbedding!: () => void;
    let markStarted!: () => void;
    const embeddingStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const embeddingRelease = new Promise<void>((resolve) => {
      releaseEmbedding = resolve;
    });
    provider.embed
      .mockImplementationOnce(async () => {
        markStarted();
        await embeddingRelease;
        return [vector(0, 1)];
      })
      .mockResolvedValueOnce([vector(0, 1)]);
    await enqueueJob("embed_memory", { memoryId: memory.id });

    const runningJob = runNextJob();
    await embeddingStarted;
    const response = await PATCH(
      new NextRequest(`http://localhost/api/memories/${memory.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: "Newer concurrent memory content",
        }),
      }),
      { params: Promise.resolve({ id: memory.id }) },
    );
    expect(response.status).toBe(200);
    releaseEmbedding();
    await runningJob;

    const [betweenJobs] = await connection<
      { embedding: string | null; pending: number }[]
    >`
      select
        m.embedding::text as embedding,
        (
          select count(*)::int from jobs
          where type = 'embed_memory' and status = 'pending'
        ) as pending
      from memories m where m.id = ${memory.id}
    `;
    expect(betweenJobs).toEqual({ embedding: null, pending: 1 });

    expect(await runNextJob()).toBe(true);
    const [updated] = await connection<{ embedding: string | null }[]>`
      select embedding::text as embedding
      from memories where id = ${memory.id}
    `;
    expect(updated.embedding).not.toBeNull();
  });

  it("writes injection traces for injected and suppressed retrieval candidates", async () => {
    const sessionId = await createSession();
    const user = await createUserMessage(
      sessionId,
      "Tell me about durable preferences.",
      new Date("2026-06-15T12:00:00Z"),
    );
    const strongest = await insertMemory(
      memoryCandidate({ content: "Closest durable preference" }),
    );
    const limited = await insertMemory(
      memoryCandidate({
        content: "Second durable preference",
        embedding: vector(0.75, Math.sqrt(1 - 0.75 ** 2)),
      }),
    );

    const retrieved = await retrieveMemories({
      query: "Tell me about durable preferences.",
      tokenBudget: 1000,
      limit: 1,
      sessionId,
      messageId: user.id,
      summaryThroughMessageId: null,
    });

    expect(retrieved.map((memory) => memory.id)).toEqual([strongest.id]);
    const traces = await connection<
      {
        memory_id: string;
        injected: boolean;
        suppression_reason: string | null;
      }[]
    >`
      select memory_id, injected, suppression_reason
      from memory_injections
      where message_id = ${user.id}
      order by injected desc, memory_id
    `;

    expect(traces).toHaveLength(2);
    expect(traces).toContainEqual({
      memory_id: strongest.id,
      injected: true,
      suppression_reason: null,
    });
    expect(traces).toContainEqual({
      memory_id: limited.id,
      injected: false,
      suppression_reason: SUPPRESSION_REASON_LIMIT,
    });
  });

  it("writes cue traces for non-salient shared moments in the base band", async () => {
    const sessionId = await createSession();
    const user = await createUserMessage(
      sessionId,
      "Tell me about base-band shared moments.",
      new Date("2026-06-15T12:00:00Z"),
    );
    const nonSalient = await insertMemory(
      memoryCandidate({
        content: "A non-salient base-band shared moment",
        embedding: vector(0.72, Math.sqrt(1 - 0.72 ** 2)),
      }),
    );
    const salient = await insertMemory(
      memoryCandidate({
        content: "A salient base-band shared moment",
        embedding: vector(0.71, Math.sqrt(1 - 0.71 ** 2)),
        importance: 0.7,
      }),
    );

    const retrieved = await retrieveMemories({
      query: "Tell me about base-band shared moments.",
      tokenBudget: 1000,
      limit: 5,
      sessionId,
      messageId: user.id,
      summaryThroughMessageId: null,
    });

    expect(retrieved.map((memory) => memory.id)).toEqual([salient.id]);
    const traces = await connection<
      {
        memory_id: string;
        injected: boolean;
        suppression_reason: string | null;
      }[]
    >`
      select memory_id, injected, suppression_reason
      from memory_injections
      where message_id = ${user.id}
      order by injected desc, memory_id
    `;
    expect(traces).toContainEqual({
      memory_id: salient.id,
      injected: true,
      suppression_reason: null,
    });
    expect(traces).toContainEqual({
      memory_id: nonSalient.id,
      injected: false,
      suppression_reason: SUPPRESSION_REASON_CUE,
    });
  });

  it("suppresses a non-boundary memory injected in the recent session window", async () => {
    const sessionId = await createSession();
    const memory = await insertMemory(
      memoryCandidate({
        content: "A repeated session-local memory",
        embedding: vector(0.77, Math.sqrt(1 - 0.77 ** 2)),
      }),
    );
    const first = await createUserMessage(
      sessionId,
      "Recall this durable preference first.",
      new Date("2026-06-15T12:00:00Z"),
    );
    const second = await createUserMessage(
      sessionId,
      "Recall this durable preference again.",
      new Date("2026-06-15T12:01:00Z"),
    );

    await expect(
      retrieveMemories({
        query: "Recall this durable preference first.",
        tokenBudget: 1000,
        limit: 5,
        sessionId,
        messageId: first.id,
        summaryThroughMessageId: null,
      }),
    ).resolves.toMatchObject([{ id: memory.id }]);

    await expect(
      retrieveMemories({
        query: "Recall this durable preference again.",
        tokenBudget: 1000,
        limit: 5,
        sessionId,
        messageId: second.id,
        summaryThroughMessageId: null,
      }),
    ).resolves.toEqual([]);

    const [trace] = await connection<
      { injected: boolean; suppression_reason: string | null }[]
    >`
      select injected, suppression_reason
      from memory_injections
      where message_id = ${second.id} and memory_id = ${memory.id}
    `;
    expect(trace).toEqual({
      injected: false,
      suppression_reason: SUPPRESSION_REASON_SESSION_REPEAT,
    });
  });

  it("never suppresses a recent boundary fact", async () => {
    const sessionId = await createSession();
    const memory = await insertMemory(
      memoryCandidate({
        content: "The user has a hard boundary fact.",
        kind: "boundary_fact",
      }),
    );
    const first = await createUserMessage(
      sessionId,
      "Recall the boundary fact first.",
      new Date("2026-06-15T12:00:00Z"),
    );
    const second = await createUserMessage(
      sessionId,
      "Recall the boundary fact again.",
      new Date("2026-06-15T12:01:00Z"),
    );

    await retrieveMemories({
      query: "Recall the boundary fact first.",
      tokenBudget: 1000,
      limit: 5,
      sessionId,
      messageId: first.id,
      summaryThroughMessageId: null,
    });
    await expect(
      retrieveMemories({
        query: "Recall the boundary fact again.",
        tokenBudget: 1000,
        limit: 5,
        sessionId,
        messageId: second.id,
        summaryThroughMessageId: null,
      }),
    ).resolves.toMatchObject([{ id: memory.id }]);
  });

  it("updates recall metadata at most once per session per memory", async () => {
    const sessionId = await createSession();
    const memory = await insertMemory(
      memoryCandidate({
        content: "A strongly matching memory",
        embedding: vector(1),
      }),
    );
    const first = await createUserMessage(
      sessionId,
      "Recall the strong match first.",
      new Date("2026-06-15T12:00:00Z"),
    );
    const second = await createUserMessage(
      sessionId,
      "Recall the strong match again.",
      new Date("2026-06-15T12:01:00Z"),
    );
    const firstRecall = new Date("2026-06-15T12:00:10Z");
    const secondRecall = new Date("2026-06-15T12:01:10Z");

    await retrieveMemories({
      query: "Recall the strong match first.",
      tokenBudget: 1000,
      limit: 5,
      sessionId,
      messageId: first.id,
      summaryThroughMessageId: null,
    });
    await updateRecall([memory.id], {
      sessionId,
      messageId: first.id,
      now: firstRecall,
    });
    await retrieveMemories({
      query: "Recall the strong match again.",
      tokenBudget: 1000,
      limit: 5,
      sessionId,
      messageId: second.id,
      summaryThroughMessageId: null,
    });
    await updateRecall([memory.id], {
      sessionId,
      messageId: second.id,
      now: secondRecall,
    });

    const [row] = await connection<
      { recall_count: number; last_recalled_at: Date | null }[]
    >`
      select recall_count, last_recalled_at
      from memories
      where id = ${memory.id}
    `;
    expect(row.recall_count).toBe(1);
    expect(new Date(row.last_recalled_at!).toISOString()).toBe(
      firstRecall.toISOString(),
    );
  });

  it("updates recall after a memory was previously traced as suppressed", async () => {
    const sessionId = await createSession();
    const memory = await insertMemory(
      memoryCandidate({
        content: "A memory that becomes relevant later",
        embedding: vector(0.69, Math.sqrt(1 - 0.69 ** 2)),
      }),
    );
    const first = await createUserMessage(
      sessionId,
      "This first query is below the similarity threshold.",
      new Date("2026-06-15T12:00:00Z"),
    );
    const second = await createUserMessage(
      sessionId,
      "This second query should inject the memory.",
      new Date("2026-06-15T12:01:00Z"),
    );
    const recallAt = new Date("2026-06-15T12:01:10Z");

    await expect(
      retrieveMemories({
        query: "This first query is below the similarity threshold.",
        tokenBudget: 1000,
        limit: 5,
        sessionId,
        messageId: first.id,
        summaryThroughMessageId: null,
      }),
    ).resolves.toEqual([]);

    await updateMemoryEmbedding(memory.id, vector(1));

    await expect(
      retrieveMemories({
        query: "This second query should inject the memory.",
        tokenBudget: 1000,
        limit: 5,
        sessionId,
        messageId: second.id,
        summaryThroughMessageId: null,
      }),
    ).resolves.toMatchObject([{ id: memory.id }]);
    await updateRecall([memory.id], {
      sessionId,
      messageId: second.id,
      now: recallAt,
    });

    const [row] = await connection<
      { recall_count: number; last_recalled_at: Date | null }[]
    >`
      select recall_count, last_recalled_at
      from memories
      where id = ${memory.id}
    `;
    expect(row.recall_count).toBe(1);
    expect(new Date(row.last_recalled_at!).toISOString()).toBe(
      recallAt.toISOString(),
    );
  });
});
