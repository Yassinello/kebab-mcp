import { NextResponse } from "next/server";
import { checkAdminAuth } from "@/core/auth";
import { isClaimer } from "@/core/first-run";
import { installSkillTemplate, templateCatalog } from "@/connectors/skills/lib/templates";
import { composeRequestPipeline, rehydrateStep, type PipelineContext } from "@/core/pipeline";

/**
 * GET  /api/welcome/starter-skills              → list the ritual templates
 * POST /api/welcome/starter-skills  { id }      → install one into the user's store
 *
 * Kebab House RIT-02: the "starter skills" are now the ritual templates
 * (content/skill-templates/, see src/connectors/skills/lib/templates.ts).
 * Same contract as before: GET → { skills: [{ id, name, description, icon,
 * … }] }, POST { id } → { ok, id } (plus `action`: created | updated |
 * unchanged). Install goes through the regular import path, so installing
 * twice updates instead of duplicating. Skills installed from the old
 * hard-coded starters are left untouched (RIT-04).
 *
 * Auth: admin-authed OR (during first-run + immediately after) the original
 * /welcome claimer cookie. The relaxed path is necessary because the user
 * lands on /welcome before they have an admin cookie set, so they couldn't
 * install a starter skill without it. The claimer cookie identifies a single
 * browser that successfully claimed this instance — same trust level as the
 * /welcome init flow itself.
 */

async function checkWelcomeAuth(request: Request): Promise<Response | null> {
  // Standard admin auth wins fastest path.
  const adminError = await checkAdminAuth(request);
  if (!adminError) return null;
  // Fall back to the first-run claimer cookie.
  // silent-swallow-ok: SigningSecretUnavailableError here is not a bug — it means KV is absent; fall through to the adminError response below
  try {
    if (await isClaimer(request)) return null;
  } catch {
    // Deliberate fallthrough to adminError below.
  }
  return adminError;
}

async function getHandler(ctx: PipelineContext) {
  const authError = await checkWelcomeAuth(ctx.request);
  if (authError) return authError;
  return NextResponse.json({ skills: await templateCatalog() });
}

async function postHandler(ctx: PipelineContext) {
  const request = ctx.request;
  const authError = await checkWelcomeAuth(request);
  if (authError) return authError;

  let body: { id?: string };
  try {
    body = (await request.json()) as { id?: string };
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  if (typeof body.id !== "string" || !body.id.trim()) {
    return NextResponse.json({ ok: false, error: "Unknown starter skill" }, { status: 404 });
  }

  try {
    const res = await installSkillTemplate(body.id);
    if (!res.ok) {
      // 404 for an unknown id (as before); install failures keep the
      // historical 200 + { ok: false } shape the welcome UI reads.
      return NextResponse.json(
        { ok: false, error: res.status === 404 ? "Unknown starter skill" : res.error },
        { status: res.status === 404 ? 404 : 200 }
      );
    }
    return NextResponse.json({ ok: true, id: res.id, name: res.name, action: res.action });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : "Save failed",
    });
  }
}

export const GET = composeRequestPipeline([rehydrateStep], getHandler);
export const POST = composeRequestPipeline([rehydrateStep], postHandler);
