/**
 * Contract test: only `src/core/upstash-env.ts` (the helper) and
 * `.env.example` (operator docs) may reference the Upstash credential
 * env var names via `process.env`. All other code MUST go through
 * `getUpstashCreds()` or `hasUpstashCreds()`.
 *
 * Closes DUR-06 from .planning/milestones/v0.10-durability-ROADMAP.md.
 *
 * Rationale: the 2026-04-20 session shipped a bug because the code read
 * `UPSTASH_REDIS_REST_URL` but the Vercel Marketplace Upstash integration
 * injects `KV_REST_API_URL`. Centralizing the read behind a single helper
 * that recognizes both variants prevents the divergence from recurring.
 *
 * The regex targets `process.env.<NAME>` specifically — string literal
 * occurrences of the env var name in UI text, error messages, or JSX
 * are NOT env reads and are intentionally NOT caught.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SCAN_ROOTS = ["src", "app"];
const IGNORE_DIRS = new Set(["node_modules", ".next", "dist", "coverage"]);

// The only non-test files allowed to read these env vars directly.
const UPSTASH_ENV_ALLOWLIST = new Set<string>(["src/core/upstash-env.ts"]);

// Match `process.env.<NAME>` or `process.env["<NAME>"]` for any of the 4
// Upstash credential env var names. String-literal occurrences without
// `process.env` prefix are ignored (UI hints, error messages, comments).
const UPSTASH_ENV_RE =
  /process\.env\s*(?:\.\s*(?:UPSTASH_REDIS_REST_URL|UPSTASH_REDIS_REST_TOKEN|KV_REST_API_URL|KV_REST_API_TOKEN)\b|\[\s*["'](?:UPSTASH_REDIS_REST_URL|UPSTASH_REDIS_REST_TOKEN|KV_REST_API_URL|KV_REST_API_TOKEN)["']\s*\])/;

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

describe("upstash-env-single-reader contract (DUR-06)", () => {
  it("only src/core/upstash-env.ts reads UPSTASH_REDIS_REST_* / KV_REST_API_* from process.env", () => {
    const projectRoot = join(__dirname, "..", "..");
    const files: string[] = [];
    for (const root of SCAN_ROOTS) {
      walk(join(projectRoot, root), files);
    }

    const violations: { file: string; line: number; text: string }[] = [];

    for (const abs of files) {
      const rel = toPosix(relative(projectRoot, abs));
      if (UPSTASH_ENV_ALLOWLIST.has(rel)) continue;

      const source = readFileSync(abs, "utf-8");
      const lines = source.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (UPSTASH_ENV_RE.test(line)) {
          violations.push({ file: rel, line: i + 1, text: line.trim() });
        }
      }
    }

    if (violations.length > 0) {
      const summary = violations.map((v) => `  ${v.file}:${v.line}\n    ${v.text}`).join("\n");
      throw new Error(
        `Non-allowlisted Upstash env var read(s) (DUR-06):\n\n` +
          summary +
          `\n\nFix: replace the \`process.env.UPSTASH_*\` / \`process.env.KV_REST_API_*\` ` +
          `read with \`getUpstashCreds()\` or \`hasUpstashCreds()\` from ` +
          `@/core/upstash-env. This guarantees both naming variants ` +
          `(manual Upstash + Vercel Marketplace KV) resolve identically.`
      );
    }

    expect(violations).toEqual([]);
  });
});
