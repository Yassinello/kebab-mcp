/**
 * Shared frontmatter parser built on js-yaml (already a project dep).
 *
 * Replaces the hand-rolled YAML-subset parser that lived in
 * app/api/config/skills/import/route.ts and src/core/docs.ts. The old
 * parser silently dropped multiline block scalars, nested maps, and
 * every other YAML feature beyond single-line `key: value` — see
 * TECH-IMPROVEMENTS-v0.5 T2 and code-review H3 for the incident history.
 *
 * Usage:
 *   const { meta, body, warnings } = parseFrontmatter(raw);
 *
 * Contract:
 *   - Returns `{ meta: {}, body: raw, warnings: [...] }` when the
 *     `--- ... ---` delimiters are missing, so callers can still handle
 *     un-fenced markdown.
 *   - YAML parse errors degrade gracefully: meta is empty, warning is
 *     recorded, body is the portion after the second `---`.
 *   - Meta values are typed `unknown` — callers validate shape before
 *     trusting individual fields.
 */

import yaml from "js-yaml";
import { toMsg } from "./error-utils";

export interface FrontmatterResult {
  meta: Record<string, unknown>;
  body: string;
  warnings: string[];
}

/**
 * Max size of the frontmatter block (the text between `---` delimiters).
 * YAML anchor/alias expansion can blow a few KB of input into GB of
 * output (billion-laughs attack), so we hard-cap the INPUT size *and*
 * reject any frontmatter containing anchor/alias syntax before calling
 * yaml.load. JSON schema restricts types but does NOT disable anchors.
 */
const MAX_FRONTMATTER_BYTES = 16 * 1024;

// Strip trailing UTF-8 BOM if present — some editors add it and it
// would break the `/^---/` anchor.
const BOM = "\uFEFF";

function stripBom(s: string): string {
  return s.startsWith(BOM) ? s.slice(1) : s;
}

export function parseFrontmatter(raw: string): FrontmatterResult {
  const src = stripBom(raw);
  const match = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return {
      meta: {},
      body: src,
      warnings: ["No frontmatter found — meta is empty"],
    };
  }

  const [, frontText, body] = match;
  const warnings: string[] = [];

  if (frontText.length > MAX_FRONTMATTER_BYTES) {
    warnings.push(`Frontmatter exceeds ${MAX_FRONTMATTER_BYTES} bytes — refusing to parse`);
    return { meta: {}, body, warnings };
  }

  // YAML anchors (`&name`) and aliases (`*name`) enable amplification
  // attacks. We never use them in skill.md files, so reject outright if
  // any appear. Quick lexer check — matches at line start or after
  // whitespace to avoid false positives inside quoted strings.
  if (/(^|\s)[&*][A-Za-z_]/.test(frontText)) {
    warnings.push("Frontmatter contains YAML anchors/aliases — refusing to parse");
    return { meta: {}, body, warnings };
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(frontText, { schema: yaml.JSON_SCHEMA });
  } catch (err) {
    warnings.push(`Frontmatter YAML parse failed: ${toMsg(err)}`);
    return { meta: {}, body, warnings };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    warnings.push("Frontmatter parsed but is not a key/value map — ignored");
    return { meta: {}, body, warnings };
  }

  return {
    meta: parsed as Record<string, unknown>,
    body,
    warnings,
  };
}
