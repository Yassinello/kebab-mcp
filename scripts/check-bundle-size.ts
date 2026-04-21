/**
 * scripts/check-bundle-size.ts
 *
 * Size-limit gate for Phase 43 PERF-05.
 *
 * WHY NOT `size-limit` directly: Next 16 Turbopack produces flat, hash-named
 * static chunks (`.next/static/chunks/0o5i6cn~3_f-a.js`). There is no
 * `.next/static/chunks/app/config/` subdirectory the way Webpack produced
 * pre-Next-15, so size-limit's glob patterns cannot isolate per-route
 * chunk sets. Writing our own gate against the authoritative
 * `.next/diagnostics/route-bundle-stats.json` is the least-bad option.
 *
 * The stats file is produced by every `next build` and lists, per route:
 *   - `firstLoadUncompressedJsBytes` — total bytes of all JS fetched on
 *     first paint
 *   - `firstLoadChunkPaths` — the exact chunk URLs the route depends on
 *
 * We read the `.size-limit.json` file for budget entries (so the budget
 * values live in one obvious place) but apply the limit to the
 * stats-reported `firstLoadUncompressedJsBytes` instead of globbed files.
 *
 * Usage:
 *   npm run build      # produces .next/diagnostics/route-bundle-stats.json
 *   npm run size:check
 *
 * Exit codes:
 *   0 — all routes within budget
 *   1 — one or more routes exceeded budget (or infra error)
 *   2 — stats file missing / malformed (build didn't run)
 */

import * as fs from "node:fs";
import * as path from "node:path";

interface BudgetEntry {
  name: string;
  /**
   * Route the budget guards. `/config`, `/welcome`, `/` — matched against
   * the `route` field in `route-bundle-stats.json`.
   */
  route: string;
  /** Limit as a byte count or "N KB" / "N MB" string. */
  limit: string;
}

interface RouteStats {
  route: string;
  firstLoadUncompressedJsBytes: number;
  firstLoadChunkPaths?: string[];
}

function parseBytes(s: string): number {
  const m = /^([\d.]+)\s*(B|KB|MB)?$/i.exec(s.trim());
  if (!m) throw new Error(`Invalid size string: "${s}"`);
  const n = Number(m[1]);
  const unit = (m[2] || "B").toUpperCase();
  if (unit === "B") return n;
  if (unit === "KB") return n * 1024;
  if (unit === "MB") return n * 1024 * 1024;
  throw new Error(`Unknown unit: "${unit}"`);
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(2)} MB`;
}

function main(): number {
  const root = path.resolve(__dirname, "..");
  const budgetsPath = path.join(root, ".size-limit.json");
  const statsPath = path.join(root, ".next", "diagnostics", "route-bundle-stats.json");

  if (!fs.existsSync(statsPath)) {
    console.error(
      `[size-check] ${statsPath} missing. Run \`npm run build\` first so Next emits bundle stats.`
    );
    return 2;
  }
  if (!fs.existsSync(budgetsPath)) {
    console.error(`[size-check] ${budgetsPath} missing.`);
    return 2;
  }

  const budgets = JSON.parse(fs.readFileSync(budgetsPath, "utf8")) as BudgetEntry[];
  const stats = JSON.parse(fs.readFileSync(statsPath, "utf8")) as RouteStats[];

  let failures = 0;
  console.log("[size-check] Per-route first-load JS budgets\n");
  console.log(`  ${"Route".padEnd(22)}  ${"Actual".padEnd(12)}  ${"Limit".padEnd(12)}  Status`);
  console.log(`  ${"-".repeat(22)}  ${"-".repeat(12)}  ${"-".repeat(12)}  ------`);

  for (const budget of budgets) {
    const s = stats.find((r) => r.route === budget.route);
    if (!s) {
      console.log(
        `  ${budget.route.padEnd(22)}  ${"(missing)".padEnd(12)}  ${budget.limit.padEnd(12)}  [31mUNKNOWN[0m`
      );
      failures++;
      continue;
    }
    const limitBytes = parseBytes(budget.limit);
    const actual = s.firstLoadUncompressedJsBytes;
    const ok = actual <= limitBytes;
    const pct = ((actual / limitBytes) * 100).toFixed(1);
    const status = ok ? `\x1b[32mOK\x1b[0m (${pct}%)` : `\x1b[31mFAIL\x1b[0m (${pct}%)`;
    console.log(
      `  ${budget.route.padEnd(22)}  ${formatBytes(actual).padEnd(12)}  ${formatBytes(limitBytes).padEnd(12)}  ${status}`
    );
    if (!ok) failures++;
  }

  if (failures > 0) {
    console.log(
      `\n[size-check] \x1b[31mFAILED\x1b[0m: ${failures} route(s) over budget. ` +
        `Either the change legitimately added weight (update .size-limit.json with a 1-line rationale) ` +
        `or the regression needs investigation.`
    );
    return 1;
  }
  console.log("\n[size-check] OK — all routes within budget.");
  return 0;
}

process.exit(main());
