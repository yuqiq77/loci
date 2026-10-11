import { loadEnvConfig } from "@next/env";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { getDatabaseEnv } from "../src/server/env";

loadEnvConfig(process.cwd());

const connection = postgres(getDatabaseEnv().DATABASE_URL, {
  max: 1,
  prepare: false,
});
const database = drizzle(connection);

async function main(): Promise<void> {
  try {
    await migrate(database, { migrationsFolder: "drizzle" });
    console.log("Database migrations completed.");
  } finally {
    await connection.end();
  }
}

main().catch((error: unknown) => {
  console.error("Database migration failed.", error);
  process.exitCode = 1;
});
