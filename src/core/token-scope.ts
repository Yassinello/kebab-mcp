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
 *   - Allowlist present → strict: only those connectors, PLUS the
 *     scope-exempt core connectors (`skills`). An empty allowlist therefore
 *     resolves to "skills only".
 *   - SEC-03 (2026-11 audit): `admin` is core (always loaded, hidden from the
 *     Connectors tab) but NOT scope-exempt — it exposes logs and cache
 *     controls, so a scoped token only gets it when listed explicitly.
 *
 * `null` from resolveTokenConnectorScope means "no filter" (full access) —
 * distinct from an empty Set, which means "block everything except core".
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { getDeviceAccess, getDeviceSkillTagsFrom } from "./devices";
import { getKVStore, getTenantKVStore } from "./kv-store";
import { getCurrentTenantId } from "./request-context";
import { CORE_CONNECTOR_IDS } from "./registry";

/**
 * SEC-03: core connectors that are NOT implicitly granted to a scoped token.
 */
const SCOPE_RESTRICTED_CORE_IDS: ReadonlySet<string> = new Set(["admin"]);

/** Core connectors every scoped token always receives (today: `skills`). */
export function getScopeExemptConnectorIds(): string[] {
  return CORE_CONNECTOR_IDS.filter((id) => !SCOPE_RESTRICTED_CORE_IDS.has(id));
}

/**
 * Tri-state access decision for a caller token (SEC-04 / SEC-06).
 * - `full`: no restriction.
 * - `scoped`: only `connectors` (allowlist ∪ scope-exempt core).
 * - `revoked`: the token was rotated/revoked — refuse the request.
 */
export type TokenAccess =
  | { kind: "full" }
  | { kind: "scoped"; connectors: Set<string> }
  | { kind: "revoked" };

function intersect(a: string[], b: string[]): string[] {
  const set = new Set(b);
  return a.filter((x) => set.has(x));
}

/**
 * Resolve the access level for a caller token.
 *
 * SEC-04 (2026-11 audit): a global `MCP_AUTH_TOKEN` is accepted for any
 * tenant-header value (root-operator design). Its device entry lives in
 * the ROOT namespace, so reading only the tenant namespace let a scoped
 * token drop its scope by sending an arbitrary tenant header. We now read
 * both the root and the current tenant namespace and keep the most
 * restrictive answer:
 *   revoked anywhere → revoked; otherwise the intersection of every
 *   allowlist present; no allowlist anywhere → full access.
 * A missing entry stays "no restriction" (documented contract; the KV-only
 * bootstrap token never has an entry). A corrupt entry is fail-closed.
 */
export async function resolveTokenAccess(
  callerTokenId: string | null | undefined
): Promise<TokenAccess> {
  if (!callerTokenId) return { kind: "full" };
  const tenantId = getCurrentTenantId();
  const namespaces = [getKVStore()];
  if (tenantId) namespaces.push(getTenantKVStore(tenantId));
  const results = await Promise.all(namespaces.map((kv) => getDeviceAccess(callerTokenId, kv)));
  if (results.includes("revoked")) return { kind: "revoked" };
  let allow: string[] | null = null;
  for (const r of results) {
    if (r === null || r === "revoked") continue;
    allow = allow === null ? r : intersect(allow, r);
  }
  if (allow === null) return { kind: "full" };
  return { kind: "scoped", connectors: new Set([...allow, ...getScopeExemptConnectorIds()]) };
}

/**
 * Resolve the connector scope for a caller token.
 *
 * @returns a Set of allowed connector ids (allowlist ∪ scope-exempt core),
 *   or `null` when no filter applies (full access). A revoked token
 *   resolves to an empty Set (nothing allowed) — callers that can refuse
 *   the whole request should prefer `resolveTokenAccess`.
 */
export async function resolveTokenConnectorScope(
  callerTokenId: string | null | undefined
): Promise<Set<string> | null> {
  const access = await resolveTokenAccess(callerTokenId);
  if (access.kind === "full") return null;
  if (access.kind === "revoked") return new Set();
  return access.connectors;
}

// ── Ambient tool-invocation scope (SEC-05) ────────────────────────────
//
// The MCP transport wraps every tool handler in `runWithToolAccess` so code
// that invokes OTHER tools on the caller's behalf (Custom Tools runner)
// can enforce the same connector scope + per-tool toggles as the
// transport itself.

export interface ToolAccessContext {
  /** `null` = full access. */
  connectorScope: Set<string> | null;
}

const toolAccessStorage = new AsyncLocalStorage<ToolAccessContext>();

export function runWithToolAccess<T>(ctx: ToolAccessContext, fn: () => T): T {
  return toolAccessStorage.run(ctx, fn);
}

/** The ambient tool-access context, or `undefined` outside an MCP tool call. */
export function getToolAccessContext(): ToolAccessContext | undefined {
  return toolAccessStorage.getStore();
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
    // SEC-04 (2026-11 audit): like the connector scope, read the root AND
    // the tenant namespace and keep the most restrictive answer, so an
    // arbitrary tenant header cannot shed a tag scope either.
    const tenantId = getCurrentTenantId();
    const namespaces = [getKVStore()];
    if (tenantId) namespaces.push(getTenantKVStore(tenantId));
    const results = await Promise.all(
      namespaces.map((kv) => getDeviceSkillTagsFrom(callerTokenId, kv))
    );
    let tags: string[] | null = null;
    for (const r of results) {
      if (r === null) continue;
      tags = tags === null ? r : intersect(tags, r);
    }
    return tags;
  } catch {
    // Fail CLOSED: a KV error must not turn a tag-limited token into a
    // full-library token. An empty scope shows no skill for this request.
    return [];
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
