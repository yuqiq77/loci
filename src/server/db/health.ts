import { sql } from "drizzle-orm";

import { getDatabase } from "./client";

export async function checkDatabaseHealth(): Promise<void> {
  await getDatabase().execute(sql`select 1`);
}
