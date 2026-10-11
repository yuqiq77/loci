import { defineConfig } from "@playwright/test";

// The e2e app runs a real job worker, and the mock provider serves
// embeddings: embed_memory jobs would write fixed vectors into whatever
// database the server sees, and no spec's cleanup can undo that. So the
// database is an explicit, disposable one — never an inherited DATABASE_URL.
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error(
    "TEST_DATABASE_URL must point at a disposable database for e2e runs.",
  );
}
process.env.DATABASE_URL = testDatabaseUrl;

export default defineConfig({
  testDir: "./tests/e2e",
  // The settings row is a singleton, and its PUT is strict over the full
  // row: smoke.spec and tool-status.spec each save the whole form and
  // restore the whole original, so two files interleaving against one
  // database clobber each other. CI already runs one worker; this pins
  // local runs to the same.
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:3000",
  },
  webServer: [
    {
      command: "npx tsx tests/e2e/mock-anthropic-server.ts",
      url: "http://127.0.0.1:4010/health",
      reuseExistingServer: false,
    },
    {
      command: "npm run dev",
      url: "http://127.0.0.1:3000",
      // Never reuse a dev server on :3000 — it runs with real env instead
      // of the test env below, which silently breaks every login.
      reuseExistingServer: false,
      env: {
        APP_ORIGIN: "http://127.0.0.1:3000",
        DATABASE_URL: testDatabaseUrl,
        SESSION_SECRET: "playwright-session-secret-32-bytes",
        // $ escaped with \ so @next/env variable expansion keeps the
        // argon2 hash intact ($v, $m, ... would expand to "").
        OWNER_PASSWORD_HASH:
          "\\$argon2id\\$v=19\\$m=65536,t=3,p=4\\$Lv6aWG0UZ0Z12PriVjJ9SQ\\$gtThTG2RqOTlH3psIrtF24AxGmzpBeYwGOT/dhxZPAc",
        CHAT_API_KEY: "playwright-chat-key",
        CHAT_BASE_URL: "http://127.0.0.1:4010",
        CHAT_MODEL: "claude-playwright",
        // MC-117C: the mock also serves /v1/embeddings so the search_memory
        // gate (tools_enabled AND a configured embedding provider) can open.
        EMBEDDING_API_KEY: "playwright-embedding-key",
        EMBEDDING_BASE_URL: "http://127.0.0.1:4010/v1",
        EMBEDDING_MODEL: "playwright-embedding",
        EMBEDDING_DIMENSIONS: "1536",
      },
    },
  ],
});
