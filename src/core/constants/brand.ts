/**
 * Phase 50 / BRAND-01..04 — Centralized brand strings.
 *
 * Single source of truth for the MyMCP → Kebab rename (T25, v1.0 blocker).
 * All new code references `BRAND.envPrefix` / `BRAND.cookieName` /
 * `BRAND.otelAttrPrefix` — NEVER hardcode.
 *
 * The `LEGACY_BRAND` object is retained for the 2-release transition
 * (v0.12 → v0.13 warning, v0.14 removal). Its sole consumers are:
 *   - src/core/config-facade.ts      — MYMCP_* env-var fallback
 *   - src/core/auth.ts               — mymcp_admin_token cookie read
 *   - src/core/tracing.ts            — mymcp.* OTel attr legacy emission
 *   - src/core/migrations/*.ts       — prior-version migration shims
 *
 * The `tests/contract/no-stray-mymcp.test.ts` contract test prevents
 * new "mymcp" literals from appearing in src/ + app/ outside these
 * allowlisted paths.
 */

/**
 * Current (Phase 50+) brand identifiers. Use throughout new code.
 */
export const BRAND = {
  /** Env-var prefix for Kebab-specific configuration (e.g. KEBAB_TIMEZONE). */
  envPrefix: "KEBAB_",
  /** Admin dashboard cookie name. */
  cookieName: "kebab_admin_token",
  /** OpenTelemetry span attribute namespace prefix (e.g. kebab.tool.name). */
  otelAttrPrefix: "kebab",
  /**
   * Technical product name. Kept as "Kebab MCP" for continuity with the
   * repository name and the `[Kebab MCP]` log prefixes. User-facing UI
   * uses `PRODUCT.name` instead.
   */
  displayName: "Kebab MCP",
} as const;

/**
 * Kebab House (ADR 0004, spec phase 0 BRD-01..04) — user-facing product
 * identity. Use for anything a person reads: dashboard and welcome
 * chrome, landing copy, page metadata, MCP `serverInfo.name`.
 *
 * NOT for technical identifiers. The repository (`kebab-mcp`), env vars
 * (`KEBAB_*` / `MYMCP_*`), KV keys, cookie and header names and log
 * prefixes (`[Kebab MCP]`) keep their names — see `BRAND` above.
 */
export const PRODUCT = {
  /** Display name shown in the UI and announced to MCP clients. */
  name: "Kebab House",
  /** One-line promise, used in the README, landing and metadata. */
  tagline: "Create your personal AI brain with all the ingredients, and eat it everywhere.",
} as const;

/**
 * Legacy (MyMCP) brand identifiers. Retained for the 2-release transition:
 *  - v0.12: current release — MYMCP_* accepted, one boot warning per var
 *  - v0.13: MYMCP_* still accepted, warnings upgraded to error-severity
 *  - v0.14: support removed; MYMCP_* reads fall through to undefined
 *
 * Contract test `no-stray-mymcp` prevents re-introduction of the prefix
 * in new code outside the allowlisted migration paths.
 */
export const LEGACY_BRAND = {
  envPrefix: "MYMCP_",
  cookieName: "mymcp_admin_token",
  otelAttrPrefix: "mymcp",
} as const;

/**
 * Build the single-line deprecation message logged at most once per
 * variable per process. The format is grep-friendly:
 *
 *   [deprecated] MYMCP_TIMEZONE is deprecated; use KEBAB_TIMEZONE. Support removed in 2 releases.
 */
export function deprecationMsg(legacyKey: string, modernKey: string): string {
  return `[deprecated] ${legacyKey} is deprecated; use ${modernKey}. Support removed in 2 releases.`;
}
