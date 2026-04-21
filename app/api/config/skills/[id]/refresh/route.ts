import { NextResponse } from "next/server";
import { checkAdminAuth } from "@/core/auth";
import { getSkill } from "@/connectors/skills/store";
import { refreshNow } from "@/connectors/skills/lib/remote-fetcher";
import { withBootstrapRehydrate } from "@/core/with-bootstrap-rehydrate";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/config/skills/[id]/refresh
 * Forces an immediate re-fetch of a remote skill. No-op for inline skills.
 */
async function postHandler(request: Request, ctx: RouteContext) {
  const authError = await checkAdminAuth(request);
  if (authError) return authError;
  const { id } = await ctx.params;

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
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

export const POST = withBootstrapRehydrate(postHandler);
