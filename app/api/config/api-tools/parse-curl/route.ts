import { NextResponse } from "next/server";
import { parseCurl, curlToDraft } from "@/connectors/api/lib/curl-parse";
import { withAdminAuth } from "@/core/with-admin-auth";
import type { PipelineContext } from "@/core/pipeline";
import { toMsg } from "@/core/error-utils";

/**
 * POST /api/config/api-tools/parse-curl
 * Body: { curl: string }
 * Returns a draft tool payload the wizard can pre-fill.
 */
async function postHandler(ctx: PipelineContext) {
  let body: { curl?: string } = {};
  try {
    const raw = await ctx.request.json();
    if (raw && typeof raw === "object") body = raw as { curl?: string };
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.curl || typeof body.curl !== "string") {
    return NextResponse.json({ ok: false, error: "Missing 'curl' field" }, { status: 400 });
  }

  try {
    const parsed = parseCurl(body.curl);
    const draft = curlToDraft(parsed);
    return NextResponse.json({ ok: true, draft });
  } catch (err) {
    return NextResponse.json({ ok: false, error: toMsg(err) }, { status: 400 });
  }
}

export const POST = withAdminAuth(postHandler);
