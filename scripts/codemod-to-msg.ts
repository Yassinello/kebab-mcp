#!/usr/bin/env -S node --loader tsx
/**
 * Phase 49 / TYPE-02 — codemod that rewrites the legacy error-unwrap
 * ternary pattern to the canonical `toMsg()` helper.
 *
 * Input pattern (STRICT):
 *   <ident> instanceof Error ? <ident>.message : String(<ident>)
 * Output:
 *   toMsg(<ident>)
 *
 * Input pattern (WEIRD — returns raw err, not a string — unsafe):
 *   err instanceof Error ? err.message : err
 * Output:
 *   toMsg(err)
 *
 * Literal-fallback sites (`<ident> instanceof Error ? <ident>.message :
 * "some literal"`) are NOT rewritten — they carry bespoke user-facing
 * strings that would regress to `"[object Object]"` / `"undefined"`.
 *
 * Usage:
 *   tsx scripts/codemod-to-msg.ts --dry    # print diffs, exit 0
 *   tsx scripts/codemod-to-msg.ts --write  # apply in place
 *
 * Skips: tests/**, **\/*.test.ts, **\/*.spec.ts, src/core/error-utils.ts
 * (the helper itself contains the canonical shape as implementation)
 *
 * Tracked in VCS for future re-runs — the TYPE-04 contract test
 * prevents regressions but an intentional reintroduction could still
 * need a re-sweep.
 */

import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { argv, exit } from "node:process";

// ── CLI flag parsing ────────────────────────────────────────────────

const MODE: "dry" | "write" = argv.includes("--write")
  ? "write"
  : argv.includes("--dry")
    ? "dry"
    : "dry"; // default dry

// ── File walker ─────────────────────────────────────────────────────

const ROOTS = ["src", "app"];
const EXT_RE = /\.(ts|tsx|js|jsx|mjs)$/;

/** Skip paths that are outside the codemod's domain. */
function isSkipped(relPath: string): boolean {
  // Normalize to forward slashes for predictable matching
  const p = relPath.split(sep).join("/");
  if (/(^|\/)tests\//.test(p)) return true;
  if (/\.test\.(ts|tsx|js|jsx|mjs)$/.test(p)) return true;
  if (/\.spec\.(ts|tsx|js|jsx|mjs)$/.test(p)) return true;
  // The helper's own implementation contains the canonical shape —
  // don't self-rewrite
  if (p === "src/core/error-utils.ts") return true;
  return false;
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === ".next" || name === ".planning") continue;
    if (name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (EXT_RE.test(name)) out.push(p);
  }
  return out;
}

// ── Codemod core ────────────────────────────────────────────────────

/**
 * STRICT shape: <ident> instanceof Error ? <ident>.message : String(<ident>)
 * Uses backreference to ensure the same identifier is used in all three slots.
 */
const STRICT_RE = /(\b\w+\b)\s+instanceof\s+Error\s*\?\s*\1\.message\s*:\s*String\(\s*\1\s*\)/g;

/**
 * WEIRD shape: <ident> instanceof Error ? <ident>.message : <same ident>
 * (returns raw err, which is unsafe — toMsg() is strictly better).
 * Carefully bound so it doesn't match the STRICT shape's String(...) branch.
 */
const WEIRD_RE = /(\b\w+\b)\s+instanceof\s+Error\s*\?\s*\1\.message\s*:\s*\1(?=\s*[),\];}])/g;

interface FileChange {
  file: string;
  rewrites: number;
  importAdded: boolean;
  before: string;
  after: string;
}

/**
 * Add the `toMsg` named import to the file if it's not already present.
 * Heuristic: pick the last top-of-file `import` line and insert after it.
 * If the file already imports from `@/core/error-utils`, merge into that
 * line.
 */
function addImport(src: string): { next: string; added: boolean } {
  // Already imports toMsg? No-op
  if (/import\s+\{[^}]*\btoMsg\b[^}]*\}\s+from\s+["']@\/core\/error-utils["']/.test(src)) {
    return { next: src, added: false };
  }
  // Merge into existing `from "@/core/error-utils"` import if present
  const mergeRe = /(import\s+\{)([^}]*)(\}\s+from\s+["']@\/core\/error-utils["'])/;
  if (mergeRe.test(src)) {
    const next = src.replace(mergeRe, (_m, p1, p2, p3) => {
      const members = p2
        .split(",")
        .map((s: string) => s.trim())
        .filter(Boolean);
      members.push("toMsg");
      return `${p1} ${members.join(", ")} ${p3}`;
    });
    return { next, added: true };
  }

  // Determine relative import specifier — `src/core/error-utils.ts`
  // files can't use the `@/` alias; they need a relative path.
  // Simpler: always use `@/core/error-utils` for files in `app/` + files
  // in `src/` other than `src/core/`. For files in `src/core/`, use
  // the relative `./error-utils` variant.
  const specifier = "@/core/error-utils";

  return insertImportLine(src, `import { toMsg } from "${specifier}";`);
}

/** Relative-specifier variant for files that sit under src/core/. */
function addImportRelative(src: string, specifier: string): { next: string; added: boolean } {
  // If already imports from the same relative path, no-op
  const escapedSpec = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const existingRe = new RegExp(
    `import\\s+\\{[^}]*\\btoMsg\\b[^}]*\\}\\s+from\\s+["']${escapedSpec}["']`
  );
  if (existingRe.test(src)) {
    return { next: src, added: false };
  }
  // If a legacy `@/core/error-utils` slipped in (shouldn't for src/core/
  // files but handle it): rewrite to relative.
  const mergeAliasRe = /(import\s+\{)([^}]*)(\}\s+from\s+["'])@\/core\/error-utils(["'])/;
  if (mergeAliasRe.test(src)) {
    const next = src.replace(mergeAliasRe, (_m, p1, p2, p3, p4) => {
      const members = p2
        .split(",")
        .map((s: string) => s.trim())
        .filter(Boolean);
      if (!members.includes("toMsg")) members.push("toMsg");
      return `${p1} ${members.join(", ")} ${p3}${specifier}${p4}`;
    });
    return { next, added: true };
  }
  const mergeRelReSrc = `(import\\s+\\{)([^}]*)(\\}\\s+from\\s+["']${escapedSpec}["'])`;
  const mergeRelRe = new RegExp(mergeRelReSrc);
  if (mergeRelRe.test(src)) {
    const next = src.replace(mergeRelRe, (_m, p1, p2, p3) => {
      const members = p2
        .split(",")
        .map((s: string) => s.trim())
        .filter(Boolean);
      members.push("toMsg");
      return `${p1} ${members.join(", ")} ${p3}`;
    });
    return { next, added: true };
  }

  return insertImportLine(src, `import { toMsg } from "${specifier}";`);
}

/**
 * Insert an import statement at the correct top-of-file position,
 * respecting:
 *   - Shebang (`#!/usr/bin/env ...`) must stay on line 1
 *   - Use-strict / use-client directives must remain as the first non-
 *     shebang line(s) before any imports
 *   - Multi-line `import { ... } from "..."` blocks must not be split
 *   - Leading comments (JSDoc, //, /* ... *\u002F) stay at the top
 *
 * Strategy: scan for the end of the last import statement (tracking
 * multi-line blocks via brace-balance and the terminating `from`
 * clause). If no imports exist, insert after directives and leading
 * comments.
 */
function insertImportLine(src: string, importLine: string): { next: string; added: boolean } {
  const lines = src.split(/\r?\n/);
  let lastImportEndIdx = -1;
  let insideImport = false;
  let firstNonDirectiveIdx = -1; // first line that is NOT shebang / directive / blank

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const l = raw.trim();

    if (insideImport) {
      // Close when we see `} from "..."`
      if (
        /\}\s+from\s+["'][^"']+["'];?\s*$/.test(l) ||
        /^}\s*from\s+["'][^"']+["'];?\s*$/.test(l)
      ) {
        lastImportEndIdx = i;
        insideImport = false;
      }
      continue;
    }

    // Shebang (only valid on line 0)
    if (i === 0 && l.startsWith("#!")) continue;

    // Directives: "use client", "use strict", etc.
    if (/^["'`]use [a-z]+["'`];?$/.test(l)) {
      if (firstNonDirectiveIdx === -1) firstNonDirectiveIdx = i + 1;
      continue;
    }

    if (
      firstNonDirectiveIdx === -1 &&
      (l === "" ||
        l.startsWith("//") ||
        l.startsWith("/*") ||
        l.startsWith("*") ||
        l.startsWith("*/"))
    ) {
      // Leading comments / blank lines before first directive/import
      continue;
    }

    // Detect start of a multi-line import: `import {` or `import type {` with
    // the closing `}` NOT on the same line.
    if (/^import\s+(?:type\s+)?\{/.test(l) && !/\}\s+from\s+["'][^"']+["']/.test(l)) {
      insideImport = true;
      if (firstNonDirectiveIdx === -1) firstNonDirectiveIdx = i;
      continue;
    }

    if (
      l.startsWith("import ") ||
      l.startsWith("import{") ||
      l.startsWith('import"') ||
      l.startsWith("import'")
    ) {
      lastImportEndIdx = i;
      if (firstNonDirectiveIdx === -1) firstNonDirectiveIdx = i;
      continue;
    }

    if (
      l === "" ||
      l.startsWith("//") ||
      l.startsWith("/*") ||
      l.startsWith("*") ||
      l.startsWith("*/")
    ) {
      // Blank / comment lines between imports — keep scanning
      continue;
    }

    // First real code line ends the import block
    break;
  }

  if (lastImportEndIdx !== -1) {
    lines.splice(lastImportEndIdx + 1, 0, importLine);
  } else {
    // No imports — insert after shebang + directives (if any)
    let insertAt = 0;
    if (lines[0]?.startsWith("#!")) insertAt = 1;
    // Skip directives (must stay at top)
    while (insertAt < lines.length) {
      const l = (lines[insertAt] ?? "").trim();
      if (/^["'`]use [a-z]+["'`];?$/.test(l)) {
        insertAt++;
      } else {
        break;
      }
    }
    lines.splice(insertAt, 0, importLine);
  }
  return { next: lines.join("\n"), added: true };
}

/**
 * Given a source file's content + its path, produce the rewritten
 * content. Returns null if no rewrites would fire.
 */
function rewriteFile(file: string, src: string): FileChange | null {
  let hits = 0;
  const afterStrict = src.replace(STRICT_RE, (_m, ident) => {
    hits += 1;
    return `toMsg(${ident})`;
  });
  const afterWeird = afterStrict.replace(WEIRD_RE, (_m, ident) => {
    hits += 1;
    return `toMsg(${ident})`;
  });
  if (hits === 0) return null;

  // Special case: src/core/error-utils.ts owns the pattern and is
  // excluded upstream. For files UNDER src/core/ other than
  // error-utils.ts, use a relative import (depth-aware). For
  // everything else, use the `@/` alias.
  const normalized = file.split(sep).join("/");
  let next: string;
  let added: boolean;
  if (normalized.startsWith("src/core/") && normalized !== "src/core/error-utils.ts") {
    // Count depth beneath src/core/ to compute relative specifier
    // src/core/foo.ts              → ./error-utils
    // src/core/migrations/foo.ts   → ../error-utils
    // src/core/a/b/foo.ts          → ../../error-utils
    const tail = normalized.slice("src/core/".length);
    const depth = tail.split("/").length - 1;
    const prefix = depth === 0 ? "./" : "../".repeat(depth);
    const specifier = `${prefix}error-utils`;
    ({ next, added } = addImportRelative(afterWeird, specifier));
  } else {
    ({ next, added } = addImport(afterWeird));
  }

  return {
    file,
    rewrites: hits,
    importAdded: added,
    before: src,
    after: next,
  };
}

/** Minimal unified-diff-ish output for --dry mode. */
function printDiff(c: FileChange): void {
  const beforeLines = c.before.split(/\r?\n/);
  const afterLines = c.after.split(/\r?\n/);
  console.log(
    `\n=== ${c.file} (${c.rewrites} rewrite${c.rewrites === 1 ? "" : "s"}${c.importAdded ? ", +import" : ""}) ===`
  );
  const max = Math.max(beforeLines.length, afterLines.length);
  let shown = 0;
  for (let i = 0; i < max; i++) {
    const a = beforeLines[i];
    const b = afterLines[i];
    if (a !== b) {
      if (a !== undefined) console.log(`- ${a}`);
      if (b !== undefined) console.log(`+ ${b}`);
      shown++;
    }
  }
  if (shown === 0) console.log("(no visible diff — indentation-only?)");
}

// ── Main ────────────────────────────────────────────────────────────

function main(): void {
  const files: string[] = [];
  for (const root of ROOTS) {
    for (const f of walk(root)) {
      const rel = relative(process.cwd(), f);
      if (isSkipped(rel)) continue;
      files.push(f);
    }
  }

  const changes: FileChange[] = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const change = rewriteFile(f, src);
    if (change) changes.push(change);
  }

  if (changes.length === 0) {
    console.log("codemod-to-msg: no sites to rewrite. Exiting.");
    exit(0);
  }

  const totalRewrites = changes.reduce((s, c) => s + c.rewrites, 0);
  const totalImports = changes.filter((c) => c.importAdded).length;

  if (MODE === "dry") {
    for (const c of changes) printDiff(c);
    console.log(
      `\n── Summary ──\n` +
        `Files touched: ${changes.length}\n` +
        `Total rewrites: ${totalRewrites}\n` +
        `Imports added: ${totalImports}\n` +
        `Mode: --dry (no files modified). Re-run with --write to apply.`
    );
    exit(0);
  }

  // MODE === "write"
  for (const c of changes) {
    writeFileSync(c.file, c.after, "utf8");
  }
  console.log(
    `codemod-to-msg: wrote ${changes.length} file${changes.length === 1 ? "" : "s"}, ` +
      `${totalRewrites} rewrite${totalRewrites === 1 ? "" : "s"}, ` +
      `${totalImports} import${totalImports === 1 ? "" : "s"} added.`
  );
  exit(0);
}

main();
