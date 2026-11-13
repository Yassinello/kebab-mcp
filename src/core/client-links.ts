/**
 * Kebab House phase 1 (ONB-01) — one-click install links for AI clients.
 * Pure functions (no I/O) so the dashboard, /welcome and tests share them.
 */

import { PRODUCT } from "./constants/brand";

/** claude.ai / Claude Desktop: prefilled "Add custom connector" dialog. */
export function claudeAddConnectorUrl(mcpUrl: string, name: string = PRODUCT.name): string {
  const q = new URLSearchParams({
    modal: "add-custom-connector",
    connectorName: name,
    connectorUrl: mcpUrl,
  });
  return `https://claude.ai/customize/connectors?${q.toString()}`;
}

/** Cursor: MCP install deeplink (config is base64 JSON). OAuth happens in Cursor. */
export function cursorInstallUrl(mcpUrl: string, name = "kebab-house"): string {
  // btoa: available in browsers and Node 16+ (this module runs in client components).
  const config = btoa(JSON.stringify({ url: mcpUrl }));
  const q = new URLSearchParams({ name, config });
  return `cursor://anysphere.cursor-deeplink/mcp/install?${q.toString()}`;
}

/** Claude Code: OAuth is negotiated by the CLI on first use. */
export function claudeCodeAddCommand(mcpUrl: string): string {
  return `claude mcp add --transport http kebab-house ${mcpUrl}`;
}

/** The sentence users type in their client to start the guided setup. */
export const SETUP_PHRASE = "Set up my Kebab House";
