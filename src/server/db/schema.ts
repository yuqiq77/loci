import { sql } from "drizzle-orm";
import {
  AnyPgColumn,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

import { DEFAULT_SESSION_TITLE } from "../../shared/sessions";

export const messageRole = pgEnum("message_role", [
  "user",
  "assistant",
  "system",
  "tool",
]);

export const messageStatus = pgEnum("message_status", [
  "pending",
  "streaming",
  "complete",
  "failed",
  "cancelled",
]);

export const jobStatus = pgEnum("job_status", [
  "pending",
  "running",
  "complete",
  "failed",
]);

// tool_runs status is derived from the attempt's commit state (MC-117A):
// staged while the attempt streams, committed when completeGeneration
// commits, retracted when the attempt is discarded (MC-116A), superseded
// when a later tail rewrite discards a previously successful pair (MC-116B).
// Transitions are idempotent WHERE-guarded updates, so a lost ACK can never
// mark committed runs retracted.
export const toolRunStatus = pgEnum("tool_run_status", [
  "staged",
  "committed",
  "retracted",
  "superseded",
]);

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull().default(DEFAULT_SESSION_TITLE),
  modelId: text("model_id").notNull(),
  thinkingEnabled: boolean("thinking_enabled").notNull().default(false),
  thinkingEffort: text("thinking_effort").notNull().default("high"),
  summary: text("summary"),
  summaryThroughMessageId: uuid("summary_through_message_id").references(
    (): AnyPgColumn => messages.id,
    { onDelete: "set null" },
  ),
  extractedThroughMessageId: uuid(
    "extracted_through_message_id",
  ).references((): AnyPgColumn => messages.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
});

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    role: messageRole("role").notNull(),
    content: text("content").notNull().default(""),
    thinking: text("thinking"),
    status: messageStatus("status").notNull(),
    modelId: text("model_id"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    errorCode: text("error_code"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    usedWebSearch: boolean("used_web_search").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("messages_session_order_idx").on(
      table.sessionId,
      table.createdAt,
      table.id,
    ),
    index("messages_session_status_idx").on(table.sessionId, table.status),
    // Serves the session-independent continuity-tick reads: the shared
    // newest-completed aggregate and the diary's per-window material probes
    // (MC-111 — the tick predicate must stay on indexed reads).
    index("messages_completed_at_idx")
      .on(table.completedAt)
      .where(sql`${table.status} = 'complete'`),
  ],
);

export const memories = pgTable(
  "memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    content: text("content").notNull(),
    kind: text("kind").notNull().default("shared_moment"),
    embedding: vector("embedding", { dimensions: 1536 }),
    importance: real("importance").notNull().default(0.5),
    valence: real("valence").notNull().default(0),
    arousal: real("arousal").notNull().default(0),
    resolved: boolean("resolved").notNull().default(false),
    pinned: boolean("pinned").notNull().default(false),
    supersededBy: uuid("superseded_by").references(
      (): AnyPgColumn => memories.id,
      { onDelete: "set null" },
    ),
    sourceSessionId: uuid("source_session_id").references(() => sessions.id, {
      onDelete: "set null",
    }),
    sourceMessageId: uuid("source_message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    contentHash: text("content_hash").notNull(),
    recallCount: integer("recall_count").notNull().default(0),
    lastRecalledAt: timestamp("last_recalled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "memories_importance_check",
      sql`${table.importance} >= 0 AND ${table.importance} <= 1`,
    ),
    check(
      "memories_valence_check",
      sql`${table.valence} >= -1 AND ${table.valence} <= 1`,
    ),
    check(
      "memories_arousal_check",
      sql`${table.arousal} >= 0 AND ${table.arousal} <= 1`,
    ),
    index("memories_active_idx")
      .on(table.updatedAt.desc())
      .where(sql`${table.deletedAt} IS NULL`),
    index("memories_content_hash_idx")
      .on(table.contentHash)
      .where(sql`${table.deletedAt} IS NULL`),
    index("memories_superseded_by_idx").on(table.supersededBy),
  ],
);

export const memoryInjections = pgTable(
  "memory_injections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    memoryId: uuid("memory_id")
      .notNull()
      .references(() => memories.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    similarity: real("similarity").notNull(),
    score: real("score").notNull(),
    injected: boolean("injected").notNull(),
    suppressionReason: text("suppression_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("memory_injections_session_message_idx").on(
      table.sessionId,
      table.messageId,
    ),
    index("memory_injections_session_memory_idx").on(
      table.sessionId,
      table.memoryId,
      table.createdAt,
    ),
    index("memory_injections_message_idx").on(table.messageId),
  ],
);

// Retained audit table for the completed 2026-09-02 historical memory repair.
// Its migration has run, so the idle shape stays represented until a later
// maintenance migration removes it. No runtime writer remains.
export const memoryExtractionBackfillWindows = pgTable(
  "memory_extraction_backfill_windows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runKey: text("run_key").notNull(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    segment: integer("segment").notNull(),
    path: text("path").notNull(),
    // UUIDs are retained as historical boundaries rather than foreign keys:
    // a later safe-tail rewrite may remove a boundary message, and the
    // backfill row must remain visible as failed evidence instead of being
    // silently deleted or set-null.
    fromMessageId: uuid("from_message_id"),
    throughMessageId: uuid("through_message_id").notNull(),
    exchangeCount: integer("exchange_count").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxOutputTokens: integer("max_output_tokens").notNull(),
    candidateCount: integer("candidate_count").notNull().default(0),
    writtenCount: integer("written_count").notNull().default(0),
    dedupedCount: integer("deduped_count").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "memory_extraction_backfill_windows_status_check",
      sql`${table.status} in ('pending', 'running', 'complete', 'failed', 'split')`,
    ),
    check(
      "memory_extraction_backfill_windows_exchange_count_check",
      sql`${table.exchangeCount} >= 0`,
    ),
    uniqueIndex("memory_extraction_backfill_windows_run_path_idx").on(
      table.runKey,
      table.segment,
      table.path,
    ),
    index("memory_extraction_backfill_windows_run_status_idx").on(
      table.runKey,
      table.status,
      table.segment,
      table.path,
    ),
  ],
);

export const settings = pgTable(
  "settings",
  {
    id: integer("id").primaryKey(),
    systemPrompt: text("system_prompt").notNull(),
    standingContext: text("standing_context").notNull().default(""),
    defaultModelId: text("default_model_id").notNull(),
    temperature: real("temperature").notNull().default(0.7),
    maxOutputTokens: integer("max_output_tokens").notNull().default(2048),
    contextTokenBudget: integer("context_token_budget")
      .notNull()
      .default(96000),
    recentMessageBudget: integer("recent_message_budget")
      .notNull()
      .default(48000),
    memoryTokenBudget: integer("memory_token_budget").notNull().default(2000),
    capsuleTokenBudget: integer("capsule_token_budget")
      .notNull()
      .default(12000),
    // MC-121: the narrative's own target, no longer derived from the capsule.
    narrativeTargetTokens: integer("narrative_target_tokens")
      .notNull()
      .default(6400),
    recentSnapshotTokenBudget: integer("recent_snapshot_token_budget")
      .notNull()
      .default(400),
    summaryTriggerTokens: integer("summary_trigger_tokens")
      .notNull()
      .default(72000),
    memoryRetrievalLimit: integer("memory_retrieval_limit").notNull().default(5),
    webSearchEnabled: boolean("web_search_enabled").notNull().default(true),
    // Client-tool gate (MC-117B): gates the client tool allowlist only —
    // web_search is provider-hosted and stays on webSearchEnabled.
    toolsEnabled: boolean("tools_enabled").notNull().default(true),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [check("settings_single_row_check", sql`${table.id} = 1`)],
);

export const recentContinuitySnapshot = pgTable(
  "recent_continuity_snapshot",
  {
    id: integer("id").primaryKey(),
    content: text("content").notNull().default(""),
    version: integer("version").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    sourceWindowStart: timestamp("source_window_start", { withTimezone: true }),
    sourceWindowEnd: timestamp("source_window_end", { withTimezone: true }),
    sourceSummaryIds: jsonb("source_summary_ids")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    sourceMemoryIds: jsonb("source_memory_ids")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    staleAfter: timestamp("stale_after", { withTimezone: true }),
  },
  (table) => [
    check(
      "recent_continuity_snapshot_single_row_check",
      sql`${table.id} = 1`,
    ),
  ],
);

export const relationshipNarrative = pgTable(
  "relationship_narrative",
  {
    id: integer("id").primaryKey(),
    content: text("content").notNull().default(""),
    version: integer("version").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Source watermark: consolidation has folded in material completed up to
    // here. Advances only on consolidation runs — manual edits bump
    // updated_at/version but never this, so material between an auto run and
    // a manual edit is never skipped.
    consolidatedThrough: timestamp("consolidated_through", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "relationship_narrative_single_row_check",
      sql`${table.id} = 1`,
    ),
  ],
);

export const relationshipNarrativeVersions = pgTable(
  "relationship_narrative_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    content: text("content").notNull(),
    version: integer("version").notNull(),
    mode: text("mode").notNull(),
    // Carrier provenance ("the signature", MC-115 E): which provider chain
    // candidate, model, and host generated this version, written at
    // generation time. Nullable — manual edits and pre-2026-08-30 rows carry
    // none until backfilled. Schema metadata only, never rendered into the
    // content (the author is the assistant, not a model ID).
    provider: text("provider"),
    model: text("model"),
    host: text("host"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("relationship_narrative_versions_version_idx").on(
      table.version.desc(),
    ),
  ],
);

// One row per diary day — the [D 04:00, D+1 04:00) server-time window,
// entry_date = D. Append-only: no update or delete surface (MC-111); a
// concurrent duplicate write must lose to the existing row, never replace it.
export const diaryEntries = pgTable("diary_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  entryDate: date("entry_date", { mode: "string" }).notNull().unique(),
  content: text("content").notNull(),
  // Carrier provenance ("the signature", MC-115 E) — see
  // relationshipNarrativeVersions above; same semantics, same nullability.
  provider: text("provider"),
  model: text("model"),
  host: text("host"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// The diary epoch is the moment migration 0012 ran on this database (mirrors
// MC-101R's watermark-at-migration choice): days before it are never
// auto-journaled — pre-epoch history belongs to an explicit backfill.
export const diaryState = pgTable(
  "diary_state",
  {
    id: integer("id").primaryKey(),
    epoch: timestamp("epoch", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("diary_state_single_row_check", sql`${table.id} = 1`)],
);

// Tool rounds never persist as messages (MC-117A, addendum §8): a dedicated
// table excludes tool output from every continuity consumer by construction.
// Rows are flagged, never orphan-deleted — the message pair a retraction
// deletes may be gone while its runs remain as trace, so assistant_message_id
// carries no FK. Input/result/text bodies older than
// TOOL_RUN_BODY_RETENTION_DAYS are purged by the session's own debris sweep at
// its next beginGeneration (a dormant session keeps them); ids, statuses,
// timings, and the schema hash are retained.
export const toolRuns = pgTable(
  "tool_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Server-authoritative attempt identity, created at beginGeneration —
    // never the client metadata attempt UUID.
    attemptId: uuid("attempt_id").notNull(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    assistantMessageId: uuid("assistant_message_id").notNull(),
    roundIndex: integer("round_index").notNull(),
    callIndex: integer("call_index").notNull(),
    providerToolUseId: text("provider_tool_use_id").notNull(),
    toolName: text("tool_name").notNull(),
    toolSchemaHash: text("tool_schema_hash"),
    input: jsonb("input").$type<Record<string, unknown>>(),
    // The bounded result content exactly as returned to the model.
    resultContent: text("result_content"),
    isError: boolean("is_error").notNull().default(false),
    errorCode: text("error_code"),
    // Provider text preceding the round's tool_use, stored on the round's
    // first run (call_index 0); never streamed, never message prose.
    precedingText: text("preceding_text"),
    status: toolRunStatus("status").notNull().default("staged"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    purgedAt: timestamp("purged_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("tool_runs_attempt_tool_use_idx").on(
      table.attemptId,
      table.providerToolUseId,
    ),
    index("tool_runs_attempt_order_idx").on(
      table.attemptId,
      table.roundIndex,
      table.callIndex,
    ),
    // The §7.1 echo marker capability: whether an assistant turn consumed
    // tool results is queryable per turn through this join. No reader
    // consumes it in Phase A.
    index("tool_runs_assistant_message_idx").on(table.assistantMessageId),
    // Serves the body-retention purge inside the session-scoped debris sweep.
    index("tool_runs_session_created_idx").on(
      table.sessionId,
      table.createdAt,
    ),
  ],
);

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type").notNull(),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull(),
    status: jobStatus("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("jobs_claim_idx").on(
      table.status,
      table.availableAt,
      table.createdAt,
    ),
  ],
);
