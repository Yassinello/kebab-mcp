import { NextResponse } from "next/server";
import {
  getSkill,
  deleteSkill,
  skillUpdateInputSchema,
  updateSkillVersioned,
} from "@/connectors/skills/store";
import { refreshNow } from "@/connectors/skills/lib/remote-fetcher";
import { withAdminAuth } from "@/core/with-admin-auth";
import type { PipelineContext } from "@/core/pipeline";
import { toMsg } from "@/core/error-utils";

interface RouteContext {
  params: Promise<{ id: string }>;
}

async function getHandler(ctx: PipelineContext) {
  const routeCtx = ctx.routeParams as RouteContext;
  const { id } = await routeCtx.params;
  const skill = await getSkill(id);
  if (!skill) {
    return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, skill });
}

async function patchHandler(ctx: PipelineContext) {
  const request = ctx.request;
  const routeCtx = ctx.routeParams as RouteContext;
  const { id } = await routeCtx.params;

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
    return NextResponse.json({ ok: false, error: toMsg(err) }, { status: 500 });
  }
}

async function deleteHandler(ctx: PipelineContext) {
  const routeCtx = ctx.routeParams as RouteContext;
  const { id } = await routeCtx.params;
  const ok = await deleteSkill(id);
  if (!ok) {
    return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

export const GET = withAdminAuth(getHandler);
export const PATCH = withAdminAuth(patchHandler);
export const DELETE = withAdminAuth(deleteHandler);
