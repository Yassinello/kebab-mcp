import { NextResponse } from "next/server";
import { checkAdminAuth } from "@/core/auth";
import { isClaimer } from "@/core/first-run";
import { STARTER_SKILLS } from "@/core/starter-skills";
import { createSkill } from "@/connectors/skills/store";
import { withBootstrapRehydrate } from "@/core/with-bootstrap-rehydrate";

/**
 * GET  /api/welcome/starter-skills              → list curated starter skills
 * POST /api/welcome/starter-skills  { id }      → install a starter skill into the user's store
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
  try {
    if (await isClaimer(request)) return null;
  } catch {
    // SigningSecretUnavailableError → deny via admin error.
  }
  return adminError;
}

async function getHandler(request: Request) {
  const authError = await checkWelcomeAuth(request);
  if (authError) return authError;
  return NextResponse.json({ skills: STARTER_SKILLS });
}

async function postHandler(request: Request) {
  const authError = await checkWelcomeAuth(request);
  if (authError) return authError;

  let body: { id?: string };
  try {
    body = (await request.json()) as { id?: string };
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const starter = STARTER_SKILLS.find((s) => s.id === body.id);
  if (!starter) {
    return NextResponse.json({ ok: false, error: "Unknown starter skill" }, { status: 404 });
  }

  try {
    const created = await createSkill({
      name: starter.name,
      description: starter.description,
      content: starter.content,
      arguments: starter.arguments,
      source: { type: "inline" },
    });
    return NextResponse.json({ ok: true, id: created.id });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : "Save failed",
    });
  }
}

export const GET = withBootstrapRehydrate(getHandler);
export const POST = withBootstrapRehydrate(postHandler);
