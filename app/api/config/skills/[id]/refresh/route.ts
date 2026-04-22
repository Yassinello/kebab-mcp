import { NextResponse } from "next/server";
import { getSkill } from "@/connectors/skills/store";
import { refreshNow } from "@/connectors/skills/lib/remote-fetcher";
import { withAdminAuth } from "@/core/with-admin-auth";
import type { PipelineContext } from "@/core/pipeline";
import { toMsg } from "@/core/error-utils";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/config/skills/[id]/refresh
 * Forces an immediate re-fetch of a remote skill. No-op for inline skills.
 */
async function postHandler(ctx: PipelineContext) {
  const routeCtx = ctx.routeParams as RouteContext;
  const { id } = await routeCtx.params;

  const skill = await getSkill(id);
  if (!skill) {
    return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  }
  if (skill.source.type !== "remote") {
    return NextResponse.json({ ok: false, error: "Not a remote skill" }, { status: 400 });
  }

  try {
    const updated = await refreshNow(skill);
    if (updated.source.type === "remote" && updated.source.lastError) {
      return NextResponse.json({
        ok: false,
        error: `Fetch failed: ${updated.source.lastError}`,
        skill: updated,
      });
    }
    return NextResponse.json({ ok: true, skill: updated });
  } catch (err) {
    return NextResponse.json({ ok: false, error: toMsg(err) }, { status: 500 });
  }
}

export const POST = withAdminAuth(postHandler);
