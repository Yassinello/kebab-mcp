import { z } from "zod";
import type { ConnectorManifest, ToolDefinition, ToolResult } from "@/core/types";
import { listApiToolsSync, getApiConnection, primeApiToolsCache, type ApiTool } from "./store";
import { invokeApiTool } from "./lib/invoke";
import { toMsg } from "@/core/error-utils";

/**
 * Build a Zod input schema shape from the tool's declared arguments.
 */
function buildSchema(tool: ApiTool): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const arg of tool.arguments) {
    let field: z.ZodTypeAny;
    switch (arg.type) {
      case "number":
        field = z.number();
        break;
      case "boolean":
        field = z.boolean();
        break;
      case "string":
      default:
        field = z.string();
        break;
    }
    field = field.describe(arg.description || arg.name);
    if (!arg.required) field = field.optional();
    shape[arg.name] = field;
  }
  return shape;
}

/** Build a ToolDefinition for a single custom API tool. */
export function buildApiToolDefinition(tool: ApiTool): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description || `Custom API tool — ${tool.name}`,
    destructive: tool.destructive,
    schema: buildSchema(tool),
    ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
    handler: async (params): Promise<ToolResult> => {
      const connection = await getApiConnection(tool.connectionId);
      if (!connection) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `[api-connection-missing] Tool "${tool.name}" references a deleted connection (${tool.connectionId}).`,
            },
          ],
        };
      }
      try {
        const result = await invokeApiTool(connection, tool, params ?? {});
        const header = `HTTP ${result.status}${result.ok ? " OK" : ""} ${result.url}`;
        const truncatedTag = result.truncated ? "\n[truncated — response exceeded 512 KB cap]" : "";

        // Attach structuredContent when outputSchema is declared and body is
        // parseable JSON. Fallback is silent — no log, no escalation.
        let structuredContent: Record<string, unknown> | undefined;
        if (tool.outputSchema && !result.truncated) {
          try {
            const parsed = JSON.parse(result.body);
            // MCP SDK requires structuredContent to be a plain object
            if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
              structuredContent = parsed as Record<string, unknown>;
            }
          } catch {
            // Non-JSON body — silently skip structuredContent
          }
        }

        const toolResult: ToolResult = {
          isError: !result.ok,
          content: [
            {
              type: "text",
              text: `${header}\n\n${result.body}${truncatedTag}`,
            },
          ],
        };
        if (structuredContent !== undefined) {
          toolResult.structuredContent = structuredContent;
        }
        return toolResult;
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `[api-tool-error] ${toMsg(err)}`,
            },
          ],
        };
      }
    },
  };
}

/**
 * API Connections pack — always-on. Tools array is computed fresh on
 * every access so newly-authored custom tools appear without a process
 * restart (mirrors the skills connector's approach).
 */
export const apiConnectionsConnector: ConnectorManifest = {
  id: "api-connections",
  label: "API Connections",
  core: false,
  description:
    "User-defined HTTP API integrations and their custom tools. Configure connections and build tools in /config → Connectors / Tools.",
  requiredEnvVars: [],
  get tools(): ToolDefinition[] {
    try {
      const tools = listApiToolsSync();
      return tools.map((t) => buildApiToolDefinition(t));
    } catch {
      return [];
    }
  },
  // Prime the KV-backed sync cache so `tools` returns fresh data on the
  // first cold-lambda request (before any diagnose/status route fires).
  refresh: async () => {
    await primeApiToolsCache();
  },
  diagnose: async () => {
    try {
      // Defensive: also prime here so operators hitting /api/admin/status
      // on a brand-new cold lambda see accurate counts even if the transport
      // refresh hasn't run yet.
      await primeApiToolsCache();
      const tools = listApiToolsSync();
      return {
        ok: true,
        message:
          tools.length === 0
            ? "API Connections pack active — 0 custom tools defined yet"
            : `API Connections pack active — ${tools.length} custom tool(s)`,
      };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : "API Connections store unreadable",
      };
    }
  },
};
