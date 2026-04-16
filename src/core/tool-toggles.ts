/**
 * Per-tool enable/disable toggles via KV.
 *
 * Tools are enabled by default. Disabled tools have KV key
 * `tool:disabled:<toolName>` set to `"true"`. The transport
 * route checks this before registering each tool on the MCP server.
 *
 * Connector-level disable overrides: if a connector is disabled,
 * its tools are off regardless of per-tool toggle.
 */

import { getKVStore } from "./kv-store";
import { emit, on } from "./events";

const KEY_PREFIX = "tool:disabled:";

// MEDIUM-4: Cache disabled tools in memory with 5s TTL.
// Avoids scanning all KV keys on every request.
let cachedDisabledTools: { at: number; value: Set<string> } | null = null;
const DISABLED_TOOLS_TTL_MS = 5_000;

// Invalidate cache on env.changed (covers setToolDisabled and other mutations)
on("env.changed", () => {
  cachedDisabledTools = null;
});

/** Check if a specific tool is disabled via KV. */
export async function isToolDisabled(toolName: string): Promise<boolean> {
  const kv = getKVStore();
  const val = await kv.get(`${KEY_PREFIX}${toolName}`);
  return val === "true";
}

/** Set or clear the disabled flag for a tool. Emits env.changed to invalidate registry. */
export async function setToolDisabled(toolName: string, disabled: boolean): Promise<void> {
  const kv = getKVStore();
  if (disabled) {
    await kv.set(`${KEY_PREFIX}${toolName}`, "true");
  } else {
    await kv.delete(`${KEY_PREFIX}${toolName}`);
  }
  emit("env.changed");
}

/** Test-only: reset the disabled tools cache. */
export function __resetDisabledToolsCacheForTests(): void {
  cachedDisabledTools = null;
}

/** Get all disabled tool names. Cached with 5s TTL. */
export async function getDisabledTools(): Promise<Set<string>> {
  const now = Date.now();
  if (cachedDisabledTools && now - cachedDisabledTools.at < DISABLED_TOOLS_TTL_MS) {
    return cachedDisabledTools.value;
  }

  const kv = getKVStore();
  const keys = await kv.list(KEY_PREFIX);
  const disabled = new Set<string>();
  for (const key of keys) {
    const toolName = key.slice(KEY_PREFIX.length);
    disabled.add(toolName);
  }
  cachedDisabledTools = { at: now, value: disabled };
  return disabled;
}
