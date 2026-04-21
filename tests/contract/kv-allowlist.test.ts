/**
 * Contract test: `getKVStore()` may only be called from allowlisted files.
 *
 * Every non-allowlisted callsite bypasses `TenantKVStore` tenant-prefixing
 * and risks cross-tenant data leakage (SEC-01). This test greps the source
 * tree and fails if a new caller is introduced outside the allowlist.
 *
 * Phase 42 (TEN-06) — ALLOWLIST shrunk from 19 → 15 entries.
 *
 * Removals (migrated to `getContextKVStore`, TEN-01..05):
 *   - src/core/rate-limit.ts        (TEN-01)
 *   - src/core/log-store.ts         (TEN-02)
 *   - src/core/tool-toggles.ts      (TEN-03)
 *   - app/api/config/context/route.ts (TEN-05)
 *
 * Additions (new migration scanner — global by design):
 *   - src/core/migrations/v0.11-tenant-scope.ts
 *
 * Retained with rationale:
 *   - src/core/backup.ts — conditional `getKVStore()` behind
 *     `scope === "all"` (root-operator cross-tenant restore path).
 *   - app/api/admin/rate-limits/route.ts — `?scope=all` query param
 *     is the root-operator cross-tenant view escape hatch.
 *
 * To add a new legitimate global-KV callsite, update `ALLOWLIST` below AND
 * document the rationale in `.planning/phases/42-tenant-scoping/INVENTORY.md`.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// Files where `getKVStore()` may legitimately be called.
// Rationale for each entry lives in INVENTORY.md.
const ALLOWLIST = new Set<string>([
  // Definition site + internal plumbing
  "src/core/kv-store.ts",
  "src/core/request-context.ts",
  "src/core/tenant.ts",
  // Bootstrap / first-run is intentionally pre-tenant
  "src/core/first-run.ts",
  "src/core/signing-secret.ts",
  // Dashboard env writes — global by design (transitional; see SEC-02)
  "src/core/env-store.ts",
  // Operator-wide systems — tenant-scoping is v0.11 work (see FOLLOW-UP)
  // backup.ts defaults to getContextKVStore (Phase 42 / TEN-04).
  // Retains conditional `getKVStore()` behind `scope === "all"` for the
  // root-operator cross-tenant restore path — hence still allowlisted.
  "src/core/backup.ts",
  // log-store.ts migrated to getContextKVStore (Phase 42 / TEN-02)
  // rate-limit.ts migrated to getContextKVStore (Phase 42 / TEN-01)
  // tool-toggles.ts migrated to getContextKVStore (Phase 42 / TEN-03)
  "src/core/config.ts",
  // Migration scanner — intentionally global to inventory legacy keys
  "src/core/migrations/v0.10-tenant-prefix.ts",
  "src/core/migrations/v0.11-tenant-scope.ts",
  // Storage/diagnostic/admin-migration — operator surfaces
  "app/api/storage/status/route.ts",
  "app/api/storage/migrate/route.ts",
  "app/api/storage/import/route.ts",
  // app/api/config/context/route.ts migrated to getContextKVStore (Phase 42 / TEN-05)
  // admin/rate-limits default path uses getContextKVStore. Retained
  // here because the `?scope=all` query-param opt-in exposes a
  // root-operator cross-tenant view via raw getKVStore(). See Phase 42
  // INVENTORY.md §3.
  "app/api/admin/rate-limits/route.ts",
  // Scripts (not runtime server code)
  "scripts/kv-compact.ts",
]);

// File roots to scan. Tests and node_modules are excluded — they're allowed
// to call getKVStore() freely in fixtures.
const SCAN_ROOTS = ["src", "app"];
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

/**
 * Enforcement mode is ON as of SEC-01b (v0.10). New `getKVStore()`
 * callsites outside the allowlist fail the build. If you have a
 * legitimately global-KV need, add the file to ALLOWLIST above + document
 * the rationale in `.planning/phases/37b-security-hotfix/INVENTORY.md`
 * (or the equivalent v0.11 inventory after that phase lands).
 */
const ENFORCE = true;

describe("kv-allowlist contract", () => {
  it("getKVStore() is only called from allowlisted files", () => {
    const projectRoot = join(__dirname, "..", "..");
    const files: string[] = [];
    for (const root of SCAN_ROOTS) {
      walk(join(projectRoot, root), files);
    }

    const violations: { file: string; line: number; text: string }[] = [];
    // Match bare getKVStore() calls, but not getTenantKVStore(...) or
    // getContextKVStore(...) or property access like foo.getKVStore.
    const callRe = /(?<![.\w])getKVStore\s*\(/;

    for (const abs of files) {
      const rel = toPosix(relative(projectRoot, abs));
      if (ALLOWLIST.has(rel)) continue;
      const contents = readFileSync(abs, "utf-8");
      const lines = contents.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Allow in comments
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
        if (callRe.test(line)) {
          violations.push({ file: rel, line: i + 1, text: line.trim() });
        }
      }
    }

    if (!ENFORCE) {
      // Scaffold phase — just log.
      if (violations.length > 0) {
        console.warn(
          `[kv-allowlist contract] ${violations.length} non-allowlisted getKVStore() call(s) found (enforcement pending):`
        );
        for (const v of violations.slice(0, 10)) {
          console.warn(`  ${v.file}:${v.line}  ${v.text}`);
        }
      }
      expect(true).toBe(true);
      return;
    }

    if (violations.length > 0) {
      const summary = violations.map((v) => `  ${v.file}:${v.line}\n    ${v.text}`).join("\n");
      throw new Error(
        `Non-allowlisted getKVStore() callsite(s) detected. These bypass TenantKVStore ` +
          `and risk cross-tenant data leakage (SEC-01).\n\n${summary}\n\n` +
          `Fix: replace with getContextKVStore() from @/core/request-context for per-request ` +
          `tenant isolation, or with getTenantKVStore(explicitId) when the tenant is known. ` +
          `If the callsite is legitimately global, add it to ALLOWLIST in this file and document ` +
          `the rationale in .planning/phases/37b-security-hotfix/INVENTORY.md.`
      );
    }

    expect(violations).toEqual([]);
  });
});
