import { NextResponse } from "next/server";
import { getSkill, getSkillFiles, setSkillFiles } from "@/connectors/skills/store";
import { withAdminAuth } from "@/core/with-admin-auth";
import type { PipelineContext } from "@/core/pipeline";

/**
 * Skills v2 — bundled files of a skill.
 *   GET → { files: { [path]: content } }
 *   PUT { files: { [path]: content } } → replaces the whole set (validated:
 *        safe relative paths, ≤30 files, ≤100 KB each, ≤512 KB total).
 */

interface RouteContext {
  params: Promise<{ id: string }>;
}

async function getHandler(ctx: PipelineContext) {
  const { id } = await (ctx.routeParams as RouteContext).params;
  const skill = await getSkill(id);
  if (!skill) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ files: await getSkillFiles(id) });
}

async function putHandler(ctx: PipelineContext) {
  const { id } = await (ctx.routeParams as RouteContext).params;
  let body: { files?: unknown };
  try {
    body = (await ctx.request.json()) as { files?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const files = body.files;
  if (!files || typeof files !== "object" || Array.isArray(files)) {
    return NextResponse.json({ error: "invalid_files" }, { status: 400 });
  }
  const result = await setSkillFiles(id, files as Record<string, string>);
  if ("error" in result) {
    const status = result.error === "skill_not_found" ? 404 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json({ skill: result });
}

export const GET = withAdminAuth(getHandler);
export const PUT = withAdminAuth(putHandler);
