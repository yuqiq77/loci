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
  failGeneration,
  type GenerationStart,
  loadCompleteHistory,
} from "@/server/db/chat";
import { closeDatabase } from "@/server/db/client";
import {
  getRewritableTailId,
  listSessionMessages,
} from "@/server/db/messages";
import { resetServerEnvForTests } from "@/server/env";
import { STALE_STREAMING_MS } from "@/shared/chat";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

describeWithDatabase("chat generation state", () => {
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
    attemptId?: string;
    cleanupAttemptId?: string;
    retryOfMessageId?: string;
    modelId?: string;
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

  it("allows an explicit model override for a session with a stale model id", async () => {
    const sessionId = await createSession("legacy-model");

    const generation = await begin({
      sessionId,
      content: "Recover this session",
      modelId: "claude-opus-4-6",
    });

    expect(generation.modelId).toBe("claude-opus-4-6");
  });

  it("reports an unknown stored model id without starting", async () => {
    const sessionId = await createSession("legacy-model");

    await expect(
      beginGeneration({
        sessionId,
        content: "Use the session model",
        attemptId: randomUUID(),
      }),
    ).resolves.toEqual({ kind: "model_not_configured" });
  });

  it("sweeps a stale orphaned pair entirely and starts a new generation", async () => {
    const sessionId = await createSession();
    const now = new Date("2026-06-15T12:00:00Z");
    const userAt = new Date(now.getTime() - STALE_STREAMING_MS - 2);
    const staleAt = new Date(now.getTime() - STALE_STREAMING_MS - 1);
    const [orphanUser] = await connection<{ id: string }[]>`
      insert into messages (
        session_id, role, content, status, model_id, created_at, completed_at
      )
      values (
        ${sessionId}, 'user', 'Lost question', 'complete', 'default',
        ${userAt.toISOString()}::timestamptz, ${userAt.toISOString()}::timestamptz
      )
      returning id
    `;
    const [stale] = await connection<{ id: string }[]>`
      insert into messages (
        session_id, role, content, status, model_id, created_at
      )
      values (
        ${sessionId}, 'assistant', '', 'streaming', 'default',
        ${staleAt.toISOString()}::timestamptz
      )
      returning id
    `;

    const generation = await begin({
      sessionId,
      content: "Continue",
      now,
    });

    const swept = await connection<{ id: string }[]>`
      select id from messages
      where id in (${stale.id}, ${orphanUser.id})
    `;
    expect(swept).toHaveLength(0);
    expect(generation.userMessageId).toBeTruthy();
    expect(generation.assistantMessageId).toBeTruthy();
  });

  it("leaves a user message with a later complete assistant alone in the sweep", async () => {
    const sessionId = await createSession();
    const now = new Date("2026-06-15T12:00:00Z");
    const userAt = new Date(now.getTime() - STALE_STREAMING_MS - 3);
    const completeAt = new Date(now.getTime() - STALE_STREAMING_MS - 2);
    const staleAt = new Date(now.getTime() - STALE_STREAMING_MS - 1);
    const [keptUser] = await connection<{ id: string }[]>`
      insert into messages (
        session_id, role, content, status, model_id, created_at, completed_at
      )
      values (
        ${sessionId}, 'user', 'Keep me', 'complete', 'default',
        ${userAt.toISOString()}::timestamptz, ${userAt.toISOString()}::timestamptz
      )
      returning id
    `;
    const [keptAssistant] = await connection<{ id: string }[]>`
      insert into messages (
        session_id, role, content, status, model_id, created_at, completed_at
      )
      values (
        ${sessionId}, 'assistant', 'Kept reply', 'complete', 'default',
        ${completeAt.toISOString()}::timestamptz,
        ${completeAt.toISOString()}::timestamptz
      )
      returning id
    `;
    const [stale] = await connection<{ id: string }[]>`
      insert into messages (
        session_id, role, content, status, model_id, created_at
      )
      values (
        ${sessionId}, 'assistant', '', 'streaming', 'default',
        ${staleAt.toISOString()}::timestamptz
      )
      returning id
    `;

    await begin({ sessionId, content: "Continue", now });

    const remaining = await connection<{ id: string }[]>`
      select id from messages
      where id in (${stale.id}, ${keptUser.id}, ${keptAssistant.id})
    `;
    expect(remaining.map((row) => row.id).sort()).toEqual(
      [keptUser.id, keptAssistant.id].sort(),
    );
  });

  it("keeps the six-minute boundary active and reports in progress", async () => {
    const sessionId = await createSession();
    const now = new Date("2026-06-15T12:00:00Z");
    const boundary = new Date(now.getTime() - STALE_STREAMING_MS);
    const [active] = await connection<{ id: string }[]>`
      insert into messages (
        session_id, role, content, status, model_id, created_at
      )
      values (
        ${sessionId}, 'assistant', '', 'streaming', 'default',
        ${boundary.toISOString()}::timestamptz
      )
      returning id
    `;

    await expect(
      beginGeneration({
        sessionId,
        content: "Do not start",
        attemptId: randomUUID(),
        now,
      }),
    ).resolves.toEqual({ kind: "generation_in_progress" });
    const [survivor] = await connection<{ id: string }[]>`
      select id from messages where id = ${active.id}
    `;
    expect(survivor).toBeTruthy();
  });

  it("allows exactly one of two concurrent sends for a session", async () => {
    const sessionId = await createSession();

    const results = await Promise.all([
      beginGeneration({
        sessionId,
        content: "First",
        attemptId: randomUUID(),
      }),
      beginGeneration({
        sessionId,
        content: "Second",
        attemptId: randomUUID(),
      }),
    ]);

    expect(
      results.filter((result) => result.kind === "started"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.kind === "generation_in_progress"),
    ).toHaveLength(1);
  });

  it("persists the attempt id into the user row and exposes it on reads", async () => {
    const sessionId = await createSession();
    const attemptId = randomUUID();

    const generation = await begin({
      sessionId,
      content: "Stamp me",
      attemptId,
    });
    await completeGeneration({
      assistantMessageId: generation.assistantMessageId,
      content: "Reply",
    });

    const listed = await listSessionMessages(sessionId, 10, 0);
    expect(listed).toMatchObject([
      { role: "user", content: "Stamp me", attemptId },
      { role: "assistant", content: "Reply", attemptId: undefined },
    ]);
  });

  it("retracts an aborted generation without touching the summary cursor", async () => {
    const sessionId = await createSession();
    const generation = await begin({
      sessionId,
      content: "Please try this",
    });

    await failGeneration({
      assistantMessageId: generation.assistantMessageId,
      content: "Partial",
      errorCode: "GENERATION_CANCELLED",
      cancelled: true,
    });
    await discardGeneration({
      userMessageId: generation.userMessageId,
      assistantMessageId: generation.assistantMessageId,
    });

    await expect(listSessionMessages(sessionId, 10, 0)).resolves.toEqual([]);
    const [session] = await connection<
      { summary_through_message_id: string | null }[]
    >`
      select summary_through_message_id from sessions where id = ${sessionId}
    `;
    expect(session.summary_through_message_id).toBeNull();
  });

  it("sweeps terminal residue pairs on the next send without a cleanup id", async () => {
    const sessionId = await createSession();
    const residue = await begin({
      sessionId,
      content: "Residue turn",
      now: new Date("2026-06-15T12:00:00Z"),
    });
    await failGeneration({
      assistantMessageId: residue.assistantMessageId,
      content: "",
      errorCode: "PROVIDER_UNAVAILABLE",
    });

    await begin({
      sessionId,
      content: "Fresh turn",
      now: new Date("2026-06-15T12:01:00Z"),
    });

    const listed = await listSessionMessages(sessionId, 10, 0);
    expect(listed).toMatchObject([
      { role: "user", content: "Fresh turn" },
      { role: "assistant", status: "streaming" },
    ]);
  });

  it("sweeps mid-session debris by adjacency, leaving neighbors alone", async () => {
    const sessionId = await createSession();
    const first = await begin({
      sessionId,
      content: "First turn",
      now: new Date("2026-06-15T12:00:00Z"),
    });
    await completeGeneration({
      assistantMessageId: first.assistantMessageId,
      content: "First reply",
    });
    const second = await begin({
      sessionId,
      content: "Second turn",
      now: new Date("2026-06-15T12:02:00Z"),
    });
    await completeGeneration({
      assistantMessageId: second.assistantMessageId,
      content: "Second reply",
    });
    // Debris between the two complete exchanges — the old later-complete
    // guard would have kept its user row; adjacency pairs it correctly.
    await connection`
      insert into messages (
        session_id, role, content, status, model_id, created_at, completed_at
      )
      values
        (
          ${sessionId}, 'user', 'Debris question', 'complete', 'default',
          '2026-06-15T12:01:00Z'::timestamptz, '2026-06-15T12:01:00Z'::timestamptz
        ),
        (
          ${sessionId}, 'assistant', '', 'cancelled', 'default',
          '2026-06-15T12:01:00.001Z'::timestamptz,
          '2026-06-15T12:01:00.001Z'::timestamptz
        )
    `;

    await begin({
      sessionId,
      content: "Third turn",
      now: new Date("2026-06-15T12:03:00Z"),
    });

    const listed = await listSessionMessages(sessionId, 10, 0);
    expect(listed).toMatchObject([
      { role: "user", content: "First turn" },
      { role: "assistant", content: "First reply" },
      { role: "user", content: "Second turn" },
      { role: "assistant", content: "Second reply" },
      { role: "user", content: "Third turn" },
      { role: "assistant", status: "streaming" },
    ]);
  });

  it("repositions the summary cursor before deleting residue it points at", async () => {
    const sessionId = await createSession();
    const residueAttemptId = randomUUID();
    const kept = await begin({
      sessionId,
      content: "Keep this turn",
      now: new Date("2026-06-15T12:00:00Z"),
    });
    await completeGeneration({
      assistantMessageId: kept.assistantMessageId,
      content: "Kept reply",
    });
    const residue = await begin({
      sessionId,
      content: "Residue turn",
      attemptId: residueAttemptId,
      now: new Date("2026-06-15T12:01:00Z"),
    });
    await failGeneration({
      assistantMessageId: residue.assistantMessageId,
      content: "",
      errorCode: "PROVIDER_UNAVAILABLE",
    });
    await connection`
      update sessions
      set summary = 'Thread state.',
          summary_through_message_id = ${residue.userMessageId}
      where id = ${sessionId}
    `;

    await begin({
      sessionId,
      content: "Retry turn",
      cleanupAttemptId: residueAttemptId,
      now: new Date("2026-06-15T12:02:00Z"),
    });

    const [session] = await connection<
      { summary: string; summary_through_message_id: string | null }[]
    >`
      select summary, summary_through_message_id
      from sessions where id = ${sessionId}
    `;
    // Cursor moved to the predecessor (the kept assistant), summary kept.
    expect(session.summary).toBe("Thread state.");
    expect(session.summary_through_message_id).toBe(
      kept.assistantMessageId,
    );
  });

  it("returns the repositioned cursor when the debris sweep moved it", async () => {
    // Sweep-path variant of the reposition case: no cleanupAttemptId, so the
    // residue is retracted by the debris sweep. The sweep must run before
    // the session row is read — a snapshot captured earlier would hand the
    // route a deleted cursor id, and that request would inject the summary
    // AND read full history at once (review finding, 2026-07-28).
    const sessionId = await createSession();
    const kept = await begin({
      sessionId,
      content: "Keep this turn",
      now: new Date("2026-06-15T12:00:00Z"),
    });
    await completeGeneration({
      assistantMessageId: kept.assistantMessageId,
      content: "Kept reply",
    });
    const residue = await begin({
      sessionId,
      content: "Residue turn",
      now: new Date("2026-06-15T12:01:00Z"),
    });
    await failGeneration({
      assistantMessageId: residue.assistantMessageId,
      content: "",
      errorCode: "PROVIDER_UNAVAILABLE",
    });
    await connection`
      update sessions
      set summary = 'Thread state.',
          summary_through_message_id = ${residue.userMessageId}
      where id = ${sessionId}
    `;

    const generation = await begin({
      sessionId,
      content: "Next turn",
      now: new Date("2026-06-15T12:02:00Z"),
    });

    const [session] = await connection<
      { summary_through_message_id: string | null }[]
    >`
      select summary_through_message_id from sessions
      where id = ${sessionId}
    `;
    expect(session.summary_through_message_id).toBe(kept.assistantMessageId);
    // The returned snapshot agrees with the DB — not the deleted id.
    expect(generation.summaryThroughMessageId).toBe(kept.assistantMessageId);
    expect(generation.summary).toBe("Thread state.");
  });

  it("deletes exactly the terminal pair matching cleanupAttemptId", async () => {
    const sessionId = await createSession();
    const keptAttemptId = randomUUID();
    const residueAttemptId = randomUUID();

    const kept = await begin({
      sessionId,
      content: "Keep this turn",
      attemptId: keptAttemptId,
      now: new Date("2026-06-15T12:00:00Z"),
    });
    await completeGeneration({
      assistantMessageId: kept.assistantMessageId,
      content: "Kept reply",
    });
    const residue = await begin({
      sessionId,
      content: "Residue turn",
      attemptId: residueAttemptId,
      now: new Date("2026-06-15T12:01:00Z"),
    });
    await failGeneration({
      assistantMessageId: residue.assistantMessageId,
      content: "",
      errorCode: "GENERATION_CANCELLED",
      cancelled: true,
    });

    await begin({
      sessionId,
      content: "Retry turn",
      cleanupAttemptId: residueAttemptId,
      now: new Date("2026-06-15T12:02:00Z"),
    });

    const listed = await listSessionMessages(sessionId, 10, 0);
    expect(listed).toMatchObject([
      { role: "user", content: "Keep this turn" },
      { role: "assistant", content: "Kept reply" },
      { role: "user", content: "Retry turn" },
      { role: "assistant", status: "streaming" },
    ]);
  });

  it("commits the cleanup even when the send is rejected as in progress", async () => {
    const sessionId = await createSession();
    const residueAttemptId = randomUUID();

    const residue = await begin({
      sessionId,
      content: "Residue turn",
      attemptId: residueAttemptId,
      now: new Date("2026-06-15T12:00:00Z"),
    });
    await failGeneration({
      assistantMessageId: residue.assistantMessageId,
      content: "",
      errorCode: "PROVIDER_UNAVAILABLE",
    });
    const active = await begin({
      sessionId,
      content: "Active turn",
      now: new Date("2026-06-15T12:01:00Z"),
    });

    await expect(
      beginGeneration({
        sessionId,
        content: "Retry turn",
        attemptId: randomUUID(),
        cleanupAttemptId: residueAttemptId,
        now: new Date("2026-06-15T12:02:00Z"),
      }),
    ).resolves.toEqual({ kind: "generation_in_progress" });

    // The residue pair is gone, the streaming pair is untouched, and no new
    // rows were inserted.
    const listed = await listSessionMessages(sessionId, 10, 0);
    expect(listed).toMatchObject([
      { role: "user", content: "Active turn" },
      { role: "assistant", status: "streaming" },
    ]);
    expect(listed[1].id).toBe(active.assistantMessageId);
  });

  it("never deletes a streaming pair through cleanupAttemptId", async () => {
    const sessionId = await createSession();
    const streamingAttemptId = randomUUID();

    const active = await begin({
      sessionId,
      content: "Streaming turn",
      attemptId: streamingAttemptId,
      now: new Date("2026-06-15T12:00:00Z"),
    });

    await expect(
      beginGeneration({
        sessionId,
        content: "Crafted cleanup",
        attemptId: randomUUID(),
        cleanupAttemptId: streamingAttemptId,
        now: new Date("2026-06-15T12:01:00Z"),
      }),
    ).resolves.toEqual({ kind: "generation_in_progress" });

    const listed = await listSessionMessages(sessionId, 10, 0);
    expect(listed).toMatchObject([
      { role: "user", content: "Streaming turn" },
      { role: "assistant", status: "streaming" },
    ]);
    expect(listed[1].id).toBe(active.assistantMessageId);
  });

  // MC-116B: safe tail rewrite — commit-on-success. beginGeneration inserts
  // the replacement alongside the old pair; only completeGeneration's swap
  // transaction deletes the old pair.

  async function seedExchange(
    sessionId: string,
    content: string,
    reply: string,
    now: Date,
    attemptId = randomUUID(),
  ) {
    const generation = await begin({ sessionId, content, attemptId, now });
    await completeGeneration({
      assistantMessageId: generation.assistantMessageId,
      content: reply,
    });
    return generation;
  }

  it("inserts the rewrite replacement alongside the untouched old pair", async () => {
    const sessionId = await createSession();
    const old = await seedExchange(
      sessionId,
      "Old question",
      "Old reply",
      new Date("2026-06-15T12:00:00Z"),
    );

    const replacement = await begin({
      sessionId,
      content: "Old question",
      retryOfMessageId: old.userMessageId,
      now: new Date("2026-06-15T12:01:00Z"),
    });

    expect(replacement.supersededUserMessageId).toBe(old.userMessageId);
    expect(replacement.supersededAssistantMessageId).toBe(
      old.assistantMessageId,
    );
    const listed = await listSessionMessages(sessionId, 10, 0);
    expect(listed).toMatchObject([
      { id: old.userMessageId, role: "user", content: "Old question" },
      { id: old.assistantMessageId, role: "assistant", content: "Old reply" },
      {
        id: replacement.userMessageId,
        role: "user",
        supersedes: old.userMessageId,
      },
      { id: replacement.assistantMessageId, status: "streaming" },
    ]);
  });

  it("swaps atomically on completion, clearing supersedes but not attemptId", async () => {
    const sessionId = await createSession();
    const replacementAttemptId = randomUUID();
    const earlier = await seedExchange(
      sessionId,
      "Earlier turn",
      "Earlier reply",
      new Date("2026-06-15T11:59:00Z"),
    );
    const old = await seedExchange(
      sessionId,
      "Old question",
      "Old reply",
      new Date("2026-06-15T12:00:00Z"),
    );
    // Cursors point at surviving earlier rows: the swap must not move them.
    await connection`
      update sessions
      set summary_through_message_id = ${earlier.assistantMessageId},
          extracted_through_message_id = ${earlier.assistantMessageId}
      where id = ${sessionId}
    `;
    const replacement = await begin({
      sessionId,
      content: "Edited question",
      attemptId: replacementAttemptId,
      retryOfMessageId: old.userMessageId,
      now: new Date("2026-06-15T12:01:00Z"),
    });

    await completeGeneration({
      assistantMessageId: replacement.assistantMessageId,
      content: "Better reply",
      supersede: {
        sessionId,
        userMessageId: old.userMessageId,
        assistantMessageId: old.assistantMessageId,
        replacementUserMessageId: replacement.userMessageId,
      },
    });

    const listed = await listSessionMessages(sessionId, 10, 0);
    expect(listed).toMatchObject([
      { id: earlier.userMessageId, role: "user" },
      { id: earlier.assistantMessageId, role: "assistant" },
      {
        id: replacement.userMessageId,
        role: "user",
        content: "Edited question",
        attemptId: replacementAttemptId,
        supersedes: undefined,
      },
      {
        id: replacement.assistantMessageId,
        role: "assistant",
        content: "Better reply",
        status: "complete",
      },
    ]);
    // Cursors untouched on the normal path.
    const [session] = await connection<
      {
        summary_through_message_id: string | null;
        extracted_through_message_id: string | null;
      }[]
    >`
      select summary_through_message_id, extracted_through_message_id
      from sessions where id = ${sessionId}
    `;
    expect(session.summary_through_message_id).toBe(
      earlier.assistantMessageId,
    );
    expect(session.extracted_through_message_id).toBe(
      earlier.assistantMessageId,
    );
  });

  it("rejects a non-tail rewrite target without inserting anything", async () => {
    const sessionId = await createSession();
    const first = await seedExchange(
      sessionId,
      "First",
      "First reply",
      new Date("2026-06-15T12:00:00Z"),
    );
    await seedExchange(
      sessionId,
      "Second",
      "Second reply",
      new Date("2026-06-15T12:01:00Z"),
    );

    await expect(
      beginGeneration({
        sessionId,
        content: "First again",
        attemptId: randomUUID(),
        retryOfMessageId: first.userMessageId,
        now: new Date("2026-06-15T12:02:00Z"),
      }),
    ).resolves.toEqual({ kind: "message_not_retryable" });
    await expect(listSessionMessages(sessionId, 10, 0)).resolves.toHaveLength(
      4,
    );
  });

  it("rejects a target that is not a complete user message", async () => {
    const sessionId = await createSession();
    const old = await seedExchange(
      sessionId,
      "Question",
      "Reply",
      new Date("2026-06-15T12:00:00Z"),
    );

    await expect(
      beginGeneration({
        sessionId,
        content: "Again",
        attemptId: randomUUID(),
        retryOfMessageId: old.assistantMessageId,
        now: new Date("2026-06-15T12:01:00Z"),
      }),
    ).resolves.toEqual({ kind: "message_not_retryable" });
  });

  it("rejects a cursor-covered tail for both cursors", async () => {
    // The extraction cursor is the routine episode boundary: once the
    // exchange has been absorbed into memory it can no longer be unsaid.
    for (const column of [
      "extracted_through_message_id",
      "summary_through_message_id",
    ] as const) {
      const sessionId = await createSession();
      const old = await seedExchange(
        sessionId,
        "Question",
        "Reply",
        new Date("2026-06-15T12:00:00Z"),
      );
      await connection`
        update sessions
        set ${connection(column)} = ${old.assistantMessageId}
        where id = ${sessionId}
      `;

      await expect(
        beginGeneration({
          sessionId,
          content: "Again",
          attemptId: randomUUID(),
          retryOfMessageId: old.userMessageId,
          now: new Date("2026-06-15T12:01:00Z"),
        }),
      ).resolves.toEqual({ kind: "message_not_retryable" });
    }
  });

  it("tests the streaming gate before retryability", async () => {
    const sessionId = await createSession();
    const old = await seedExchange(
      sessionId,
      "Question",
      "Reply",
      new Date("2026-06-15T12:00:00Z"),
    );
    await begin({
      sessionId,
      content: "Question",
      retryOfMessageId: old.userMessageId,
      now: new Date("2026-06-15T12:01:00Z"),
    });

    // A double-click's second request sees the first attempt's streaming
    // row: GENERATION_IN_PROGRESS, never MESSAGE_NOT_RETRYABLE.
    await expect(
      beginGeneration({
        sessionId,
        content: "Question",
        attemptId: randomUUID(),
        retryOfMessageId: old.userMessageId,
        now: new Date("2026-06-15T12:01:01Z"),
      }),
    ).resolves.toEqual({ kind: "generation_in_progress" });
  });

  it("commits residue cleanup on a message_not_retryable rejection", async () => {
    const sessionId = await createSession();
    const residueAttemptId = randomUUID();
    const kept = await seedExchange(
      sessionId,
      "Keep this turn",
      "Kept reply",
      new Date("2026-06-15T12:00:00Z"),
    );
    const residue = await begin({
      sessionId,
      content: "Residue turn",
      attemptId: residueAttemptId,
      now: new Date("2026-06-15T12:01:00Z"),
    });
    await failGeneration({
      assistantMessageId: residue.assistantMessageId,
      content: "",
      errorCode: "PROVIDER_UNAVAILABLE",
    });

    // An invalid rewrite target (wrong role) rejects — but the residue
    // cleanup must commit anyway (MC-116A result-union convention).
    await expect(
      beginGeneration({
        sessionId,
        content: "Retry turn",
        attemptId: randomUUID(),
        cleanupAttemptId: residueAttemptId,
        retryOfMessageId: kept.assistantMessageId,
        now: new Date("2026-06-15T12:02:00Z"),
      }),
    ).resolves.toEqual({ kind: "message_not_retryable" });
    const listed = await listSessionMessages(sessionId, 10, 0);
    expect(listed).toMatchObject([
      { id: kept.userMessageId, role: "user" },
      { id: kept.assistantMessageId, role: "assistant" },
    ]);
  });

  it("keeps the old pair intact when the rewrite fails", async () => {
    const sessionId = await createSession();
    const old = await seedExchange(
      sessionId,
      "Old question",
      "Old reply",
      new Date("2026-06-15T12:00:00Z"),
    );
    const replacement = await begin({
      sessionId,
      content: "Old question",
      retryOfMessageId: old.userMessageId,
      now: new Date("2026-06-15T12:01:00Z"),
    });

    // The route's failure order: mark, then discard — only the replacement.
    await failGeneration({
      assistantMessageId: replacement.assistantMessageId,
      content: "Partial",
      errorCode: "PROVIDER_UNAVAILABLE",
    });
    await discardGeneration({
      userMessageId: replacement.userMessageId,
      assistantMessageId: replacement.assistantMessageId,
    });

    const listed = await listSessionMessages(sessionId, 10, 0);
    expect(listed).toMatchObject([
      { id: old.userMessageId, content: "Old question" },
      { id: old.assistantMessageId, content: "Old reply" },
    ]);
  });

  it("sweeps only the replacement pair after a crash mid-rewrite", async () => {
    const sessionId = await createSession();
    const now = new Date("2026-06-15T12:00:00Z");
    const beforeStale = new Date(
      now.getTime() - STALE_STREAMING_MS - 60_000,
    );
    const old = await seedExchange(
      sessionId,
      "Old question",
      "Old reply",
      new Date(beforeStale.getTime() - 60_000),
    );
    await begin({
      sessionId,
      content: "Old question",
      retryOfMessageId: old.userMessageId,
      now: beforeStale,
    });

    await begin({ sessionId, content: "Next turn", now });

    const listed = await listSessionMessages(sessionId, 10, 0);
    expect(listed).toMatchObject([
      { id: old.userMessageId, content: "Old question" },
      { id: old.assistantMessageId, content: "Old reply" },
      { role: "user", content: "Next turn" },
      { role: "assistant", status: "streaming" },
    ]);
  });

  it("set-nulls a cursor that moved onto the old pair mid-stream", async () => {
    // The commit-time race (decision 4): a job consumed the old pair while
    // the replacement streamed. The swap still commits; the cursor nulls
    // and the job rebuilds — a recoverable degradation, not lossless
    // self-healing.
    const sessionId = await createSession();
    const old = await seedExchange(
      sessionId,
      "Old question",
      "Old reply",
      new Date("2026-06-15T12:00:00Z"),
    );
    const replacement = await begin({
      sessionId,
      content: "Old question",
      retryOfMessageId: old.userMessageId,
      now: new Date("2026-06-15T12:01:00Z"),
    });
    await connection`
      update sessions
      set summary = 'Thread state.',
          summary_through_message_id = ${old.assistantMessageId},
          extracted_through_message_id = ${old.assistantMessageId}
      where id = ${sessionId}
    `;

    await completeGeneration({
      assistantMessageId: replacement.assistantMessageId,
      content: "Better reply",
      supersede: {
        sessionId,
        userMessageId: old.userMessageId,
        assistantMessageId: old.assistantMessageId,
        replacementUserMessageId: replacement.userMessageId,
      },
    });

    const [session] = await connection<
      {
        summary: string;
        summary_through_message_id: string | null;
        extracted_through_message_id: string | null;
      }[]
    >`
      select summary, summary_through_message_id,
             extracted_through_message_id
      from sessions where id = ${sessionId}
    `;
    expect(session.summary).toBe("Thread state.");
    expect(session.summary_through_message_id).toBeNull();
    expect(session.extracted_through_message_id).toBeNull();

    // The context gate keys on cursor AND summary together: the next
    // generation snapshot carries the nulled cursor, so the stale summary
    // is not injected while history reads from the session start — never
    // both at once.
    const next = await begin({
      sessionId,
      content: "Next turn",
      now: new Date("2026-06-15T12:02:00Z"),
    });
    expect(next.summaryThroughMessageId).toBeNull();
    expect(next.summary).toBe("Thread state.");
  });

  it("aborts the swap when the replacement is no longer streaming", async () => {
    const sessionId = await createSession();
    const old = await seedExchange(
      sessionId,
      "Old question",
      "Old reply",
      new Date("2026-06-15T12:00:00Z"),
    );
    const replacement = await begin({
      sessionId,
      content: "Old question",
      retryOfMessageId: old.userMessageId,
      now: new Date("2026-06-15T12:01:00Z"),
    });
    // The replacement was swept or failed concurrently.
    await discardGeneration({
      userMessageId: replacement.userMessageId,
      assistantMessageId: replacement.assistantMessageId,
    });

    await expect(
      completeGeneration({
        assistantMessageId: replacement.assistantMessageId,
        content: "Better reply",
        supersede: {
          sessionId,
          userMessageId: old.userMessageId,
          assistantMessageId: old.assistantMessageId,
          replacementUserMessageId: replacement.userMessageId,
        },
      }),
    ).rejects.toThrow("swap aborted");
    // The whole transaction rolled back: the old pair survives.
    const listed = await listSessionMessages(sessionId, 10, 0);
    expect(listed).toMatchObject([
      { id: old.userMessageId, content: "Old question" },
      { id: old.assistantMessageId, content: "Old reply" },
    ]);
  });

  it("drops the excluded old pair from the rewrite's model context", async () => {
    const sessionId = await createSession();
    await seedExchange(
      sessionId,
      "First",
      "First reply",
      new Date("2026-06-15T12:00:00Z"),
    );
    const old = await seedExchange(
      sessionId,
      "Old question",
      "Old reply",
      new Date("2026-06-15T12:01:00Z"),
    );
    const replacement = await begin({
      sessionId,
      content: "Old question",
      retryOfMessageId: old.userMessageId,
      now: new Date("2026-06-15T12:02:00Z"),
    });

    await expect(
      loadCompleteHistory(sessionId, replacement.userMessageId, null, [
        old.userMessageId,
        old.assistantMessageId,
      ]).then((history) =>
        history.map(({ role, content }) => ({ role, content })),
      ),
    ).resolves.toEqual([
      { role: "user", content: "First" },
      { role: "assistant", content: "First reply" },
    ]);
  });

  // The rewritable-tail indicator (decision 5): computed from the DB's true
  // tail and both cursors, independent of any paginated slice.

  it("marks a fresh complete tail rewritable", async () => {
    const sessionId = await createSession();
    await seedExchange(
      sessionId,
      "First",
      "First reply",
      new Date("2026-06-15T12:00:00Z"),
    );
    const tail = await seedExchange(
      sessionId,
      "Tail question",
      "Tail reply",
      new Date("2026-06-15T12:01:00Z"),
    );

    await expect(getRewritableTailId(sessionId)).resolves.toBe(
      tail.userMessageId,
    );
  });

  it("marks nothing rewritable for empty, streaming, or terminal tails", async () => {
    const emptySession = await createSession();
    await expect(getRewritableTailId(emptySession)).resolves.toBeNull();

    const streamingSession = await createSession();
    await begin({
      sessionId: streamingSession,
      content: "In flight",
      now: new Date("2026-06-15T12:00:00Z"),
    });
    await expect(getRewritableTailId(streamingSession)).resolves.toBeNull();

    const terminalSession = await createSession();
    const failed = await begin({
      sessionId: terminalSession,
      content: "Doomed",
      now: new Date("2026-06-15T12:00:00Z"),
    });
    await failGeneration({
      assistantMessageId: failed.assistantMessageId,
      content: "",
      errorCode: "PROVIDER_UNAVAILABLE",
    });
    await expect(getRewritableTailId(terminalSession)).resolves.toBeNull();

    // Archived mirrors beginGeneration's filter — the indicator must never
    // advertise an affordance the send path deterministically rejects.
    const archivedSession = await createSession();
    await seedExchange(
      archivedSession,
      "Question",
      "Reply",
      new Date("2026-06-15T12:00:00Z"),
    );
    await connection`
      update sessions set archived_at = now() where id = ${archivedSession}
    `;
    await expect(getRewritableTailId(archivedSession)).resolves.toBeNull();
  });

  it("marks a cursor-covered tail unrewritable, for either cursor", async () => {
    // After an idle-triggered extraction pass the whole tail is covered —
    // the normal state of a resumed conversation, not an edge case.
    for (const column of [
      "extracted_through_message_id",
      "summary_through_message_id",
    ] as const) {
      const sessionId = await createSession();
      const tail = await seedExchange(
        sessionId,
        "Question",
        "Reply",
        new Date("2026-06-15T12:00:00Z"),
      );
      await connection`
        update sessions
        set ${connection(column)} = ${tail.assistantMessageId}
        where id = ${sessionId}
      `;
      await expect(getRewritableTailId(sessionId)).resolves.toBeNull();
    }
  });

  it("keeps the tail rewritable when the cursors cover only earlier turns", async () => {
    const sessionId = await createSession();
    const first = await seedExchange(
      sessionId,
      "First",
      "First reply",
      new Date("2026-06-15T12:00:00Z"),
    );
    const tail = await seedExchange(
      sessionId,
      "Tail question",
      "Tail reply",
      new Date("2026-06-15T12:01:00Z"),
    );
    await connection`
      update sessions
      set summary_through_message_id = ${first.assistantMessageId},
          extracted_through_message_id = ${first.assistantMessageId}
      where id = ${sessionId}
    `;

    await expect(getRewritableTailId(sessionId)).resolves.toBe(
      tail.userMessageId,
    );
  });

  it("excludes user messages whose assistant generation failed", async () => {
    const sessionId = await createSession();
    const failed = await begin({
      sessionId,
      content: "Do not resend this",
    });
    await failGeneration({
      assistantMessageId: failed.assistantMessageId,
      content: "",
      errorCode: "PROVIDER_UNAVAILABLE",
    });
    const complete = await begin({
      sessionId,
      content: "Keep this turn",
    });
    await completeGeneration({
      assistantMessageId: complete.assistantMessageId,
      content: "Completed reply",
    });

    await expect(
      loadCompleteHistory(
        sessionId,
        "00000000-0000-4000-8000-000000000000",
        null,
      ).then((history) =>
        history.map(({ role, content }) => ({ role, content })),
      ),
    ).resolves.toEqual([
      { role: "user", content: "Keep this turn" },
      { role: "assistant", content: "Completed reply" },
    ]);
  });

  it("drops pairs with an empty assistant from model context", async () => {
    // Defense for rows that predate the EMPTY_COMPLETION retraction: an
    // empty assistant block would take the settled-message cache breakpoint
    // and 400 the provider request, wedging the session permanently.
    const sessionId = await createSession();
    const empty = await begin({
      sessionId,
      content: "Burned by thinking",
      now: new Date("2026-06-15T12:00:00Z"),
    });
    await completeGeneration({
      assistantMessageId: empty.assistantMessageId,
      content: "",
    });
    await seedExchange(
      sessionId,
      "Keep this turn",
      "Kept reply",
      new Date("2026-06-15T12:01:00Z"),
    );

    await expect(
      loadCompleteHistory(
        sessionId,
        "00000000-0000-4000-8000-000000000000",
        null,
      ).then((history) =>
        history.map(({ role, content }) => ({ role, content })),
      ),
    ).resolves.toEqual([
      { role: "user", content: "Keep this turn" },
      { role: "assistant", content: "Kept reply" },
    ]);
  });

  it("orders user messages before assistant replies when timestamps tie", async () => {
    const sessionId = await createSession();
    const createdAt = "2026-06-15T12:00:00Z";
    await connection`
      insert into messages (
        session_id, role, content, status, model_id, created_at, completed_at
      )
      values
        (
          ${sessionId}, 'assistant', 'Reply', 'complete', 'default',
          ${createdAt}::timestamptz, ${createdAt}::timestamptz
        ),
        (
          ${sessionId}, 'user', 'Question', 'complete', 'default',
          ${createdAt}::timestamptz, ${createdAt}::timestamptz
        )
    `;

    await expect(listSessionMessages(sessionId, 10, 0)).resolves.toMatchObject([
      { role: "user", content: "Question" },
      { role: "assistant", content: "Reply" },
    ]);
  });

  it("creates generated pairs with increasing timestamps", async () => {
    const sessionId = await createSession();
    const now = new Date("2026-06-15T12:00:00Z");
    const generation = await begin({
      sessionId,
      content: "Question",
      now,
    });

    await completeGeneration({
      assistantMessageId: generation.assistantMessageId,
      content: "Reply",
    });

    const ordered = await listSessionMessages(sessionId, 10, 0);
    expect(ordered).toMatchObject([
      { role: "user", content: "Question" },
      { role: "assistant", content: "Reply" },
    ]);
    expect(new Date(ordered[1].createdAt).getTime()).toBeGreaterThan(
      new Date(ordered[0].createdAt).getTime(),
    );
  });
});
