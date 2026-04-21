import { NextResponse } from "next/server";
import { checkAdminAuth } from "@/core/auth";
import {
  listSkillVersions,
  getSkillVersion,
  getSkillCurrentVersion,
} from "@/connectors/skills/store";
import { withBootstrapRehydrate } from "@/core/with-bootstrap-rehydrate";

/**
 * GET /api/config/skill-versions?id=<skillId>
 *
 * Returns all versions for a skill with their metadata.
 */
async function getHandler(request: Request) {
  const authError = await checkAdminAuth(request);
  if (authError) return authError;

  const url = new URL(request.url);
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
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

export const GET = withBootstrapRehydrate(getHandler);
