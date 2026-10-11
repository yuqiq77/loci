import { NextRequest, NextResponse } from "next/server";

import { requireOwner } from "@/server/auth/request";
import { estimateTextTokens } from "@/server/chat/context";
import {
  effectiveStandingContext,
  getRelationshipNarrative,
  NarrativeVersionConflictError,
  writeNarrativeVersion,
} from "@/server/db/narrative";
import { getSettings } from "@/server/db/settings";
import { errorResponse } from "@/server/http/errors";
import { profileSchema } from "@/server/profile/schema";
import {
  NARRATIVE_WRITE_CAP_RATIO,
  narrativeWriteCap,
} from "@/server/summaries/narrative-budget";

export const runtime = "nodejs";

// The manual cap is the narrative write cap (D20 as amended by MC-121): the
// same limit a pipeline write is held to, and the settings schema keeps the
// capsule large enough to seat it beside the snapshot and the summary at
// theirs — so any accepted paste renders in full. The editor shows the target
// as the normal size and the cap as the limit.

// The profile page is an editor over the long-horizon narrative (D11). Before
// the first save/consolidation (version 0) the retained standing-context
// field is served as the editable seed; from the first version on the
// narrative is authoritative, including a deliberately blanked one.
export async function GET(request: NextRequest): Promise<NextResponse> {
  const unauthorized = await requireOwner(request);
  if (unauthorized) {
    return unauthorized;
  }

  const settings = await getSettings();
  if (!settings) {
    return errorResponse("MODEL_NOT_CONFIGURED");
  }
  const narrative = await getRelationshipNarrative();
  const seeded = !narrative || narrative.version === 0;

  return NextResponse.json({
    content: effectiveStandingContext(narrative, settings.standingContext),
    source: seeded ? "standing_context" : "narrative",
    version: narrative?.version ?? 0,
    updatedAt: narrative?.updatedAt.toISOString() ?? null,
    targetTokens: settings.narrativeTargetTokens,
    tokenBudget: narrativeWriteCap(settings.narrativeTargetTokens),
  });
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const unauthorized = await requireOwner(request);
  if (unauthorized) {
    return unauthorized;
  }

  const body = await request.json().catch(() => null);
  const parsed = profileSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse("INVALID_INPUT");
  }
  const settings = await getSettings();
  if (!settings) {
    return errorResponse("MODEL_NOT_CONFIGURED");
  }
  const target = settings.narrativeTargetTokens;
  const cap = narrativeWriteCap(target);
  const estimated = estimateTextTokens(parsed.data.content);
  if (estimated > cap) {
    return errorResponse(
      "INVALID_INPUT",
      `Narrative is ${estimated} estimated tokens; the limit is ${cap} (target ${target} × ${NARRATIVE_WRITE_CAP_RATIO}).`,
    );
  }

  // Manual versions never advance consolidated_through: material between an
  // auto run and a manual edit must not be skipped by the next run. The
  // editor's loaded version rides along as an optimistic lock — background
  // consolidations write daily, so a save from a stale tab must fail loudly
  // instead of silently replacing a newer narrative.
  let written;
  try {
    written = await writeNarrativeVersion({
      content: parsed.data.content,
      mode: "manual",
      expectedVersion: parsed.data.expectedVersion,
    });
  } catch (error) {
    if (error instanceof NarrativeVersionConflictError) {
      return errorResponse("NARRATIVE_VERSION_CONFLICT");
    }
    throw error;
  }

  return NextResponse.json({
    content: written.content,
    source: "narrative",
    version: written.version,
    updatedAt: written.updatedAt.toISOString(),
    targetTokens: target,
    tokenBudget: cap,
  });
}
