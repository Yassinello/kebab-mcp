import { defineTool, type ConnectorManifest } from "@/core/types";
import { mcpLogsSchema, handleMcpLogs } from "./tools/mcp-logs";
import { cacheEvictSchema, handleCacheEvict } from "./tools/cache-evict";
import { backupExportSchema, handleBackupExport } from "./tools/backup-export";
import { backupImportSchema, handleBackupImport } from "./tools/backup-import";
import { streamTestSchema, handleStreamTest } from "./tools/stream-test";
import { getConfig } from "@/core/config-facade";

const baseTools = [
  // PILOT: defineTool() migration (v0.5 phase 12, T1).
  // The generic parameter is inferred from `schema` so `args` is fully
  // typed — no `params as { ... }` cast needed. Handler receives the
  // narrow type, not `Record<string, unknown>`.
  defineTool({
    name: "mcp_logs",
    description:
      "View recent MCP tool call logs. Shows tool name, duration, status, and errors. Useful for debugging failed calls. Logs are in-memory and ephemeral (reset on cold start).",
    schema: mcpLogsSchema,
    handler: async (args) => handleMcpLogs(args),
    destructive: false,
  }),
  defineTool({
    name: "mcp_cache_evict",
    description:
      "Clear server-side caches. Scope: registry (connector resolution cache), kv (KV store read cache), logs (in-memory log buffer), or all. Useful after manual env changes or to free memory.",
    schema: cacheEvictSchema,
    handler: async (args) => handleCacheEvict(args),
    destructive: true,
  }),
];

// SEC-01 (2026-11 audit): backup export/import are NOT exposed over MCP by
// default. Any MCP token (and any prompt-injected LLM holding one) could
// otherwise dump or rewrite the whole KV namespace. Operators who want them
// opt in with KEBAB_MCP_BACKUP_TOOLS=1; even then secrets are redacted
// (see SEC-02 in src/core/backup.ts). The operator CLI (scripts/backup.ts)
// remains the supported full-backup path.
if (getConfig("KEBAB_MCP_BACKUP_TOOLS") === "1") {
  baseTools.push(
    defineTool({
      name: "mcp_backup_export",
      description:
        "Export all KV store data as a JSON backup. Returns version, timestamp, and all key-value entries. Secret-bearing keys (connector credentials, bootstrap/signing material, API connection auth) are always excluded.",
      schema: backupExportSchema,
      handler: async () => handleBackupExport(),
      destructive: false,
    }),
    defineTool({
      name: "mcp_backup_import",
      description:
        "Import a JSON backup into the KV store. Accepts the same format produced by mcp_backup_export. Validates version before writing. Credential and authorization keys (cred:*, devices:*, first-run material) are never written.",
      schema: backupImportSchema,
      handler: async (args) => handleBackupImport(args),
      destructive: true,
    })
  );
}

// MEDIUM-5: Only include the stream-test diagnostic tool outside production.
if (getConfig("NODE_ENV") !== "production") {
  baseTools.push(
    defineTool({
      name: "admin_stream_test",
      description:
        "Diagnostic tool that streams chunks with configurable delays. Verifies the streaming tool result pipeline works end-to-end. Not available in production.",
      schema: streamTestSchema,
      handler: async (args) => handleStreamTest(args),
      destructive: false,
    })
  );
}

export const adminConnector: ConnectorManifest = {
  id: "admin",
  label: "Admin & Observability",
  core: true,
  description: "Tool call logs, cache management, diagnostics",
  requiredEnvVars: [], // Always active — no credentials needed
  tools: baseTools,
};
