// MC-123: the read-only diagnostics queries over seeded rows — listing
// shape, filters, cursor, fence detection, tool-run order and purge marking,
// the per-memory trace, and the no-write guarantee (AC 7).
process.env.TZ = "Europe/Zurich";

import { randomUUID } from "node:crypto";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase } from "@/server/db/client";
import {
  listJobsForDiagnostics,
  listMemoryTrace,
  listToolRunAttempt,
  listToolRunAttemptsForSession,
  loadDiagnosticsPulse,
  resolveFences,
} from "@/server/db/diagnostics";
import { resetServerEnvForTests } from "@/server/env";
import {
  diarySourceKey,
  narrativeSourceKey,
  newestCompletedMessageAt,
  recentSnapshotSourceKey,
} from "@/server/jobs/source-keys";
import { addDiaryDays, diaryDayOf, diaryDayWindow } from "@/server/summaries/diary";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const TERMINATION =
  "Compression output ended early (finish reason: max_tokens). [stage=generation model=chat-test cap=32000 output_tokens=31998 chars=7] excerpt: cut off";

describeWithDatabase("diagnostics readers (MC-123)", () => {
  const connection = postgres(testDatabaseUrl!, { max: 3, prepare: false });
  const database = drizzle(connection);
  const yesterday = addDiaryDays(diaryDayOf(new Date()), -1);

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    resetServerEnvForTests();
    await migrate(database, { migrationsFolder: "drizzle" });
  });

  async function clean() {
    await connection`delete from jobs`;
    await connection`delete from memory_injections`;
    await connection`delete from memories`;
    await connection`delete from tool_runs`;
    await connection`delete from sessions`;
    await connection`delete from diary_entries`;
  }

  beforeEach(async () => {
    await clean();
    await connection`update diary_state set epoch = now() - interval '5 days' where id = 1`;
  });

  afterEach(clean);

  afterAll(async () => {
    await connection`update diary_state set epoch = now() where id = 1`;
    await closeDatabase();
    await connection.end();
  });

  async function seedSession(): Promise<string> {
    const [session] = await connection<{ id: string }[]>`
      insert into sessions (model_id, title) values ('default', 'Chat') returning id
    `;
    return session.id;
  }

  async function seedMessage(
    sessionId: string,
    role: "user" | "assistant",
    completedAt: Date,
    usedWebSearch = false,
  ): Promise<string> {
    const [row] = await connection<{ id: string }[]>`
      insert into messages (session_id, role, content, status, created_at, completed_at, used_web_search)
      values (${sessionId}, ${role}, ${`${role} turn`}, 'complete',
        ${completedAt.toISOString()}::timestamptz, ${completedAt.toISOString()}::timestamptz,
        ${usedWebSearch})
      returning id
    `;
    return row.id;
  }

  async function seedJob(input: {
    type: string;
    status: string;
    payload: Record<string, unknown>;
    lastError?: string;
    createdAt?: Date;
    attempts?: number;
  }): Promise<string> {
    const createdAt = input.createdAt ?? new Date();
    const completedAt =
      input.status === "failed" || input.status === "complete" ? createdAt : null;
    const [row] = await connection<{ id: string }[]>`
      insert into jobs (type, status, payload, last_error, attempts, created_at, completed_at, locked_at)
      values (${input.type}, ${input.status}::job_status, ${JSON.stringify(input.payload)}::jsonb,
        ${input.lastError ?? null}, ${input.attempts ?? 0},
        ${createdAt.toISOString()}::timestamptz,
        ${completedAt ? completedAt.toISOString() : null}::timestamptz,
        ${input.status === "running" ? createdAt.toISOString() : null}::timestamptz)
      returning id
    `;
    return row.id;
  }

  async function seedMemory(content: string): Promise<string> {
    const [row] = await connection<{ id: string }[]>`
      insert into memories (content, kind, content_hash, recall_count, last_recalled_at)
      values (${content}, 'shared_moment', ${`hash-${content}`}, 3, now())
      returning id
    `;
    return row.id;
  }

  async function seedRun(input: {
    attemptId: string;
    sessionId: string;
    assistantMessageId: string;
    round: number;
    call: number;
    purged?: boolean;
    startedAt: Date;
  }): Promise<void> {
    await connection`
      insert into tool_runs (attempt_id, session_id, assistant_message_id, round_index, call_index,
        provider_tool_use_id, tool_name, input, result_content, preceding_text, status,
        started_at, finished_at, purged_at, created_at)
      values (${input.attemptId}, ${input.sessionId}, ${input.assistantMessageId},
        ${input.round}, ${input.call}, ${`toolu_${input.round}_${input.call}`}, 'search_memory',
        ${input.purged ? null : JSON.stringify({ query: "q" })}::jsonb,
        ${input.purged ? null : "result body"},
        ${input.call === 0 && !input.purged ? "thinking aloud" : null},
        'committed',
        ${input.startedAt.toISOString()}::timestamptz,
        ${new Date(input.startedAt.getTime() + 250).toISOString()}::timestamptz,
        ${input.purged ? new Date().toISOString() : null}::timestamptz,
        ${input.startedAt.toISOString()}::timestamptz)
    `;
  }

  // Everything the page reads, as a footprint: row counts plus the recall
  // columns updateRecall would touch.
  async function footprint() {
    const [row] = await connection<
      { jobs: number; memories: number; injections: number; runs: number; recall: string }[]
    >`
      select
        (select count(*)::int from jobs) as jobs,
        (select count(*)::int from memories) as memories,
        (select count(*)::int from memory_injections) as injections,
        (select count(*)::int from tool_runs) as runs,
        (select coalesce(string_agg(recall_count || '@' || last_recalled_at, ',' order by id), '')
           from memories) as recall
    `;
    return row;
  }

  it("lists jobs newest first with the MC-118 fields decoded, filters, and pages by cursor (AC 2)", async () => {
    const base = Date.now();
    const sessionId = await seedSession();
    await seedJob({
      type: "write_diary_entry",
      status: "failed",
      attempts: 1,
      payload: {
        date: yesterday,
        sourceKey: diarySourceKey(yesterday),
        exhausted: [
          { stage: "generation", model: "chat-test", baseUrl: "https://a", reason: "max_tokens" },
        ],
      },
      lastError: TERMINATION,
      createdAt: new Date(base - 3_000),
    });
    await seedJob({
      type: "extract_memories",
      status: "complete",
      payload: { sessionId },
      createdAt: new Date(base - 2_000),
    });
    await seedJob({
      type: "consolidate_narrative",
      status: "pending",
      payload: { mode: "rebuild" },
      createdAt: new Date(base - 1_000),
    });

    const page = await listJobsForDiagnostics({ limit: 2 });
    expect(page.rows.map((row) => row.type)).toEqual([
      "consolidate_narrative",
      "extract_memories",
    ]);
    expect(page.nextCursor).toBe(page.rows[1].id);
    expect(page.rows[0]).toMatchObject({
      status: "pending",
      sourceKey: null,
      policyVersion: null,
      exhausted: [],
      payload: { mode: "rebuild" },
      lastError: null,
    });

    const next = await listJobsForDiagnostics({
      limit: 2,
      before: page.nextCursor!,
    });
    expect(next.rows).toHaveLength(1);
    expect(next.nextCursor).toBeNull();
    expect(next.rows[0]).toMatchObject({
      type: "write_diary_entry",
      status: "failed",
      attempts: 1,
      sourceKey: diarySourceKey(yesterday),
      policyVersion: 1,
      exhausted: [{ stage: "generation", model: "chat-test", reason: "max_tokens" }],
      payload: { date: yesterday },
      lastError: {
        raw: TERMINATION,
        partial: false,
        record: { stage: "generation", model: "chat-test", cap: 32_000, excerpt: "cut off" },
      },
    });

    const failed = await listJobsForDiagnostics({ status: "failed", limit: 50 });
    expect(failed.rows.map((row) => row.type)).toEqual(["write_diary_entry"]);
    const extraction = await listJobsForDiagnostics({ type: "extract_memories", limit: 50 });
    expect(extraction.rows.map((row) => row.status)).toEqual(["complete"]);
  });

  it("reports each writer's fence from the derived key, with older keys as history (AC 4)", async () => {
    const sessionId = await seedSession();
    const window = diaryDayWindow(yesterday);
    await seedMessage(sessionId, "user", new Date(window.start.getTime() + 3_600_000));
    await seedMessage(sessionId, "assistant", new Date(window.start.getTime() + 3_601_000));
    const newest = await newestCompletedMessageAt();
    const snapshotKey = await recentSnapshotSourceKey(newest);
    const narrativeKey = await narrativeSourceKey(newest);

    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 3_600_000);
    // A fence is a fence at any age; history is bounded to the window.
    const blockingSnapshot = await seedJob({
      type: "update_recent_snapshot",
      status: "failed",
      attempts: 3,
      payload: { sourceKey: snapshotKey },
      lastError: "Provider timeout.",
      createdAt: tenDaysAgo,
    });
    const staleNarrative = await seedJob({
      type: "consolidate_narrative",
      status: "failed",
      payload: { mode: "incremental", sourceKey: narrativeKey.replace(/\|p1$/, "|p0") },
      lastError: TERMINATION,
    });
    await seedJob({
      type: "consolidate_narrative",
      status: "failed",
      payload: { mode: "incremental", sourceKey: "v1|through:none|msg:none|mem:none|p0" },
      lastError: "ancient",
      createdAt: tenDaysAgo,
    });
    const blockingDiary = await seedJob({
      type: "write_diary_entry",
      status: "failed",
      payload: { date: yesterday, sourceKey: diarySourceKey(yesterday) },
      lastError: TERMINATION,
    });
    // A manual (keyless) failure never fences and never appears.
    await seedJob({
      type: "write_diary_entry",
      status: "failed",
      payload: { date: yesterday },
      lastError: "manual attempt failed",
    });

    const fences = await resolveFences();

    expect(fences.map((fence) => [fence.writer, fence.status])).toEqual([
      ["recent_snapshot", "blocked"],
      ["narrative", "clear"],
      ["diary", "blocked"],
    ]);
    expect(fences[0]).toMatchObject({
      sourceKey: snapshotKey,
      policyVersion: 1,
      blockedBy: { id: blockingSnapshot, attempts: 3, lastError: { record: null } },
      history: [],
    });
    expect(fences[1]).toMatchObject({
      sourceKey: narrativeKey,
      blockedBy: null,
      history: [{ id: staleNarrative, policyVersion: 0 }],
    });
    expect(fences[2]).toMatchObject({
      label: `Journal ${yesterday}`,
      sourceKey: diarySourceKey(yesterday),
      blockedBy: { id: blockingDiary, lastError: { record: { stage: "generation" } } },
      history: [],
    });
  });

  it("reports the diary as clear with no key when no closed day awaits an entry", async () => {
    const fences = await resolveFences();
    expect(fences[2]).toMatchObject({
      writer: "diary",
      sourceKey: null,
      status: "clear",
      blockedBy: null,
    });
  });

  it("returns tool runs per attempt in (round, call) order with purged bodies marked (AC 5)", async () => {
    const sessionId = await seedSession();
    const older = randomUUID();
    const newer = randomUUID();
    const base = Date.now() - 60_000;
    await seedRun({ attemptId: older, sessionId, assistantMessageId: randomUUID(), round: 1, call: 0, purged: true, startedAt: new Date(base + 2_000) });
    await seedRun({ attemptId: older, sessionId, assistantMessageId: randomUUID(), round: 0, call: 1, purged: true, startedAt: new Date(base + 1_000) });
    await seedRun({ attemptId: older, sessionId, assistantMessageId: randomUUID(), round: 0, call: 0, purged: true, startedAt: new Date(base) });
    await seedRun({ attemptId: newer, sessionId, assistantMessageId: randomUUID(), round: 0, call: 0, startedAt: new Date(base + 10_000) });

    const attempts = await listToolRunAttemptsForSession(sessionId, 200);

    expect(attempts.map((attempt) => attempt.attemptId)).toEqual([newer, older]);
    expect(attempts[1].runs.map((run) => `${run.roundIndex}.${run.callIndex}`)).toEqual([
      "0.0",
      "0.1",
      "1.0",
    ]);
    expect(attempts[1].runs[0]).toMatchObject({
      resultContent: null,
      input: null,
      precedingText: null,
      purgedAt: expect.any(String),
      elapsedMs: 250,
    });
    expect(attempts[0].runs[0]).toMatchObject({
      toolName: "search_memory",
      resultContent: "result body",
      precedingText: "thinking aloud",
      input: { query: "q" },
      purgedAt: null,
      status: "committed",
    });

    const single = await listToolRunAttempt(older);
    expect(single).toHaveLength(1);
    expect(single[0].runs).toHaveLength(3);
  });

  it("returns a memory's injection decisions newest first (AC 6)", async () => {
    const sessionId = await seedSession();
    const memoryId = await seedMemory("a traced memory");
    const untracedId = await seedMemory("an untraced memory");
    const now = Date.now();
    for (const [offset, injected, reason] of [
      [-3_000, true, null],
      [-2_000, false, "recently_injected"],
      [-1_000, false, "below_threshold"],
    ] as const) {
      const messageId = await seedMessage(sessionId, "user", new Date(now + offset));
      await connection`
        insert into memory_injections (session_id, message_id, memory_id, kind, similarity, score, injected, suppression_reason, created_at)
        values (${sessionId}, ${messageId}, ${memoryId}, 'shared_moment', 0.81, 0.62, ${injected}, ${reason},
          ${new Date(now + offset).toISOString()}::timestamptz)
      `;
    }

    const trace = await listMemoryTrace(memoryId, 50);
    expect(trace.map((decision) => [decision.injected, decision.suppressionReason])).toEqual([
      [false, "below_threshold"],
      [false, "recently_injected"],
      [true, null],
    ]);
    expect(trace[0]).toMatchObject({ sessionId, similarity: expect.closeTo(0.81, 2) });
    expect(await listMemoryTrace(untracedId, 50)).toEqual([]);
    expect(await listMemoryTrace(memoryId, 1)).toHaveLength(1);
  });

  it("aggregates the pulse and writes nothing anywhere (AC 1, AC 7)", async () => {
    const sessionId = await seedSession();
    const memoryId = await seedMemory("pulse memory");
    const messageId = await seedMessage(sessionId, "assistant", new Date(), true);
    await connection`
      insert into memory_injections (session_id, message_id, memory_id, kind, similarity, score, injected)
      values (${sessionId}, ${messageId}, ${memoryId}, 'shared_moment', 0.9, 0.7, true)
    `;
    await seedJob({ type: "embed_memory", status: "running", payload: { memoryId } });
    await seedJob({ type: "title_session", status: "failed", payload: { sessionId }, lastError: "x" });
    const before = await footprint();

    const pulse = await loadDiagnosticsPulse();
    await listJobsForDiagnostics({ limit: 50 });
    await resolveFences();
    await listToolRunAttemptsForSession(sessionId, 200);
    await listMemoryTrace(memoryId, 50);

    expect(pulse.memories).toMatchObject({ active: 1, trash: 0, byKind: [{ kind: "shared_moment", count: 1 }] });
    expect(pulse.injections).toMatchObject({
      injected: 1,
      suppressed: 0,
      topMemories: [{ memoryId, count: 1, kind: "shared_moment" }],
      assistantTurns: { total: 1, withWebSearch: 1 },
    });
    expect(pulse.carriers).toMatchObject({ tokenUnit: "estimator", diary: { entries: 0 } });
    expect(pulse.queue).toMatchObject({
      running: [{ type: "embed_memory" }],
      failedByType: [{ type: "title_session", count: 1 }],
      byStatusType: expect.arrayContaining([
        { status: "failed", type: "title_session", count: 1 },
        { status: "running", type: "embed_memory", count: 1 },
      ]),
    });
    expect(await footprint()).toEqual(before);
  });
});
