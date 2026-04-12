import { z } from "zod";
import type { PackManifest, ToolDefinition, ToolResult } from "@/core/types";
import { listSkillsSync, getSkill, type Skill } from "./store";
import { renderSkill } from "./lib/render";
import { maybeRefreshRemote } from "./lib/remote-fetcher";

/**
 * Build a Zod input schema from a skill's declared arguments.
 */
function buildSchema(skill: Skill): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const arg of skill.arguments) {
    let field: z.ZodTypeAny = z.string().describe(arg.description || arg.name);
    if (!arg.required) field = field.optional();
    shape[arg.name] = field;
  }
  return shape;
}

/** Build a tool definition for a single skill. */
export function buildSkillTool(skill: Skill): ToolDefinition {
  const toolName = `skill_${skill.id}`;
  const desc =
    skill.description ||
    `User-defined skill: ${skill.name}. Returns a rendered prompt/instructions block.`;

  return {
    name: toolName,
    description: desc,
    schema: buildSchema(skill),
    handler: async (params): Promise<ToolResult> => {
      // Always re-read the latest skill from disk to pick up edits.
      const latest = (await getSkill(skill.id)) ?? skill;

      // For remote skills, lazy-refresh if TTL expired (fire-and-forget).
      // Returns the (possibly stale) current state immediately.
      const ready = await maybeRefreshRemote(latest);
      const rendered = renderSkill(ready, (params ?? {}) as Record<string, unknown>);

      return {
        content: [{ type: "text", text: rendered }],
      };
    },
  };
}

/**
 * Skills pack — always-on. Tools array is computed fresh on every access
 * so that newly-authored skills show up without a process restart.
 */
export const skillsPack: PackManifest = {
  id: "skills",
  label: "Skills",
  description:
    "User-defined skills (prompts + templates) exposed as MCP tools and prompts. Always on — define skills in /config → Skills.",
  requiredEnvVars: [],
  get tools(): ToolDefinition[] {
    try {
      const skills = listSkillsSync();
      return skills.map((s) => buildSkillTool(s));
    } catch {
      return [];
    }
  },
  diagnose: async () => {
    try {
      const skills = listSkillsSync();
      return {
        ok: true,
        message:
          skills.length === 0
            ? "Skills pack active — 0 skills defined yet"
            : `Skills pack active — ${skills.length} skill(s)`,
      };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : "Skills store unreadable",
      };
    }
  },
};
