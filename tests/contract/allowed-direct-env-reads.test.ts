/**
 * Phase 48 / FACADE-03 contract — allowed direct process.env reads.
 *
 * Belt-and-suspenders to the `kebab/no-direct-process-env` ESLint rule.
 * Walks src/ + app/ for `process.env.X` reads; every file with a hit
 * must appear in `ALLOWED_DIRECT_ENV_READS`. Fails CI when an IDE
 * silences the ESLint rule locally and someone ships a bypass.
 *
 * Also asserts structural invariants: sorted, non-empty, reasons ≥ 20
 * chars, no duplicate file entries.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { ALLOWED_DIRECT_ENV_READS } from "@/core/config-facade";

const SCAN_ROOTS = ["src", "app"];
const IGNORE_DIRS = new Set(["node_modules", ".next", "dist", "coverage", "__tests__"]);

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (IGNORE_DIRS.has(entry)) continue;
      walk(full, out);
    } else if (
      st.isFile() &&
      (entry.endsWith(".ts") || entry.endsWith(".tsx")) &&
      !entry.endsWith(".test.ts") &&
      !entry.endsWith(".test.tsx") &&
      !entry.endsWith(".e2e.test.ts") &&
      entry !== "test-utils.ts"
    ) {
      out.push(full);
    }
  }
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

describe("allowed-direct-env-reads contract (FACADE-03)", () => {
  const projectRoot = join(__dirname, "..", "..");
  const allowedFiles = new Set(ALLOWED_DIRECT_ENV_READS.map((e) => e.file));

  it("every file with a direct process.env read appears in ALLOWED_DIRECT_ENV_READS", () => {
    const files: string[] = [];
    for (const root of SCAN_ROOTS) {
      walk(join(projectRoot, root), files);
    }

    // Match: `process.env.FOO` (member) OR `process.env[...]` (computed).
    // Exclude assignment LHS — those are SEC-02's turf.
    const readRe = /(?<![.\w])process\.env(?:\.\w+|\[[^\]]+\])/;
    // Additional guard: don't flag comment-only lines (crude but sufficient —
    // full SLOC parsing is overkill here; the ESLint rule has the AST).
    const commentRe = /^\s*(\/\/|\*|\/\*)/;

    // Assignment patterns to skip (covered by SEC-02):
    //   process.env.FOO = ...
    //   process.env[key] = ...
    const assignRe = /\bprocess\.env(?:\.\w+|\[[^\]]+\])\s*=[^=]/;

    const violations: { file: string; line: number; text: string }[] = [];
    for (const abs of files) {
      const rel = toPosix(relative(projectRoot, abs));
      if (allowedFiles.has(rel)) continue;
      const contents = readFileSync(abs, "utf-8");
      const lines = contents.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (commentRe.test(line)) continue;
        if (assignRe.test(line)) continue; // SEC-02 owns assignments
        if (readRe.test(line)) {
          violations.push({ file: rel, line: i + 1, text: line.trim() });
        }
      }
    }

    if (violations.length > 0) {
      const msg = violations.map((v) => `  ${v.file}:${v.line}  ${v.text}`).join("\n");
      throw new Error(
        `Direct process.env reads detected outside ALLOWED_DIRECT_ENV_READS.\n\n${msg}\n\n` +
          `Fix: swap to getConfig('X') from @/core/config-facade. If this is a genuine ` +
          `boot-time read that cannot migrate, add the file to ALLOWED_DIRECT_ENV_READS in ` +
          `src/core/config-facade.ts with a ≥20-char reason.`
      );
    }
    expect(violations).toEqual([]);
  });

  it("ALLOWED_DIRECT_ENV_READS is sorted by file path", () => {
    const files = ALLOWED_DIRECT_ENV_READS.map((e) => e.file);
    const sorted = [...files].sort();
    expect(files).toEqual(sorted);
  });

  it("every entry has a ≥20 char reason", () => {
    for (const entry of ALLOWED_DIRECT_ENV_READS) {
      expect(entry.reason.length).toBeGreaterThanOrEqual(20);
    }
  });

  it("no duplicate file entries", () => {
    const seen = new Set<string>();
    for (const entry of ALLOWED_DIRECT_ENV_READS) {
      expect(seen.has(entry.file)).toBe(false);
      seen.add(entry.file);
    }
  });

  it("at least one var per entry", () => {
    for (const entry of ALLOWED_DIRECT_ENV_READS) {
      expect(entry.vars.length).toBeGreaterThan(0);
    }
  });
});
