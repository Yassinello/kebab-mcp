import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { withLogging } from "@/core/logging";
import { checkMcpAuth } from "@/core/auth";
import { getEnabledPacks, logRegistryState } from "@/core/registry";
import { listSkillsSync, getSkill } from "@/packs/skills/store";
import { renderSkill } from "@/packs/skills/lib/render";
import { maybeRefreshRemote } from "@/packs/skills/lib/remote-fetcher";

/**
 * Build a fresh MCP handler that reflects the current registry state.
 * Called per-request so that hot-env edits (via /api/config/env) are
 * picked up without needing a restart.
 *
 * Cost: a few ms to re-scan process.env + rebuild the tool list.
 */
function buildHandler() {
  return createMcpHandler(
    (server) => {
      const enabledPacks = getEnabledPacks();
      logRegistryState();

      for (const pack of enabledPacks) {
        for (const tool of pack.manifest.tools) {
          const desc = tool.deprecated
            ? `[DEPRECATED: ${tool.deprecated}] ${tool.description}`
            : tool.description;
          server.tool(
            tool.name,
            desc,
            tool.schema,
            withLogging(tool.name, async (params) => tool.handler(params))
          );
        }
      }

      // ── Skills → MCP prompts ──────────────────────────────────────────
      // Each skill also registers as an MCP prompt so Claude Desktop can
      // surface them as slash commands. The tool surface (skill_<id>)
      // remains the universal fallback and works regardless.
      try {
        const skills = listSkillsSync();
        for (const skill of skills) {
          const argsSchema: Record<string, z.ZodType<string>> = {};
          for (const arg of skill.arguments) {
            argsSchema[arg.name] = arg.required
              ? z.string().describe(arg.description || arg.name)
              : (z
                  .string()
                  .optional()
                  .describe(arg.description || arg.name) as unknown as z.ZodType<string>);
          }

          try {
            server.prompt(
              skill.id,
              skill.description || skill.name,
              argsSchema,
              async (args: Record<string, string | undefined>) => {
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
              }
            );
          } catch (err) {
            console.info(
              `[MyMCP] Skipping prompt registration for skill "${skill.id}": ${
                err instanceof Error ? err.message : String(err)
              }`
            );
          }
        }
      } catch (err) {
        console.info(
          `[MyMCP] Skills prompt registration unavailable: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    },
    {
      serverInfo: {
        name: "MyMCP",
        version: "0.2.0",
      },
    },
    {
      basePath: "/api",
      maxDuration: 60,
    }
  );
}

async function handler(request: Request): Promise<Response> {
  const authError = checkMcpAuth(request);
  if (authError) return authError;
  const mcpHandler = buildHandler();
  return mcpHandler(request);
}

export { handler as GET, handler as POST, handler as DELETE };
