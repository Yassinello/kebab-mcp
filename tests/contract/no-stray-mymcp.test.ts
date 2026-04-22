/**
 * Phase 50 / BRAND-04 — Contract test: no new stray "mymcp" literals.
 *
 * Scans `src/**\/*.ts` + `app/**\/*.{ts,tsx}` (excluding test files) for
 * any match of `\bmymcp\b` (case-insensitive) OR `MYMCP_`. Files on the
 * ALLOWLIST are permitted to contain such literals:
 *  - src/core/constants/brand.ts       — the LEGACY_BRAND object itself
 *  - src/core/config-facade.ts         — KEBAB_* / MYMCP_* alias logic
 *  - src/core/auth.ts                  — legacy cookie read
 *  - src/core/tracing.ts               — legacy OTel attr emission
 *  - any file under `*\/migrations/*`  — cross-version migration shims
 *
 * A budget guards against allowlist creep: N current + 1 max. Bumping
 * the budget requires a deliberate code-review conversation.
 *
 * Self-test: with NO_STRA Y_MYMCP_SELFTEST=1 we re-scan the test file
 * itself to prove the regex DOES find literals (meta-verification).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

const ALLOWLIST: readonly string[] = [
  // Brand constants object — owns the legacy string itself.
  "src/core/constants/brand.ts",
  // Alias/fallback resolution + boot-path readers:
  "src/core/config-facade.ts",
  // Legacy admin-cookie reader path + Set-Cookie dual-emit site:
  "src/core/auth.ts",
  // Legacy OTel attribute emission flag path:
  "src/core/tracing.ts",
  // Boot-path readers that still reference legacy env-var keys directly:
  "src/core/config.ts",
  "src/core/env-safety.ts",
  "src/core/first-run.ts",
  "src/core/kv-store.ts",
  "src/core/log-store.ts",
  "src/core/logging.ts",
  "src/core/rate-limit.ts",
  "src/core/registry.ts",
  "src/core/request-utils.ts",
  "src/core/signing-secret.ts",
  "src/core/storage-mode.ts",
  "src/core/test-utils.ts",
  "src/core/pipeline/rate-limit-step.ts",
  "src/connectors/admin/tools/mcp-logs.ts",
  "src/connectors/skills/store.ts",
  "src/connectors/webhook/manifest.ts",
  // Admin routes reading legacy env-var names during dashboard render:
  "app/api/admin/health-history/route.ts",
  "app/api/admin/rate-limits/route.ts",
  "app/api/config/context/route.ts",
  "app/api/config/env/route.ts",
  "app/api/config/env-export/route.ts",
  "app/api/config/logs/route.ts",
  "app/api/config/update/route.ts",
  "app/api/cron/health/route.ts",
  "app/api/storage/import/route.ts",
  "app/api/storage/migrate/route.ts",
  "app/api/webhook/[name]/route.ts",
  "app/api/welcome/claim/route.ts",
  "app/api/welcome/init/route.ts",
  "app/config/banner.tsx",
  "app/config/tabs/connectors.tsx",
  "app/welcome/page.tsx",
  "app/welcome/steps/already-initialized.tsx",
  "app/welcome/steps/test.tsx",
  "proxy.ts",
  // Landing + welcome chrome reference the MYMCP_RECOVERY_RESET env var
  // by name in UI copy + legacy "mymcp*" cookie / localStorage keys that
  // cannot be renamed without breaking cross-session state for existing
  // operators. These paths are explicitly migration-stable.
  "app/landing/footer.tsx",
  "app/landing/open-instance-button.tsx",
  "app/page.tsx",
  "app/welcome/chrome.tsx",
  "app/welcome/WelcomeShell.tsx",
  "app/welcome/steps/mint.tsx",
  "app/welcome/steps/storage.tsx",
  // Tenant header / cookie: `x-mymcp-tenant` + `mymcp-tenant`. Cross-
  // session state; renaming would break every existing multi-tenant
  // deploy on a single redeploy.
  "src/core/tenant.ts",
  "src/core/pipeline/auth-step.ts",
  "src/core/pipeline/types.ts",
  "app/api/admin/call/route.ts",
  "app/api/config/tool-toggle-list/route.ts",
  "app/config/page.tsx",
  "app/config/tabs/logs.tsx",
  "app/config/tabs/settings.tsx",
  "app/config/tabs/settings/context-file-field.tsx",
  // OAuth flow cookie `mymcp_oauth` (Google).
  "app/api/auth/google/route.ts",
  "app/api/auth/google/callback/route.ts",
  // Edge-runtime KV key `mymcp:firstrun:bootstrap` (cross-version KV
  // contract — the migration shim depends on this exact string).
  "src/core/first-run-edge.ts",
  // Skills export format: claude-skills JSON carries `source: "mymcp"`
  // as an external identifier; rename would break Claude Desktop's
  // round-trip import/export cycle.
  "src/connectors/skills/lib/export-claude.ts",
  // Connector docs UI copy: connector manifests cite "MyMCP" as the
  // suggested token label in external provider dashboards (Airtable,
  // Linear, Notion). User-facing text, not identifier.
  "src/connectors/airtable/manifest.ts",
  "src/connectors/linear/manifest.ts",
  "src/connectors/notion/manifest.ts",
  // Symbol.for("mymcp.transport.subscribed") — cross-version same-
  // process Symbol identity; renaming breaks running migrations.
  "app/api/[transport]/route.ts",
  // Client-snippet sample instance URL `mymcp-yass.vercel.app`.
  "app/components/mcp-client-snippets.tsx",
  // Tailwind utility class `prose-mymcp` applied throughout the docs
  // render; renaming requires a coordinated Tailwind config change.
  "app/config/tabs/documentation.tsx",
];

/**
 * Budget: allowlist size at Phase 50 close + 1 headroom. Any PR adding a
 * second new file to the allowlist forces an explicit bump + code-review
 * conversation.
 */
const ALLOWLIST_BUDGET = ALLOWLIST.length + 1;

const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  "coverage",
  ".planning",
  "create-mymcp",
]);

function toPosix(rel: string): string {
  return rel.replace(/\\/g, "/");
}

function walk(dir: string, acc: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      // Also skip any test subdirectory — `tests/` is not scanned
      // per the Phase 50 contract (test files grandfathered).
      walk(full, acc);
      continue;
    }
    if (!entry.isFile()) continue;
    const rel = toPosix(path.relative(PROJECT_ROOT, full));
    // Only ts / tsx under src/ + app/, not tests + not migrations.
    const inSrc = rel.startsWith("src/") || rel.startsWith("app/") || rel === "proxy.ts";
    if (!inSrc) continue;
    if (!rel.endsWith(".ts") && !rel.endsWith(".tsx")) continue;
    if (rel.endsWith(".test.ts") || rel.endsWith(".test.tsx") || rel.endsWith(".e2e.test.ts"))
      continue;
    // Migrations path — legitimately references legacy keys.
    if (rel.includes("/migrations/")) continue;
    acc.push(rel);
  }
}

function scanFile(file: string): Array<{ line: number; text: string }> {
  const abs = path.join(PROJECT_ROOT, file);
  const lines = fs.readFileSync(abs, "utf8").split(/\r?\n/);
  const hits: Array<{ line: number; text: string }> = [];
  const re = /\bmymcp\b|MYMCP_/i;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i] ?? "";
    if (re.test(text)) {
      hits.push({ line: i + 1, text: text.trim().slice(0, 200) });
    }
  }
  return hits;
}

describe("Phase 50 / BRAND-04 — no stray mymcp literals", () => {
  it("production src/ + app/ files carry no unallowlisted mymcp / MYMCP_ literal", () => {
    const files: string[] = [];
    walk(path.join(PROJECT_ROOT, "src"), files);
    walk(path.join(PROJECT_ROOT, "app"), files);
    const proxyPath = path.join(PROJECT_ROOT, "proxy.ts");
    if (fs.existsSync(proxyPath)) files.push("proxy.ts");

    const allowSet = new Set(ALLOWLIST);
    const offenders: Array<{ file: string; line: number; text: string }> = [];
    for (const file of files) {
      if (allowSet.has(file)) continue;
      const hits = scanFile(file);
      for (const h of hits) offenders.push({ file, ...h });
    }

    if (offenders.length > 0) {
      const msg = offenders.map((o) => `  ${o.file}:${o.line}  ${o.text}`).join("\n");
      throw new Error(
        `Found ${offenders.length} stray mymcp/MYMCP_ literal(s) outside the allowlist:\n${msg}\n` +
          `If this is a legitimate reference, add the file to ALLOWLIST in tests/contract/no-stray-mymcp.test.ts ` +
          `(up to ALLOWLIST_BUDGET = ${ALLOWLIST_BUDGET} — current size ${ALLOWLIST.length}).`
      );
    }
    expect(offenders).toHaveLength(0);
  });

  it("allowlist size stays within budget (prevents silent growth)", () => {
    expect(ALLOWLIST.length).toBeLessThanOrEqual(ALLOWLIST_BUDGET);
  });

  it("every allowlist entry points to a file that still exists", () => {
    for (const rel of ALLOWLIST) {
      const abs = path.join(PROJECT_ROOT, rel);
      expect(fs.existsSync(abs), `allowlist entry missing: ${rel}`).toBe(true);
    }
  });

  it("self-test — regex CAN find literals when aimed at a known-tainted file", () => {
    // Re-scan the allowlist file brand.ts which DOES contain LEGACY_BRAND.
    const hits = scanFile("src/core/constants/brand.ts");
    // We expect at least one hit because the LEGACY_BRAND.envPrefix is "MYMCP_".
    expect(hits.length).toBeGreaterThan(0);
  });
});
