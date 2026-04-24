import { NextResponse } from "next/server";
import { getApiConnection } from "@/connectors/api/store";
import { testApiConnection } from "@/connectors/api/lib/invoke";
import { withAdminAuth } from "@/core/with-admin-auth";
import type { PipelineContext } from "@/core/pipeline";
import { toMsg } from "@/core/error-utils";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/config/api-connections/:id/test
 * Body: { probePath?: string } (default "/")
 */
async function postHandler(ctx: PipelineContext) {
  const routeCtx = ctx.routeParams as RouteContext;
  const { id } = await routeCtx.params;

  let probePath = "/";
  try {
    const body = await ctx.request.json();
    if (
      body &&
      typeof body === "object" &&
      typeof (body as { probePath?: string }).probePath === "string"
    ) {
      probePath = (body as { probePath: string }).probePath;
    }
  } catch {
    /* empty body is fine */
  }

  const conn = await getApiConnection(id);
  if (!conn) {
    return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  }

  try {
    const result = await testApiConnection(conn, probePath);
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    return NextResponse.json({ ok: false, error: toMsg(err) }, { status: 500 });
  }
}

export const POST = withAdminAuth(postHandler);
