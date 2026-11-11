/**
 * Contract test: no file under `src/` or `app/` may reintroduce the
 * legacy error-unwrap ternary pattern
 *   `<ident> instanceof Error ? <ident>.message : String(<ident>)`
 * or the WEIRD `err instanceof Error ? err.message : err` variant.
 *
 * Closes Phase 49 / TYPE-04 — prevents the 65-site codemod (from
 * commit e5bceb2) from eroding as new callsites land. Use
 * `toMsg(err)` from `@/core/error-utils` instead.
 *
 * Allowlist:
 *   - `tests/**` and `**\/*.test.ts` (tests often reason about both
 *     branches of the ternary intentionally; roadmap D-04)
 *   - `scripts/codemod-to-msg.ts` (contains the pattern as a regex
 *     string literal)
 *   - `src/core/error-utils.ts` (the helper's own implementation IS
 *     the canonical short-circuit shape by construction)
 *
 * Windows-safe: uses `fs.readdirSync` recursion, NOT a `rg` / `grep`
 * subprocess (precedent: tests/contract/fire-and-forget.test.ts +
 * tests/contract/url-safety grep-contracts). No PATH dependencies.
 *
 * Literal-fallback variants (`<ident> instanceof Error ? <ident>.message
 * : "some literal"`) are NOT caught by this regex — they are semantically
 * different (bespoke user-facing strings) and are tracked separately
 * in the T-LITFB follow-up backlog.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SCAN_ROOTS = ["src", "app"];
const IGNORE_DIRS = new Set(["node_modules", ".next", "dist", "coverage"]);

/** Paths (relative, forward-slash) that are allowed to contain the pattern. */
const FILE_ALLOWLIST: ReadonlySet<string> = new Set([
  "src/core/error-utils.ts",
  "scripts/codemod-to-msg.ts",
]);

// STRICT shape: <ident> instanceof Error ? <ident>.message : String(<ident>)
const STRICT_RE = /(\b\w+\b)\s+instanceof\s+Error\s*\?\s*\1\.message\s*:\s*String\(\s*\1\s*\)/;

// WEIRD shape: <ident> instanceof Error ? <ident>.message : <same ident>
// Used sparingly — the codemod converted 2 sites to toMsg().
const WEIRD_RE = /(\b\w+\b)\s+instanceof\s+Error\s*\?\s*\1\.message\s*:\s*\1(?=\s*[),\];}])/;

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (IGNORE_DIRS.has(name)) continue;
    if (name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      walk(p, out);
    } else if (/\.(ts|tsx|js|jsx|mjs)$/.test(name)) {
      // Skip test files at the filesystem level
      if (/\.(test|spec)\.(ts|tsx|js|jsx|mjs)$/.test(name)) continue;
      out.push(p);
    }
  }
  return out;
}

function normalizePath(p: string): string {
  return relative(process.cwd(), p).split(sep).join("/");
}

describe("no-err-ternary contract (TYPE-04 / Phase 49)", () => {
  it("no file under src/ or app/ contains the legacy ternary pattern (excluding allowlisted files)", () => {
    const offenders: string[] = [];

    for (const root of SCAN_ROOTS) {
      for (const file of walk(root)) {
        const rel = normalizePath(file);

        // Skip allowlisted files (canonical helpers + the codemod itself)
        if (FILE_ALLOWLIST.has(rel)) continue;

        // Double-guard for tests/** paths that might slip through (they
        // shouldn't live under src/ or app/, but be defensive)
        if (rel.startsWith("tests/") || rel.includes("/tests/")) continue;

        const text = readFileSync(file, "utf8");
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] ?? "";
          if (STRICT_RE.test(line) || WEIRD_RE.test(line)) {
            offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
          }
        }
      }
    }

    if (offenders.length > 0) {
      // Print for actionable debugging on failure
      for (const o of offenders) {
        console.error("no-err-ternary:", o);
      }
    }

    expect(
      offenders,
      `${offenders.length} site(s) reintroduced the legacy ternary pattern. Replace with toMsg(err) from @/core/error-utils.`
    ).toEqual([]);
  });

  it("the allowlist is tight — every allowlisted path exists and still contains the pattern (else remove from allowlist)", () => {
    // Defensive: the allowlist should only exempt files that actually
    // need the exemption. If an allowlisted file no longer contains
    // the pattern, the allowlist entry is dead code and should be
    // removed so a future regression can't silently hide behind it.
    const stale: string[] = [];
    for (const relPath of FILE_ALLOWLIST) {
      const abs = join(process.cwd(), relPath);
      let text: string;
      try {
        text = readFileSync(abs, "utf8");
      } catch {
        stale.push(`${relPath} (file missing)`);
        continue;
      }
      // For scripts/codemod-to-msg.ts, the pattern lives inside a regex
      // string literal — it won't match STRICT_RE / WEIRD_RE directly
      // (backreferences don't get literal matches), so relax the check
      // to "file mentions instanceof Error" + ".message".
      const hasAnyHint = /instanceof\s+Error/.test(text) && /\.message/.test(text);
      if (!hasAnyHint) stale.push(`${relPath} (no longer references the pattern)`);
    }
    expect(stale, `Stale allowlist entries: ${stale.join(", ")}`).toEqual([]);
  });
});
