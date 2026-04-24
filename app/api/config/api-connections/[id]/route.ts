import { NextResponse } from "next/server";
import {
  getApiConnection,
  updateApiConnection,
  deleteApiConnection,
  deleteApiToolsForConnection,
  apiConnectionUpdateSchema,
} from "@/connectors/api/store";
import { withAdminAuth } from "@/core/with-admin-auth";
import type { PipelineContext } from "@/core/pipeline";
import { toMsg } from "@/core/error-utils";

interface RouteContext {
  params: Promise<{ id: string }>;
}

function redactAuth(auth: unknown): unknown {
  if (!auth || typeof auth !== "object") return auth;
  const a = auth as { type?: string };
  switch (a.type) {
    case "bearer":
      return { type: "bearer", token: "***" };
    case "api_key_header": {
      const o = a as { headerName?: string };
      return { type: "api_key_header", headerName: o.headerName, value: "***" };
    }
    case "basic": {
      const o = a as { username?: string };
      return { type: "basic", username: o.username, password: "***" };
    }
    default:
      return auth;
  }
}

async function getHandler(ctx: PipelineContext) {
  const routeCtx = ctx.routeParams as RouteContext;
  const { id } = await routeCtx.params;
  const conn = await getApiConnection(id);
  if (!conn) {
    return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, connection: { ...conn, auth: redactAuth(conn.auth) } });
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

  const parsed = apiConnectionUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "Invalid payload", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  try {
    const updated = await updateApiConnection(id, parsed.data);
    if (!updated) {
      return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({
      ok: true,
      connection: { ...updated, auth: redactAuth(updated.auth) },
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: toMsg(err) }, { status: 500 });
  }
}

async function deleteHandler(ctx: PipelineContext) {
  const routeCtx = ctx.routeParams as RouteContext;
  const { id } = await routeCtx.params;

  try {
    const toolsRemoved = await deleteApiToolsForConnection(id);
    const removed = await deleteApiConnection(id);
    if (!removed) {
      return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, toolsRemoved });
  } catch (err) {
    return NextResponse.json({ ok: false, error: toMsg(err) }, { status: 500 });
  }
}

export const GET = withAdminAuth(getHandler);
export const PATCH = withAdminAuth(patchHandler);
export const DELETE = withAdminAuth(deleteHandler);
