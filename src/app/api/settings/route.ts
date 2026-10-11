import { NextRequest, NextResponse } from "next/server";

import { requireOwner } from "@/server/auth/request";
import { AVAILABLE_MODELS } from "@/server/chat/models";
import {
  getSettings,
  updateSettings,
} from "@/server/db/settings";
import { errorResponse } from "@/server/http/errors";
import { isMemoryEnabled } from "@/server/memory/embedding";
import { settingsSchema } from "@/server/settings/schema";

export const runtime = "nodejs";

function publicSettings(row: NonNullable<Awaited<ReturnType<typeof getSettings>>>) {
  return {
    systemPrompt: row.systemPrompt,
    temperature: row.temperature,
    maxOutputTokens: row.maxOutputTokens,
    contextTokenBudget: row.contextTokenBudget,
    recentMessageBudget: row.recentMessageBudget,
    memoryTokenBudget: row.memoryTokenBudget,
    capsuleTokenBudget: row.capsuleTokenBudget,
    narrativeTargetTokens: row.narrativeTargetTokens,
    recentSnapshotTokenBudget: row.recentSnapshotTokenBudget,
    summaryTriggerTokens: row.summaryTriggerTokens,
    memoryRetrievalLimit: row.memoryRetrievalLimit,
    webSearchEnabled: row.webSearchEnabled,
    toolsEnabled: row.toolsEnabled,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const unauthorized = await requireOwner(request);
  if (unauthorized) {
    return unauthorized;
  }

  const row = await getSettings();
  if (!row) {
    return errorResponse("INTERNAL_ERROR");
  }

  return NextResponse.json({
    settings: publicSettings(row),
    models: AVAILABLE_MODELS,
    defaultModelId: row.defaultModelId,
    memoryEnabled: isMemoryEnabled(),
  });
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const unauthorized = await requireOwner(request);
  if (unauthorized) {
    return unauthorized;
  }

  const parsed = settingsSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return errorResponse("INVALID_INPUT");
  }

  const row = await updateSettings(parsed.data);
  if (!row) {
    return errorResponse("INTERNAL_ERROR");
  }

  return NextResponse.json({ settings: publicSettings(row) });
}
