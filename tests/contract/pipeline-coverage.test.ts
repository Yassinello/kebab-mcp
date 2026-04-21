/**
 * Contract test: every handler-exporting route under app/api (route.ts
 * files) must either compose a `composeRequestPipeline([...])` handler
 * (possibly indirectly via `withAdminAuth(` HOC) OR carry a
 * `// PIPELINE_EXEMPT: <reason>` marker at the top of the file.
 *
 * Closes PIPE-06 from .planning/milestones/v0.11-multi-tenant-real-ROADMAP.md.
 *
 * Rationale: the Phase 41 pipeline concentrates request-scoped policy
 * (rehydrate, auth, rate-limit, body-parse, CSRF, credentials) into one
 * composition site. A new route that forgets the pipeline silently
 * inherits none of that policy — the same class of regression this test
 * exists to foreclose for DUR-03's `withBootstrapRehydrate` coverage.
 *
 * To add a new exempt route:
 *   1. Add `// PIPELINE_EXEMPT: <reason ≥20 chars>` as the first
 *      comment line of the route file (before imports).
 *   2. Document the rationale in the PR body.
 *
 * NOTE: This file is scaffolded with `describe.skip(...)` in Task 1 so
 * the build does not fail before the Task 3-6 migrations land. Task 7
 * removes the `.skip` to enforce the contract.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const MARKER = "PIPELINE_EXEMPT:";
const REQUIRED_COMPOSE = "composeRequestPipeline(";
const REQUIRED_HOC = "withAdminAuth(";
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
  const head = source.split(/\r?\n/).slice(0, 10).join("\n");
  const idx = head.indexOf(MARKER);
  if (idx === -1) return false;
  const afterMarker = head.slice(idx + MARKER.length);
  const line = afterMarker.split(/\r?\n/)[0] ?? "";
  return line.trim().length >= MIN_EXEMPT_REASON_LEN;
}

function hasPipelineUsage(source: string): boolean {
  if (!source.includes(REQUIRED_COMPOSE) && !source.includes(REQUIRED_HOC)) return false;
  const verbRe = /export\s+(?:const|let|\{)[^;]*\b(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD)\b/;
  return verbRe.test(source);
}

function hasExportedVerb(source: string): boolean {
  const re =
    /export\s+(?:async\s+function|const|let|\{)[^;{]*\b(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD)\b/;
  return re.test(source);
}

describe.skip("pipeline-coverage contract (PIPE-06)", () => {
  it("every route uses composeRequestPipeline or withAdminAuth or carries PIPELINE_EXEMPT marker", () => {
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
      if (hasPipelineUsage(source)) continue;

      violations.push({
        file: rel,
        reason:
          "exports HTTP verb handler without `composeRequestPipeline(` / `withAdminAuth(` usage " +
          "and no `// PIPELINE_EXEMPT: <reason>` marker in first 10 lines",
      });
    }

    if (violations.length > 0) {
      const summary = violations.map((v) => `  ${v.file}\n    ${v.reason}`).join("\n");
      throw new Error(
        `Route(s) missing composeRequestPipeline wrap (PIPE-06):\n\n` +
          summary +
          `\n\nFix: migrate the handler to \`composeRequestPipeline([...], handler)\` from ` +
          `@/core/pipeline, OR wrap admin-only handlers with \`withAdminAuth(handler)\` from ` +
          `@/core/with-admin-auth, OR (if the route is legitimately exempt) add a first-line comment:\n  ` +
          `// PIPELINE_EXEMPT: <reason ≥ ${MIN_EXEMPT_REASON_LEN} chars>`
      );
    }

    expect(violations).toEqual([]);
  });
});
