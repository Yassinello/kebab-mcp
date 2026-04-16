import { NextResponse } from "next/server";
import { checkAdminAuth } from "@/core/auth";
import {
  getSkill,
  deleteSkill,
  skillUpdateInputSchema,
  updateSkillVersioned,
} from "@/connectors/skills/store";
import { refreshNow } from "@/connectors/skills/lib/remote-fetcher";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, ctx: RouteContext) {
  const authError = checkAdminAuth(request);
  if (authError) return authError;
  const { id } = await ctx.params;
  const skill = await getSkill(id);
  if (!skill) {
    return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, skill });
}

export async function PATCH(request: Request, ctx: RouteContext) {
  const authError = checkAdminAuth(request);
  if (authError) return authError;
  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = skillUpdateInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "Invalid skill payload", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  try {
    let skill = await updateSkillVersioned(id, parsed.data);
    if (!skill) {
      return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
    }
    // If source was updated to remote, refresh cache.
    if (parsed.data.source && parsed.data.source.type === "remote") {
      skill = await refreshNow(skill);
    }
    return NextResponse.json({ ok: true, skill });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

export async function DELETE(request: Request, ctx: RouteContext) {
  const authError = checkAdminAuth(request);
  if (authError) return authError;
  const { id } = await ctx.params;
  const ok = await deleteSkill(id);
  if (!ok) {
    return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
