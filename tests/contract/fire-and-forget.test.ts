/**
 * Contract test: every `void <promise>(...)` in `src/` and `app/` must be
 * annotated `// fire-and-forget OK: <reason>` on the same line OR the
 * line immediately above.
 *
 * Closes DUR-05 from .planning/milestones/v0.10-durability-ROADMAP.md.
 *
 * Rationale: the 2026-04-20 session had at least one bug (first-run.ts:312
 * `void persistBootstrapToKv(...)`) where Vercel's lambda reaper killed a
 * fire-and-forget promise before the durable write landed. Requiring an
 * annotation forces every `void <promise>` site to be deliberate — if
 * losing the result is safe, the reason is documented; if not, the
 * callsite must await.
 *
 * IMPORTANT: this ONLY matches `void identifier(...)` (with the call
 * parentheses). Plain `void nonce;` (the TypeScript "mark-used" idiom) is
 * NOT a fire-and-forget and is not caught by the regex.
 *
 * Client components (React event handlers) idiomatically use `void fn()`
 * to ignore the returned promise — those files are allowlisted.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SCAN_ROOTS = ["src", "app"];
const IGNORE_DIRS = new Set(["node_modules", ".next", "dist", "coverage"]);

// Client-component files where `void fn()` is idiomatic for React event
// handlers. If more client-components adopt the pattern, add them here
// (or promote this to a glob like `app/**/*.tsx` if the list gets long).
const FILE_ALLOWLIST = new Set<string>([
  "app/welcome/welcome-client.tsx",
  "app/config/tabs/storage.tsx",
  // OBS-05: Health tab uses `void refresh()` inside a setInterval
  // callback — standard React idiom for ignoring a useCallback
  // Promise. Allowlist the file (matches the precedent for other
  // client-component tabs).
  "app/config/tabs/health.tsx",
]);

const MARKER = "fire-and-forget OK:";
// Matches `void <expr>(...` at the start of a line (with optional
// leading whitespace). The <expr> may be a bare identifier
// (`void foo(...)`) or a member access chain (`void obj.foo(...)`,
// `void Promise.resolve(...)`). Requires the `(` to exclude the
// TypeScript `void identifier;` "mark-used" idiom. Multi-line block
// starts OK: only the first line of the call matters for this check.
const VOID_CALL_RE = /^\s*void\s+[a-zA-Z_$][\w$.]*\s*\(/;

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

describe("fire-and-forget contract (DUR-04 + DUR-05)", () => {
  it("every `void <promise>(...)` in src/ and app/ carries a `fire-and-forget OK:` annotation", () => {
    const projectRoot = join(__dirname, "..", "..");
    const files: string[] = [];
    for (const root of SCAN_ROOTS) {
      walk(join(projectRoot, root), files);
    }

    const violations: { file: string; line: number; text: string }[] = [];

    for (const abs of files) {
      const rel = toPosix(relative(projectRoot, abs));
      if (FILE_ALLOWLIST.has(rel)) continue;

      const source = readFileSync(abs, "utf-8");
      const lines = source.split(/\r?\n/);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!VOID_CALL_RE.test(line)) continue;

        // Accept marker on same line or immediately-previous line.
        const prev = i > 0 ? lines[i - 1] : "";
        if (line.includes(MARKER) || prev.includes(MARKER)) continue;

        violations.push({ file: rel, line: i + 1, text: line.trim() });
      }
    }

    if (violations.length > 0) {
      const summary = violations.map((v) => `  ${v.file}:${v.line}\n    ${v.text}`).join("\n");
      throw new Error(
        `Un-annotated \`void <promise>(...)\` callsite(s) (DUR-04/DUR-05):\n\n` +
          summary +
          `\n\nFix: either (a) \`await\` the promise, (b) delegate to ` +
          `\`ctx.waitUntil()\` where supported, or (c) add a same-line or ` +
          `previous-line comment:\n  // ${MARKER} <reason>`
      );
    }

    expect(violations).toEqual([]);
  });
});
