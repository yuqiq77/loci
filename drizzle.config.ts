import { loadEnvConfig } from "@next/env";
import { defineConfig } from "drizzle-kit";

import { getDatabaseEnv } from "./src/server/env";

loadEnvConfig(process.cwd());

const { DATABASE_URL: databaseUrl } = getDatabaseEnv();

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: databaseUrl,
  },
});
