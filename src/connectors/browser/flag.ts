/**
 * Phase 44 SCM-01: feature flag gating Stagehand v2-compat vs v3 dispatch.
 *
 * Environment:
 *   - KEBAB_BROWSER_CONNECTOR_V2 unset / "0" / "false"  → v2 (default, safe rollback)
 *   - KEBAB_BROWSER_CONNECTOR_V2 = "1" / "true"         → v3 (active Stagehand v3 idioms)
 *
 * Flag-name history note: the `_V2` token tracks the milestone ID
 * ("the V2-vs-V3 toggle"), not "=1 means V2". Per milestone roadmap
 * line 169-170: `KEBAB_BROWSER_CONNECTOR_V2=1 gates Stagehand v3 bump;
 * v2 path remains default`.
 *
 * See .planning/phases/44-supply-chain/MIGRATION-NOTES.md for the full
 * rationale and v3 surface analysis.
 */

export type BrowserConnectorVersion = "v2" | "v3";

export function getBrowserConnectorVersion(): BrowserConnectorVersion {
  const raw = process.env.KEBAB_BROWSER_CONNECTOR_V2;
  if (raw === "1" || raw === "true") return "v3";
  return "v2";
}
