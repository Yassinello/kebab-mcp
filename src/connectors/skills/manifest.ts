import { z } from "zod";
import type { ConnectorManifest, ToolDefinition, ToolResult } from "@/core/types";
import { listSkillsSync, getSkill, type Skill } from "./store";
import { renderSkill } from "./lib/render";
import { maybeRefreshRemote } from "./lib/remote-fetcher";
import { toMsg } from "@/core/error-utils";

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
    // User-authored skills are rendered prompts, not write operations.
    // Individual skills that invoke tools internally still get confirmation
    // from those underlying tools' destructive flags.
    destructive: false,
    schema: buildSchema(skill),
    handler: async (params): Promise<ToolResult> => {
      // Always re-read the latest skill from disk to pick up edits.
      const latest = (await getSkill(skill.id)) ?? skill;

      // For remote skills, lazy-refresh if TTL expired (fire-and-forget).
      // Returns the (possibly stale) current state immediately.
      const ready = await maybeRefreshRemote(latest);
      const rendered = renderSkill(ready, params ?? {});

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
export const skillsConnector: ConnectorManifest = {
  id: "skills",
  label: "Skills",
  core: true,
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
  /**
   * Register user-authored skills as MCP prompts so Claude Desktop can
   * surface them as slash commands. The tool surface (`skill_<id>`)
   * remains the universal fallback for clients that don't support MCP
   * prompts — adding a skill always exposes both surfaces.
   *
   * Framework note: this is the ConnectorManifest.registerPrompts hook.
   * The transport calls it for every enabled connector, so the transport
   * itself has zero knowledge of skills-specific wiring.
   */
  registerPrompts: (serverUnknown) => {
    // mcp-handler's server type isn't exported cleanly, so we narrow via
    // a local shape that matches what we actually call. This keeps the
    // core ConnectorManifest type independent of mcp-handler internals.
    const server = serverUnknown as {
      prompt: (
        name: string,
        description: string,
        args: Record<string, z.ZodTypeAny>,
        handler: (
          args: Record<string, string | undefined>
        ) => Promise<{ messages: { role: "user"; content: { type: "text"; text: string } }[] }>
      ) => void;
    };

    try {
      const skills = listSkillsSync();
      for (const skill of skills) {
        const argsSchema: Record<string, z.ZodTypeAny> = {};
        for (const arg of skill.arguments) {
          argsSchema[arg.name] = arg.required
            ? z.string().describe(arg.description || arg.name)
            : z
                .string()
                .optional()
                .describe(arg.description || arg.name);
        }

        try {
          server.prompt(skill.id, skill.description || skill.name, argsSchema, async (args) => {
            const latest = (await getSkill(skill.id)) ?? skill;
            const ready = await maybeRefreshRemote(latest);
            const text = renderSkill(ready, args as Record<string, unknown>);
            return {
              messages: [
                {
                  role: "user" as const,
                  content: { type: "text" as const, text },
                },
              ],
            };
          });
        } catch (err) {
          console.info(
            `[Kebab MCP] Skipping prompt registration for skill "${skill.id}": ${toMsg(err)}`
          );
        }
      }
    } catch (err) {
      console.info(`[Kebab MCP] Skills prompt registration unavailable: ${toMsg(err)}`);
    }
  },
};
