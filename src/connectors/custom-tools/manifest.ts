import { z } from "zod";
import type { ConnectorManifest, ToolDefinition, ToolResult } from "@/core/types";
import { listCustomToolsSync, primeCustomToolsCache } from "./store";
import { runCustomTool } from "./runner";
import type { CustomTool, CustomToolInput } from "./types";
import { toMsg } from "@/core/error-utils";

/**
 * Custom Tools connector — always-on. Tools array is computed fresh on
 * every access so tools added through the dashboard appear without a
 * process restart, mirroring skills + api-connections.
 *
 * `core: false` keeps the connector visible in `/config → Connectors`
 * (operators want to see "you have N composed tools" and toggle it like
 * any other), and `requiredEnvVars: []` means no credentials are needed
 * — the runner reuses whatever the underlying step tools require.
 */

function buildSchema(tool: CustomTool): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const input of tool.inputs) {
    let field: z.ZodTypeAny;
    switch (input.type) {
      case "number":
        field = z.number();
        break;
      case "boolean":
        field = z.boolean();
        break;
      case "enum":
        field = z.enum(input.values as [string, ...string[]]);
        break;
      case "string":
      default:
        field = z.string();
        break;
    }
    field = field.describe(input.description || input.name);
    if (!input.required) field = field.optional();
    shape[input.name] = field;
  }
  return shape;
}

export function buildCustomToolDefinition(tool: CustomTool): ToolDefinition {
  return {
    name: tool.id,
    description: tool.description || `Custom Tool — ${tool.id}`,
    destructive: tool.destructive,
    schema: buildSchema(tool),
    handler: async (params): Promise<ToolResult> => {
      try {
        const result = await runCustomTool(tool, params ?? {});
        if (!result.ok) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `[custom-tool-error] ${result.error ?? "unknown error"}`,
              },
            ],
          };
        }
        return {
          content: [{ type: "text", text: result.result }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `[custom-tool-crash] ${toMsg(err)}`,
            },
          ],
        };
      }
    },
  };
}

export const customToolsConnector: ConnectorManifest = {
  id: "custom-tools",
  label: "Custom Tools",
  core: false,
  description:
    "User-defined tools composed from existing Kebab MCP tools via a declarative JSON spec. Build them in /config → Custom Tools.",
  requiredEnvVars: [],
  get tools(): ToolDefinition[] {
    try {
      return listCustomToolsSync().map((t) => buildCustomToolDefinition(t));
    } catch {
      return [];
    }
  },
  refresh: async () => {
    await primeCustomToolsCache();
  },
  diagnose: async () => {
    try {
      await primeCustomToolsCache();
      const tools = listCustomToolsSync();
      return {
        ok: true,
        message:
          tools.length === 0
            ? "Custom Tools pack active — 0 tools defined yet"
            : `Custom Tools pack active — ${tools.length} tool(s)`,
      };
    } catch (err) {
      return { ok: false, message: toMsg(err) };
    }
  },
};

// Re-export the input type so the dashboard tab can typecheck without
// reaching into types.ts itself.
export type { CustomToolInput };
