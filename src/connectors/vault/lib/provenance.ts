/**
 * TRU-03 (Kebab House phase 1): provenance of vault notes.
 *
 * Every note carries, or implicitly has, a `provenance` frontmatter field:
 *   - `external`  — fetched from the web (`save_article`), never trusted;
 *   - `assistant` — written by the model through `vault_write`/`vault_append`;
 *   - `user`      — anything else (notes without the field were written by
 *                   the user in Obsidian or by hand).
 *
 * The value is a label for the trust model, not an authenticated claim:
 * whoever can write the note can write the field. Writers here only ever
 * ADD the field when it is missing, they never overwrite an existing value
 * (so an `external` article appended to by the model stays `external`).
 *
 * YAML is read through the hardened `loadVaultYaml` parser (SEC-14). The
 * field is inserted as a text line rather than re-serialising the block, so
 * the user's own frontmatter formatting is preserved byte for byte.
 */
import { loadVaultYaml } from "./yaml-safe";

export type Provenance = "user" | "assistant" | "external";

const KNOWN: ReadonlySet<string> = new Set(["user", "assistant", "external"]);

/** Normalise a frontmatter object (or null) to a provenance value. */
export function provenanceOf(frontmatter: Record<string, unknown> | null | undefined): Provenance {
  const raw = frontmatter?.provenance;
  if (typeof raw === "string") {
    const v = raw.trim().toLowerCase();
    if (KNOWN.has(v)) return v as Provenance;
  }
  return "user";
}

interface FrontmatterSplit {
  /** Offset just after the opening `---` line. */
  bodyStart: number;
  /** Raw YAML between the fences. */
  block: string;
}

function splitFrontmatter(content: string): FrontmatterSplit | null {
  const open = /^---[ \t]*\r?\n/.exec(content);
  if (!open) return null;
  const bodyStart = open[0].length;
  // Same closing rule as vault_read: the first "\n---" after the opener. An
  // empty block ("---\n---") closes immediately.
  if (content.startsWith("---", bodyStart)) return { bodyStart, block: "" };
  const end = content.indexOf("\n---", bodyStart);
  if (end === -1) return null;
  return { bodyStart, block: content.slice(bodyStart, end) };
}

/**
 * Parse a note's frontmatter with the hardened parser. Returns null when the
 * note has no frontmatter, the block is not a mapping, or it fails to parse.
 */
export function parseNoteFrontmatter(content: string): Record<string, unknown> | null {
  const split = splitFrontmatter(content);
  if (!split) return null;
  try {
    const parsed = loadVaultYaml(split.block);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return null;
}

/** Provenance of a whole note (content including its frontmatter). */
export function noteProvenance(content: string): Provenance {
  return provenanceOf(parseNoteFrontmatter(content));
}

/**
 * Return `content` with a `provenance: <value>` field when the note does not
 * already declare one. Never clobbers an existing value.
 *
 *   - no frontmatter          → a new block is prepended;
 *   - frontmatter without it  → the line is inserted at the top of the block;
 *   - frontmatter with it     → unchanged;
 *   - frontmatter that fails to parse, or is not a mapping → unchanged (we
 *     do not risk corrupting a block we cannot read); such a note reads as
 *     `user`.
 */
export function ensureProvenance(content: string, value: Provenance): string {
  const split = splitFrontmatter(content);
  if (!split) {
    return `---\nprovenance: ${value}\n---\n\n${content}`;
  }
  let parsed: unknown;
  try {
    parsed = loadVaultYaml(split.block);
  } catch {
    return content;
  }
  if (parsed === null || parsed === undefined) {
    // Empty or comment-only block.
    if (/^provenance\s*:/m.test(split.block)) return content;
  } else if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return content;
  } else if (Object.prototype.hasOwnProperty.call(parsed, "provenance")) {
    return content;
  }
  return (
    content.slice(0, split.bodyStart) + `provenance: ${value}\n` + content.slice(split.bodyStart)
  );
}
