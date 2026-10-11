import { NextRequest, NextResponse } from "next/server";

import { requireOwner } from "@/server/auth/request";
import {
  listMemoryChainLinks,
  permanentlyDeleteMemory,
  restoreMemory,
  softDeleteMemory,
  supersedeChainContains,
  updateMemory,
} from "@/server/db/memories";
import { enqueueJob } from "@/server/db/jobs";
import { errorResponse } from "@/server/http/errors";
import { hashMemoryContent } from "@/server/memory/extract";
import {
  memoryIdSchema,
  updateMemorySchema,
} from "@/server/memory/schema";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(
  request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  const unauthorized = await requireOwner(request);
  if (unauthorized) {
    return unauthorized;
  }

  const { id } = await context.params;
  if (!memoryIdSchema.safeParse(id).success) {
    return errorResponse("MEMORY_NOT_FOUND");
  }
  const parsed = updateMemorySchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return errorResponse("INVALID_INPUT");
  }
  if (parsed.data.supersededBy) {
    // Reject self-supersede and any edit that would close a cycle — a cycle
    // hides every row in it from retrieval with no active replacement.
    if (
      parsed.data.supersededBy === id ||
      (await supersedeChainContains({
        startId: parsed.data.supersededBy,
        targetId: id,
      }))
    ) {
      return errorResponse("INVALID_INPUT");
    }
  }

  const contentChanged = parsed.data.content !== undefined;
  const memory = await updateMemory(id, {
    ...parsed.data,
    ...(parsed.data.content
      ? { contentHash: await hashMemoryContent(parsed.data.content) }
      : {}),
    clearEmbedding: contentChanged,
  });
  if (!memory) {
    return errorResponse("MEMORY_NOT_FOUND");
  }

  if (contentChanged) {
    await enqueueJob("embed_memory", { memoryId: memory.id });
  }

  const chainLinks = await listMemoryChainLinks([memory.id]);
  return NextResponse.json({
    memory: {
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
    },
  });
}

export async function POST(
  request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  const unauthorized = await requireOwner(request);
  if (unauthorized) {
    return unauthorized;
  }

  const { id } = await context.params;
  if (
    !memoryIdSchema.safeParse(id).success ||
    !(await restoreMemory(id))
  ) {
    return errorResponse("MEMORY_NOT_FOUND");
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(
  request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  const unauthorized = await requireOwner(request);
  if (unauthorized) {
    return unauthorized;
  }

  const { id } = await context.params;
  const deleteOperation =
    request.nextUrl.searchParams.get("permanent") === "true"
      ? permanentlyDeleteMemory
      : softDeleteMemory;
  if (
    !memoryIdSchema.safeParse(id).success ||
    !(await deleteOperation(id))
  ) {
    return errorResponse("MEMORY_NOT_FOUND");
  }

  return NextResponse.json({ ok: true });
}
