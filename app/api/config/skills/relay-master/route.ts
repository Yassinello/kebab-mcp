import { NextResponse } from "next/server";
import { exportMasterRelayZip, zipResponse } from "@/connectors/skills/lib/exporter";
import { MASTER_RELAY_NAME, normalizeTag } from "@/connectors/skills/lib/bundle";
import { withAdminAuth } from "@/core/with-admin-auth";
import type { PipelineContext } from "@/core/pipeline";

/**
 * GET /api/config/skills/relay-master[?tag=perso]
 *
 * Kebab House RLY-01/02 — the master relay: a zip holding one native
 * `kebab-house/SKILL.md` to upload once in claude.ai / ChatGPT. Its
 * description lists the skill names (all, or only those tagged `tag`); its
 * body routes to my_context → skills_list → skill_load.
 */
async function getHandler(ctx: PipelineContext) {
  const raw = new URL(ctx.request.url).searchParams.get("tag");
  let tag: string | null = null;
  if (raw !== null && raw.trim() !== "") {
    tag = normalizeTag(raw);
    if (!tag) return NextResponse.json({ error: "invalid_tag" }, { status: 400 });
  }
  const { zip, count } = await exportMasterRelayZip(tag);
  const filename = tag ? `${MASTER_RELAY_NAME}-${tag}.zip` : `${MASTER_RELAY_NAME}.zip`;
  return zipResponse(zip, filename, { "X-Kebab-Skill-Count": String(count) });
}

export const GET = withAdminAuth(getHandler);
