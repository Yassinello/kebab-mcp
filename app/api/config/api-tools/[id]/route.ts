import { NextResponse } from "next/server";
import {
  getApiTool,
  updateApiTool,
  deleteApiTool,
  apiToolUpdateSchema,
} from "@/connectors/api/store";
import { withAdminAuth } from "@/core/with-admin-auth";
import type { PipelineContext } from "@/core/pipeline";
import { toMsg } from "@/core/error-utils";

interface RouteContext {
  params: Promise<{ id: string }>;
}

async function getHandler(ctx: PipelineContext) {
  const routeCtx = ctx.routeParams as RouteContext;
  const { id } = await routeCtx.params;
  const tool = await getApiTool(id);
  if (!tool) {
    return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, tool });
}

async function patchHandler(ctx: PipelineContext) {
  const routeCtx = ctx.routeParams as RouteContext;
  const { id } = await routeCtx.params;

  let body: unknown;
  try {
    body = await ctx.request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = apiToolUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "Invalid payload", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  try {
    const updated = await updateApiTool(id, parsed.data);
    if (!updated) {
      return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, tool: updated });
  } catch (err) {
    return NextResponse.json({ ok: false, error: toMsg(err) }, { status: 500 });
  }
}

async function deleteHandler(ctx: PipelineContext) {
  const routeCtx = ctx.routeParams as RouteContext;
  const { id } = await routeCtx.params;
  try {
    const removed = await deleteApiTool(id);
    if (!removed) {
      return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: toMsg(err) }, { status: 500 });
  }
}

export const GET = withAdminAuth(getHandler);
export const PATCH = withAdminAuth(patchHandler);
export const DELETE = withAdminAuth(deleteHandler);
