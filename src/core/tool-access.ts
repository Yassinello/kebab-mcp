/**
 * Audit 2026-11 (contract 1) — the access-level gate, shared by MCP
 * `tools/list` (hidden tools) and `tools/call` (refused tools), so listing
 * and calling can never disagree.
 *
 * A tool is allowed when:
 *   - it changes nothing (`destructive: false`), or
 *   - the device has access "full", or
 *   - the device has access "memory" and the tool only writes the user's own
 *     profile, notes or skills (`memoryWrite: true`).
 * Operator tools (`adminOnly: true`) need access "full", even when read-only.
 */
import type { AccessLevel } from "./devices";

/** Minimal tool shape the gate needs (a subset of ToolDefinition). */
export interface AccessGatedTool {
  destructive: boolean;
  memoryWrite?: boolean | undefined;
  adminOnly?: boolean | undefined;
}

export function isToolAllowedForAccess(tool: AccessGatedTool, access: AccessLevel): boolean {
  if (tool.adminOnly) return access === "full";
  if (!tool.destructive) return true;
  if (access === "full") return true;
  return access === "memory" && tool.memoryWrite === true;
}
