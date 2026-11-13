import { NextResponse } from "next/server";
import { installSkillTemplate, templateCatalog } from "@/connectors/skills/lib/templates";
import { withAdminAuth } from "@/core/with-admin-auth";
import type { PipelineContext } from "@/core/pipeline";

/**
 * Kebab House RIT-02 — ritual templates for the dashboard Skills tab.
 *
 * GET  → { ok, templates: [{ id, name, skillId, title, description, icon, tags, status, installed }] }
 * POST { id } → { ok, id, name, action: created | updated | unchanged }
 *
 * Install goes through the regular import path (versioning, update instead
 * of duplicate). /api/welcome/starter-skills exposes the same catalogue
 * during onboarding.
 */
async function getHandler(_ctx: PipelineContext) {
  return NextResponse.json({ ok: true, templates: await templateCatalog() });
}

async function postHandler(ctx: PipelineContext) {
  let body: { id?: unknown };
  try {
    body = (await ctx.request.json()) as { id?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.id !== "string" || !body.id.trim()) {
    return NextResponse.json({ ok: false, error: "Missing template id" }, { status: 400 });
  }
  const res = await installSkillTemplate(body.id);
  if (!res.ok) return NextResponse.json({ ok: false, error: res.error }, { status: res.status });
  return NextResponse.json(res);
}

export const GET = withAdminAuth(getHandler);
export const POST = withAdminAuth(postHandler);
