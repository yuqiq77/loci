import { checkDatabaseHealth } from "@/server/db/health";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    await checkDatabaseHealth();
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false }, { status: 503 });
  }
}
