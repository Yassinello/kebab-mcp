import { checkAdminAuth } from "@/core/auth";
import { getSkill } from "@/connectors/skills/store";
import { withBootstrapRehydrate } from "@/core/with-bootstrap-rehydrate";

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
async function getHandler(request: Request, ctx: RouteContext) {
  const authError = await checkAdminAuth(request);
  if (authError) return authError;
  const { id } = await ctx.params;

  const skill = await getSkill(id);
  if (!skill) {
    return new Response("Not found", { status: 404 });
  }

  // Prefer inline content; for remote skills use the last cached copy.
  const body =
    skill.content || (skill.source.type === "remote" ? skill.source.cachedContent || "" : "");

  const safeName = skill.id;
  const safeDesc = (skill.description || skill.name).replace(/\n/g, " ").trim();
  const md =
    `---\n` +
    `name: ${safeName}\n` +
    `description: ${safeDesc}\n` +
    `---\n\n` +
    `# ${skill.name}\n\n` +
    `${body}\n`;

  return new Response(md, {
    status: 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${safeName}.md"`,
    },
  });
}

export const GET = withBootstrapRehydrate(getHandler);
