/**
 * TRU-01 — MCP tool annotations derived from the connector manifest.
 *
 * Every tool is registered with `registerTool(name, { title, annotations })`.
 * The values come from the `ToolDefinition` itself, so the dashboard, the
 * contract snapshot and `tools/list` all agree:
 *
 *  - `title`           → `tool.title`, else derived from the name
 *                        ("vault_read" → "Vault read").
 *  - `readOnlyHint`    → `!tool.destructive`
 *  - `destructiveHint` → `tool.destructive`
 *  - `openWorldHint`   → `tool.openWorld`, else the connector default below.
 *
 * Connector default for `openWorldHint`: `false` for connectors whose domain
 * is closed — framework-core connectors (`core: true`: admin, context,
 * skills) plus the user's own vault — and `true` for everything else:
 * third-party APIs, the web, custom API connections, the webhook inbox
 * (payloads are pushed by third parties) and Custom Tools (which can chain
 * any tool). A tool overrides its connector default with `openWorld` (e.g.
 * `save_article` fetches an arbitrary URL, so it is open-world inside the
 * vault connector).
 */
import type { ConnectorManifest, ToolDefinition } from "./types";

/** Non-core connectors whose tools act on a closed, user-owned domain. */
const CLOSED_WORLD_CONNECTORS: ReadonlySet<string> = new Set(["vault"]);

/** MCP `ToolAnnotations` subset Kebab publishes for every tool. */
export interface KebabToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  openWorldHint: boolean;
}

/** "vault_read" → "Vault read"; "my_context_update" → "My context update". */
export function deriveToolTitle(name: string): string {
  const words = name
    .split(/[_\s]+/)
    .filter(Boolean)
    .join(" ");
  if (!words) return name;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The display title of a tool (explicit `title`, else derived from the name). */
export function toolTitle(tool: Pick<ToolDefinition, "name" | "title">): string {
  return tool.title?.trim() || deriveToolTitle(tool.name);
}

/** Default `openWorldHint` for a connector's tools. */
export function connectorOpenWorldDefault(
  manifest: Pick<ConnectorManifest, "id" | "core">
): boolean {
  return !(manifest.core === true || CLOSED_WORLD_CONNECTORS.has(manifest.id));
}

/** Resolved MCP annotations for one tool of one connector. */
export function toolAnnotations(
  tool: Pick<ToolDefinition, "name" | "title" | "destructive" | "openWorld">,
  manifest: Pick<ConnectorManifest, "id" | "core">
): KebabToolAnnotations {
  return {
    title: toolTitle(tool),
    readOnlyHint: !tool.destructive,
    destructiveHint: tool.destructive,
    openWorldHint: tool.openWorld ?? connectorOpenWorldDefault(manifest),
  };
}
