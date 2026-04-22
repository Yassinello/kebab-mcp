import { NextResponse } from "next/server";
import { rollbackSkill } from "@/connectors/skills/store";
import { withAdminAuth } from "@/core/with-admin-auth";
import type { PipelineContext } from "@/core/pipeline";
import { toMsg } from "@/core/error-utils";

/**
 * POST /api/config/skill-rollback
 * Body: { id: string, version: number }
 *
 * Rolls back a skill to a previous version. Creates a new version (N+1)
 * with the old content — history is append-only.
 */
async function postHandler(ctx: PipelineContext) {
  const request = ctx.request;

  let body: { id?: string; version?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const { id, version } = body;
  if (!id || typeof id !== "string") {
    return NextResponse.json({ ok: false, error: "Missing or invalid id" }, { status: 400 });
  }
  if (typeof version !== "number" || !Number.isFinite(version) || version < 1) {
    return NextResponse.json({ ok: false, error: "Missing or invalid version" }, { status: 400 });
  }

  try {
    const skill = await rollbackSkill(id, version);
    if (!skill) {
      return NextResponse.json({ ok: false, error: "Skill or version not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, skill });
  } catch (err) {
    return NextResponse.json({ ok: false, error: toMsg(err) }, { status: 500 });
  }
}

export const POST = withAdminAuth(postHandler);
