import { NextResponse } from "next/server";
import {
  listSkillVersions,
  getSkillVersion,
  getSkillCurrentVersion,
} from "@/connectors/skills/store";
import { withAdminAuth } from "@/core/with-admin-auth";
import type { PipelineContext } from "@/core/pipeline";
import { toMsg } from "@/core/error-utils";

/**
 * GET /api/config/skill-versions?id=<skillId>
 *
 * Returns all versions for a skill with their metadata.
 */
async function getHandler(ctx: PipelineContext) {
  const url = new URL(ctx.request.url);
  const skillId = url.searchParams.get("id");
  if (!skillId) {
    return NextResponse.json({ ok: false, error: "Missing id parameter" }, { status: 400 });
  }

  try {
    const versionNumbers = await listSkillVersions(skillId);
    const currentVersion = await getSkillCurrentVersion(skillId);
    const versions = await Promise.all(
      versionNumbers.map(async (v) => {
        const entry = await getSkillVersion(skillId, v);
        return entry
          ? {
              version: entry.version,
              savedAt: entry.savedAt,
              name: entry.name,
              description: entry.description,
              contentPreview: entry.content.slice(0, 200),
            }
          : null;
      })
    );
    return NextResponse.json({
      ok: true,
      skillId,
      currentVersion,
      versions: versions.filter(Boolean),
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: toMsg(err) }, { status: 500 });
  }
}

export const GET = withAdminAuth(getHandler);
