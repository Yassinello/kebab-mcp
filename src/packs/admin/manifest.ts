import type { PackManifest } from "@/core/types";
import { mcpLogsSchema, handleMcpLogs } from "./tools/mcp-logs";

export const adminPack: PackManifest = {
  id: "admin",
  label: "Admin & Observability",
  description: "Tool call logs, diagnostics",
  requiredEnvVars: [], // Always active — no credentials needed
  tools: [
    {
      name: "mcp_logs",
      description:
        "View recent MCP tool call logs. Shows tool name, duration, status, and errors. Useful for debugging failed calls. Logs are in-memory and ephemeral (reset on cold start).",
      schema: mcpLogsSchema,
      handler: async (params) =>
        handleMcpLogs(params as { count?: number; filter?: "all" | "errors" | "success" }),
    },
  ],
};
