import { NextResponse } from "next/server";
import {
  listApiTools,
  createApiTool,
  apiToolCreateSchema,
  getApiConnection,
} from "@/connectors/api/store";
import { getEnabledPacksLazy } from "@/core/registry";
import { withAdminAuth } from "@/core/with-admin-auth";
import type { PipelineContext } from "@/core/pipeline";
import { toMsg } from "@/core/error-utils";

async function getHandler() {
  try {
    const tools = await listApiTools();
    return NextResponse.json({ ok: true, tools });
  } catch (err) {
    return NextResponse.json({ ok: false, error: toMsg(err) }, { status: 500 });
  }
}

async function postHandler(ctx: PipelineContext) {
  let body: unknown;
  try {
    body = await ctx.request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = apiToolCreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "Invalid payload", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  // Verify connection exists.
  const conn = await getApiConnection(parsed.data.connectionId);
  if (!conn) {
    return NextResponse.json(
      { ok: false, error: `Connection ${parsed.data.connectionId} not found` },
      { status: 400 }
    );
  }

  // Reject cross-pack tool name collision.
  for (const p of await getEnabledPacksLazy()) {
    if (p.manifest.id === "api-connections") continue;
    if (p.manifest.tools.some((t) => t.name === parsed.data.name)) {
      return NextResponse.json(
        {
          ok: false,
          error: `Tool name "${parsed.data.name}" would collide with pack "${p.manifest.id}"`,
        },
        { status: 409 }
      );
    }
  }

  try {
    const tool = await createApiTool(parsed.data);
    return NextResponse.json({ ok: true, tool }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ ok: false, error: toMsg(err) }, { status: 500 });
  }
}

export const GET = withAdminAuth(getHandler);
export const POST = withAdminAuth(postHandler);
