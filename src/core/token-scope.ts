/**
 * v0.20 — Per-token connector scoping.
 *
 * A token may carry an optional connector allowlist on its device KV entry
 * (`devices:<tokenId>.connectors`, see src/core/devices.ts). This module
 * resolves that allowlist into a filter applied when building `tools/list`
 * and again at tool invocation.
 *
 * Semantics (opt-in, fail-open):
 *   - No caller token (loopback / dev without MCP_AUTH_TOKEN) → no filter.
 *   - No allowlist stored (absent field / missing / corrupt entry) → no filter.
 *   - Allowlist present → strict: only those connectors, PLUS core connectors
 *     (admin, skills) which are framework primitives always exposed. An empty
 *     allowlist therefore resolves to "core connectors only".
 *
 * `null` from resolveTokenConnectorScope means "no filter" (full access) —
 * distinct from an empty Set, which means "block everything except core".
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { getDeviceConnectors, getDeviceSkillTags } from "./devices";
import { CORE_CONNECTOR_IDS } from "./registry";

/**
 * Resolve the connector scope for a caller token.
 *
 * @param callerTokenId the 8-hex tokenId from the auth step, or null/undefined
 *   when no MCP token is configured (loopback/dev).
 * @returns a Set of allowed connector ids (allowlist ∪ core), or `null` when
 *   no filter applies (full access).
 */
export async function resolveTokenConnectorScope(
  callerTokenId: string | null | undefined
): Promise<Set<string> | null> {
  if (!callerTokenId) return null;
  const allowlist = await getDeviceConnectors(callerTokenId);
  if (allowlist === null) return null;
  return new Set([...allowlist, ...CORE_CONNECTOR_IDS]);
}

/**
 * Whether a connector is allowed under a resolved scope. A `null` scope
 * (no filter) allows everything.
 */
export function isConnectorAllowed(scope: Set<string> | null, connectorId: string): boolean {
  if (scope === null) return true;
  return scope.has(connectorId);
}

// ── Skills v2: per-token skill tag scope ───────────────────────────────

/**
 * Resolve the caller token's skill tag scope. `null` = every skill (no
 * token id, no device entry, or no `skillTags` on it). Never throws.
 */
export async function resolveTokenSkillScope(
  callerTokenId: string | null | undefined
): Promise<string[] | null> {
  if (!callerTokenId) return null;
  try {
    return await getDeviceSkillTags(callerTokenId);
  } catch {
    return null;
  }
}

const skillScopeStore = new AsyncLocalStorage<{ tags: string[] | null }>();

/** Run `fn` with a skill tag scope ambient for the whole MCP request. */
export function runWithSkillScope<T>(tags: string[] | null, fn: () => T): T {
  return skillScopeStore.run({ tags }, fn);
}

/** Current request's skill tag scope (`null` = all skills / no request scope). */
export function getCurrentSkillScope(): string[] | null {
  return skillScopeStore.getStore()?.tags ?? null;
}

/** A skill is visible when no scope applies, or it shares at least one tag with it. */
export function isSkillVisible(skillTags: readonly string[], scope: string[] | null): boolean {
  if (scope === null) return true;
  return skillTags.some((t) => scope.includes(t));
}
