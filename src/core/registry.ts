import type { PackManifest, PackState } from "./types";
import { getEnabledPacksOverride } from "./config";

// Import all pack manifests — static, deterministic, no auto-discovery
import { googlePack } from "@/packs/google/manifest";
import { vaultPack } from "@/packs/vault/manifest";
import { browserPack } from "@/packs/browser/manifest";
import { adminPack } from "@/packs/admin/manifest";
import { slackPack } from "@/packs/slack/manifest";
import { notionPack } from "@/packs/notion/manifest";
import { composioPack } from "@/packs/composio/manifest";
import { skillsPack } from "@/packs/skills/manifest";

const ALL_PACKS: PackManifest[] = [
  googlePack,
  vaultPack,
  browserPack,
  slackPack,
  notionPack,
  composioPack,
  skillsPack,
  adminPack,
];

/**
 * Resolve which packs are enabled based on env vars.
 *
 * Logic:
 * 1. If MYMCP_ENABLED_PACKS is set → only listed packs are considered
 * 2. If MYMCP_DISABLE_<PACK> is "true" → pack is force-disabled
 * 3. If all requiredEnvVars are present → pack is active
 * 4. Otherwise → pack is inactive with reason
 */
export function resolveRegistry(): PackState[] {
  const enabledOverride = getEnabledPacksOverride();

  return ALL_PACKS.map((pack) => {
    // Check explicit enable list (if set)
    if (enabledOverride && !enabledOverride.has(pack.id)) {
      return {
        manifest: pack,
        enabled: false,
        reason: `not listed in MYMCP_ENABLED_PACKS`,
      };
    }

    // Check force-disable
    const disableKey = `MYMCP_DISABLE_${pack.id.toUpperCase()}`;
    if (process.env[disableKey] === "true") {
      return {
        manifest: pack,
        enabled: false,
        reason: `disabled via ${disableKey}`,
      };
    }

    // Check required env vars
    const missing = pack.requiredEnvVars.filter((v) => !process.env[v]);
    if (missing.length > 0) {
      return {
        manifest: pack,
        enabled: false,
        reason: `missing env: ${missing.join(", ")}`,
      };
    }

    return { manifest: pack, enabled: true, reason: "active" };
  });
}

/** Get only the enabled packs */
export function getEnabledPacks(): PackState[] {
  return resolveRegistry().filter((p) => p.enabled);
}

/** Log registry state to console at startup */
export function logRegistryState(): void {
  const packs = resolveRegistry();
  const enabled = packs.filter((p) => p.enabled);
  const disabled = packs.filter((p) => !p.enabled);

  console.log(`[MyMCP] Registry: ${enabled.length}/${packs.length} packs active`);
  for (const p of enabled) {
    console.log(`[MyMCP]   ✓ ${p.manifest.label} (${p.manifest.tools.length} tools)`);
  }
  for (const p of disabled) {
    console.log(`[MyMCP]   ✗ ${p.manifest.label} — ${p.reason}`);
  }
}
