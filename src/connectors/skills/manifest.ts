import { z } from "zod";
import type { ConnectorManifest, ToolDefinition, ToolResult } from "@/core/types";
import { listSkillsSync, getSkill, primeSkillsCache, type Skill } from "./store";
import { renderSkill } from "./lib/render";
import { maybeRefreshRemote } from "./lib/remote-fetcher";
import { toMsg } from "@/core/error-utils";
import { getCurrentSkillScope, isSkillVisible } from "@/core/token-scope";
import {
  buildSkillsInstructions,
  skillsListPayload,
  skillLoadText,
  skillReadFile,
  skillResourceProvider,
} from "./lib/library";

/** Ids whose legacy tool name would collide with a library tool. */
export const RESERVED_SKILL_IDS = new Set(["load", "read_file"]);

function json(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

/**
 * Spec v2 §5 — the three library tools, always registered (even with 0
 * skills, so a client can discover the library exists).
 */
function libraryTools(): ToolDefinition[] {
  return [
    {
      name: "skills_list",
      description:
        "List the user's personal skills (reusable instructions/playbooks stored in Kebab). " +
        "Returns {count, skills:[{name, title, description, tags, files, arguments}]}. Optional query / tag filters. " +
        "Then call skill_load with a name to get the full instructions.",
      destructive: false,
      schema: {
        query: z
          .string()
          .max(200)
          .optional()
          .describe("Words to match in name/description (accents ignored)."),
        tag: z.string().max(40).optional().describe("Only skills with this tag."),
      },
      handler: async (params): Promise<ToolResult> =>
        json(await skillsListPayload((params ?? {}) as { query?: string; tag?: string })),
    },
    {
      name: "skill_load",
      description:
        "Load the full instructions of one of the user's skills (from skills_list or the server instructions) and follow them. " +
        "Pass `arguments` when the skill declares some. The result lists bundled files readable with skill_read_file.",
      destructive: false,
      schema: {
        name: z.string().min(1).max(100).describe("Skill name, e.g. 'meeting-prep'."),
        arguments: z
          .record(z.string(), z.string())
          .optional()
          .describe("Values for the skill's declared arguments, if any."),
      },
      handler: async (params): Promise<ToolResult> => {
        const r = await skillLoadText(
          params as { name: string; arguments?: Record<string, string> }
        );
        return r.ok ? { content: [{ type: "text", text: r.text }] } : json(r.payload);
      },
    },
    {
      name: "skill_read_file",
      description:
        "Read one bundled file of a skill (script, reference doc, template) listed by skill_load. Returns the raw text.",
      destructive: false,
      schema: {
        name: z.string().min(1).max(100).describe("Skill name."),
        path: z
          .string()
          .min(1)
          .max(200)
          .describe("File path as listed by skill_load, e.g. 'references/style.md'."),
      },
      handler: async (params): Promise<ToolResult> => {
        const r = await skillReadFile(params as { name: string; path: string });
        return r.ok ? { content: [{ type: "text", text: r.text }] } : json(r.payload);
      },
    },
  ];
}

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
      // Always re-read the latest skill (tenant-scoped store) and re-check the
      // caller's tag scope on the fresh copy: the listing came from a cache
      // that may be up to 30 s old. Never fall back to the cached object —
      // that could hand out content the store no longer grants.
      const latest = await getSkill(skill.id);
      if (!latest || !isSkillVisible(latest.tags ?? [], getCurrentSkillScope())) {
        return json({ error: "skill_not_found", name: skill.id });
      }

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
    "Your personal skills library (Agent Skills / SKILL.md format) shared by every AI client: skills_list, skill_load, skill_read_file, MCP prompts and skill:// resources. Always on — manage skills in /config → Skills.",
  requiredEnvVars: [],
  get tools(): ToolDefinition[] {
    // Legacy per-skill tools only for skills that opted in (all pre-v2
    // skills default to exposeAsTool=true) and are inside the caller's
    // tag scope. Evaluated per request inside the MCP transport.
    let legacy: ToolDefinition[];
    try {
      const scope = getCurrentSkillScope();
      legacy = listSkillsSync()
        .filter((s) => s.exposeAsTool !== false && isSkillVisible(s.tags ?? [], scope))
        // A legacy `skill_<id>` named like a library tool (ids `load`,
        // `read_file`) would make server.tool() throw for every request.
        .filter((s) => !RESERVED_SKILL_IDS.has(s.id))
        .map((s) => buildSkillTool(s));
    } catch {
      legacy = [];
    }
    return [...libraryTools(), ...legacy];
  },
  resources: skillResourceProvider,
  instructions: () => buildSkillsInstructions(getCurrentSkillScope()),
  // Prime the KV-backed sync cache so `tools` returns fresh data on the
  // first cold-lambda request (critical for Upstash where the sync file
  // path does not exist).
  refresh: async () => {
    await primeSkillsCache();
  },
  diagnose: async () => {
    try {
      // Defensive: prime once more so admin/status/verify see fresh counts
      // on a brand-new cold lambda even before transport refresh has run.
      await primeSkillsCache();
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
      const scope = getCurrentSkillScope();
      const skills = listSkillsSync().filter((s) => isSkillVisible(s.tags ?? [], scope));
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
            const latest = await getSkill(skill.id);
            if (!latest || !isSkillVisible(latest.tags ?? [], getCurrentSkillScope())) {
              return {
                messages: [
                  {
                    role: "user" as const,
                    content: {
                      type: "text" as const,
                      text: `Skill "${skill.id}" is not available.`,
                    },
                  },
                ],
              };
            }
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
