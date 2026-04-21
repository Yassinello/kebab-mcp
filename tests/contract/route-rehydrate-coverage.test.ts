/**
 * Contract test: every auth-gated API route under app/api (route.ts files)
 * must either wrap its exported handlers in `withBootstrapRehydrate(...)`
 * OR carry a `// BOOTSTRAP_EXEMPT: <reason>` marker at the top of the file.
 *
 * Closes DUR-03 from .planning/milestones/v0.10-durability-ROADMAP.md.
 *
 * Rationale: the 2026-04-20 debugging session shipped multiple bugs where
 * auth-gated handlers read `MCP_AUTH_TOKEN` (or other bootstrap state)
 * before `rehydrateBootstrapAsync()` had a chance to pull it from durable
 * KV. Wrapping every handler in the HOC guarantees rehydrate happens at
 * entry; this test fails the build if a new route is added without the
 * wrapper or a documented exemption.
 *
 * To add a new exempt route:
 *   1. Add `// BOOTSTRAP_EXEMPT: <reason ≥20 chars>` as the first comment
 *      line of the route file (before imports).
 *   2. Document the rationale in the PR body.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const MARKER = "BOOTSTRAP_EXEMPT:";
const HOC_NAME = "withBootstrapRehydrate";
const MIN_EXEMPT_REASON_LEN = 20;

// Scan only API route handlers (middleware + server components are not
// covered — they have their own auth paths).
const SCAN_ROOTS = ["app/api"];
const IGNORE_DIRS = new Set(["node_modules", ".next", "dist", "coverage"]);

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
    } else if (st.isFile() && entry === "route.ts" && !entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

function hasExemptMarker(source: string): boolean {
  // Allow the marker in the first ~10 lines (before imports).
  const head = source.split(/\r?\n/).slice(0, 10).join("\n");
  const idx = head.indexOf(MARKER);
  if (idx === -1) return false;
  // Extract reason text after the marker on the same line; require a non-empty reason.
  const afterMarker = head.slice(idx + MARKER.length);
  const line = afterMarker.split(/\r?\n/)[0] ?? "";
  return line.trim().length >= MIN_EXEMPT_REASON_LEN;
}

function hasHocWrap(source: string): boolean {
  // Match either:
  //   export const GET = withBootstrapRehydrate(getHandler)
  //   export const GET = withBootstrapRehydrate<...>(getHandler)
  //   const wrapped = withBootstrapRehydrate(handler); export { wrapped as GET };
  // i.e. HOC appears at least once AND at least one exported verb reference exists.
  if (!source.includes(`${HOC_NAME}(`) && !source.includes(`${HOC_NAME}<`)) return false;
  const verbRe = /export\s+(?:const|let|\{)[^;]*\b(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD)\b/;
  return verbRe.test(source);
}

function hasExportedVerb(source: string): boolean {
  // Detect routes that export any HTTP verb at all — if none, the file is not
  // a handler (e.g., a pure helper module inadvertently named route.ts).
  const re =
    /export\s+(?:async\s+function|const|let|\{)[^;{]*\b(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD)\b/;
  return re.test(source);
}

describe("route-rehydrate-coverage contract (DUR-01 + DUR-03)", () => {
  it("every auth-gated route wraps exports in withBootstrapRehydrate or carries BOOTSTRAP_EXEMPT marker", () => {
    const projectRoot = join(__dirname, "..", "..");
    const files: string[] = [];
    for (const root of SCAN_ROOTS) {
      walk(join(projectRoot, root), files);
    }

    const violations: { file: string; reason: string }[] = [];
    for (const abs of files) {
      const rel = toPosix(relative(projectRoot, abs));
      const source = readFileSync(abs, "utf-8");

      if (!hasExportedVerb(source)) continue; // not a handler
      if (hasExemptMarker(source)) continue;
      if (hasHocWrap(source)) continue;

      violations.push({
        file: rel,
        reason:
          "exports HTTP verb handler without `withBootstrapRehydrate(...)` wrap " +
          "and no `// BOOTSTRAP_EXEMPT: <reason>` marker in first 10 lines",
      });
    }

    if (violations.length > 0) {
      const summary = violations.map((v) => `  ${v.file}\n    ${v.reason}`).join("\n");
      throw new Error(
        `Auth-gated route(s) missing withBootstrapRehydrate wrapper (DUR-01/DUR-03):\n\n` +
          summary +
          `\n\nFix: wrap the exported handler in withBootstrapRehydrate() from ` +
          `@/core/with-bootstrap-rehydrate, OR (if the route is legitimately exempt) ` +
          `add a first-line comment:\n  // BOOTSTRAP_EXEMPT: <reason ≥ ${MIN_EXEMPT_REASON_LEN} chars>`
      );
    }

    expect(violations).toEqual([]);
  });
});
