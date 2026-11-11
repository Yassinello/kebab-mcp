/**
 * SEC-14 (2026-11 audit): bounded YAML frontmatter parsing for vault notes.
 * Notes are external content (the vault repo may be shared or synced), so a
 * crafted note must not be able to blow up memory through alias expansion.
 * Mirrors the guards of `src/core/frontmatter.ts` while keeping the default
 * schema (vault tools rely on YAML dates).
 */
import yaml from "js-yaml";

const MAX_FRONTMATTER_BYTES = 16 * 1024;

export function loadVaultYaml(block: string): unknown {
  if (Buffer.byteLength(block, "utf-8") > MAX_FRONTMATTER_BYTES) {
    throw new Error("Frontmatter too large");
  }
  if (/(^|\s)[&*][A-Za-z_]/.test(block)) {
    throw new Error("Frontmatter contains YAML anchors/aliases");
  }
  return yaml.load(block);
}
