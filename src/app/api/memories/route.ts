import { NextRequest, NextResponse } from "next/server";

import { requireOwner } from "@/server/auth/request";
import {
  countActive,
  countDeleted,
  listMemoryChainLinks,
  searchActive,
  searchDeleted,
} from "@/server/db/memories";
import { errorResponse } from "@/server/http/errors";
import { memoriesQuerySchema } from "@/server/memory/schema";

export const runtime = "nodejs";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const unauthorized = await requireOwner(request);
  if (unauthorized) {
    return unauthorized;
  }

  const parsed = memoriesQuerySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );
  if (!parsed.success) {
    return errorResponse("INVALID_INPUT");
  }

  const search = parsed.data.trash ? searchDeleted : searchActive;
  const count = parsed.data.trash ? countDeleted : countActive;
  const [rows, total] = await Promise.all([
    search({
      query: parsed.data.q,
      kind: parsed.data.kind,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
    }),
    count(parsed.data.q, parsed.data.kind),
  ]);
  const chainLinks = await listMemoryChainLinks(rows.map((memory) => memory.id));
  return NextResponse.json({
    total,
    memories: rows.map((memory) => ({
      id: memory.id,
      content: memory.content,
      kind: memory.kind,
      importance: memory.importance,
      valence: memory.valence,
      arousal: memory.arousal,
      resolved: memory.resolved,
      pinned: memory.pinned,
      supersededBy: memory.supersededBy,
      supersededByMemory:
        chainLinks.get(memory.id)?.supersededBy ?? null,
      supersedes: chainLinks.get(memory.id)?.supersedes ?? [],
      recallCount: memory.recallCount,
      lastRecalledAt: memory.lastRecalledAt?.toISOString() ?? null,
      createdAt: memory.createdAt.toISOString(),
      updatedAt: memory.updatedAt.toISOString(),
      deletedAt: memory.deletedAt?.toISOString() ?? null,
    })),
  });
}
