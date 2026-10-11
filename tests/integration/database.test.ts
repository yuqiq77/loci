import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

describeWithDatabase("database migrations", () => {
  const connection = postgres(testDatabaseUrl!, {
    max: 1,
    prepare: false,
  });
  const database = drizzle(connection);

  beforeAll(async () => {
    await migrate(database, { migrationsFolder: "drizzle" });
  });

  afterAll(async () => {
    await connection.end();
  });

  it("contains the expected application tables", async () => {
    const rows = await connection<{ table_name: string }[]>`
      select table_name
      from information_schema.tables
      where table_schema = 'public'
        and table_name in (
          'sessions',
          'messages',
          'memories',
          'memory_injections',
          'recent_continuity_snapshot',
          'settings',
          'jobs'
        )
      order by table_name
    `;

    expect(rows.map((row) => row.table_name)).toEqual([
      "jobs",
      "memories",
      "memory_injections",
      "messages",
      "recent_continuity_snapshot",
      "sessions",
      "settings",
    ]);
  });

  it("creates the recent continuity snapshot singleton table", async () => {
    const columns = await connection<
      { column_name: string; is_nullable: string; column_default: string | null }[]
    >`
      select column_name, is_nullable, column_default
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'recent_continuity_snapshot'
        and column_name in (
          'id',
          'content',
          'version',
          'updated_at',
          'source_window_start',
          'source_window_end',
          'source_summary_ids',
          'source_memory_ids',
          'stale_after'
        )
      order by column_name
    `;

    expect(columns.map((row) => row.column_name)).toEqual([
      "content",
      "id",
      "source_memory_ids",
      "source_summary_ids",
      "source_window_end",
      "source_window_start",
      "stale_after",
      "updated_at",
      "version",
    ]);
    expect(
      columns.find((row) => row.column_name === "source_summary_ids")
        ?.column_default,
    ).toBe("'[]'::jsonb");

    const checks = await connection<{ conname: string }[]>`
      select conname
      from pg_constraint
      where conrelid = 'recent_continuity_snapshot'::regclass
        and conname = 'recent_continuity_snapshot_single_row_check'
    `;
    expect(checks).toHaveLength(1);
  });

  it("adds the capsule, narrative target, and recent snapshot budget settings", async () => {
    const columns = await connection<
      {
        column_name: string;
        column_default: string | null;
        is_nullable: string;
      }[]
    >`
      select column_name, column_default, is_nullable
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'settings'
        and column_name in (
          'capsule_token_budget',
          'narrative_target_tokens',
          'recent_snapshot_token_budget'
        )
      order by column_name
    `;

    expect(columns).toEqual([
      {
        column_name: "capsule_token_budget",
        column_default: "12000",
        is_nullable: "NO",
      },
      {
        column_name: "narrative_target_tokens",
        column_default: "6400",
        is_nullable: "NO",
      },
      {
        column_name: "recent_snapshot_token_budget",
        column_default: "400",
        is_nullable: "NO",
      },
    ]);
  });

  it("enables pgcrypto and vector", async () => {
    const rows = await connection<{ extname: string }[]>`
      select extname
      from pg_extension
      where extname in ('pgcrypto', 'vector')
      order by extname
    `;

    expect(rows.map((row) => row.extname)).toEqual(["pgcrypto", "vector"]);
  });

  it("seeds exactly one settings row", async () => {
    const [row] = await connection<{ count: number }[]>`
      select count(*)::int as count from settings
    `;

    expect(row.count).toBe(1);
  });

  it("indexes message ordering and active status lookups", async () => {
    const rows = await connection<{ indexname: string }[]>`
      select indexname
      from pg_indexes
      where schemaname = 'public'
        and tablename = 'messages'
        and indexname in (
          'messages_session_order_idx',
          'messages_session_status_idx'
        )
      order by indexname
    `;

    expect(rows.map((row) => row.indexname)).toEqual([
      "messages_session_order_idx",
      "messages_session_status_idx",
    ]);
  });

  it("adds extraction cadence and write-time hygiene columns", async () => {
    const columns = await connection<
      {
        table_name: string;
        column_name: string;
        column_default: string | null;
        is_nullable: string;
      }[]
    >`
      select table_name, column_name, column_default, is_nullable
      from information_schema.columns
      where table_schema = 'public'
        and (
          (table_name = 'sessions' and column_name = 'extracted_through_message_id')
          or (table_name = 'messages' and column_name = 'used_web_search')
          or (table_name = 'memories' and column_name = 'superseded_by')
        )
      order by table_name, column_name
    `;

    expect(columns).toEqual([
      {
        table_name: "memories",
        column_name: "superseded_by",
        column_default: null,
        is_nullable: "YES",
      },
      {
        table_name: "messages",
        column_name: "used_web_search",
        column_default: "false",
        is_nullable: "NO",
      },
      {
        table_name: "sessions",
        column_name: "extracted_through_message_id",
        column_default: null,
        is_nullable: "YES",
      },
    ]);

    const rows = await connection<{ indexname: string }[]>`
      select indexname
      from pg_indexes
      where schemaname = 'public'
        and tablename = 'memories'
        and indexname = 'memories_superseded_by_idx'
    `;
    expect(rows).toEqual([{ indexname: "memories_superseded_by_idx" }]);
  });

  it("creates memory injection trace indexes", async () => {
    const rows = await connection<{ indexname: string }[]>`
      select indexname
      from pg_indexes
      where schemaname = 'public'
        and tablename = 'memory_injections'
        and indexname in (
          'memory_injections_session_message_idx',
          'memory_injections_session_memory_idx',
          'memory_injections_message_idx'
        )
      order by indexname
    `;

    expect(rows.map((row) => row.indexname)).toEqual([
      "memory_injections_message_idx",
      "memory_injections_session_memory_idx",
      "memory_injections_session_message_idx",
    ]);
  });

  it("has at least one checked-in migration", () => {
    expect(readMigrationFiles({ migrationsFolder: "drizzle" })).not.toHaveLength(
      0,
    );
  });
});
