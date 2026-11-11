import { getSkill } from "@/connectors/skills/store";
import { exportRelayZip, exportSkillZip, zipResponse } from "@/connectors/skills/lib/exporter";
import { toAgentName } from "@/connectors/skills/lib/bundle";
import { withAdminAuth } from "@/core/with-admin-auth";
import type { PipelineContext } from "@/core/pipeline";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/config/skills/[id]/export
 * Returns a .md file in Claude Skill format:
 *   ---
 *   name: skill-id
 *   description: ...
 *   ---
 *
 *   # Name
 *
 *   {content}
 */
async function getHandler(ctx: PipelineContext) {
  const routeCtx = ctx.routeParams as RouteContext;
  const { id } = await routeCtx.params;

  const skill = await getSkill(id);
  if (!skill) {
    return new Response("Not found", { status: 404 });
  }

  // Skills v2: Agent Skills zip (SKILL.md + bundled files) or relay zip.
  const format = new URL(ctx.request.url).searchParams.get("format");
  if (format === "zip") {
    return zipResponse(await exportSkillZip(skill), `${toAgentName(skill.id)}.zip`);
  }
  if (format === "relay") {
    return zipResponse(exportRelayZip(skill), `${toAgentName(skill.id)}-relay.zip`);
  }

  // Prefer inline content; for remote skills use the last cached copy.
  const body =
    skill.content || (skill.source.type === "remote" ? skill.source.cachedContent || "" : "");

  const safeName = skill.id;
  const safeDesc = (skill.description || skill.name).replace(/\n/g, " ").trim();

  const frontmatterLines: string[] = ["---", `name: ${safeName}`, `description: ${safeDesc}`];
  if (skill.toolsAllowed && skill.toolsAllowed.length > 0) {
    frontmatterLines.push("tools_allowed:");
    for (const t of skill.toolsAllowed) {
      frontmatterLines.push(`  - ${t}`);
    }
  }
  frontmatterLines.push("---", "");
  const md = `${frontmatterLines.join("\n")}\n# ${skill.name}\n\n${body}\n`;

  return new Response(md, {
    status: 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${safeName}.md"`,
    },
  });
}

export const GET = withAdminAuth(getHandler);
