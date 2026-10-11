import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { getDatabaseEnv } from "@/server/env";

import * as schema from "./schema";

let queryClient: ReturnType<typeof postgres> | undefined;

export function getDatabase() {
  if (!queryClient) {
    queryClient = postgres(getDatabaseEnv().DATABASE_URL, {
      max: 5,
      prepare: false,
    });
  }

  return drizzle(queryClient, { schema });
}

export async function closeDatabase(): Promise<void> {
  if (queryClient) {
    await queryClient.end();
    queryClient = undefined;
  }
}
