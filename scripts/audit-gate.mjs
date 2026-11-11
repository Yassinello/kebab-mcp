#!/usr/bin/env node
// Phase 44 SCM-03 — audit policy gate
//
// Policy:
//   FAIL on direct-dep moderate+ unless allowlisted with a tracked justification
//   FAIL on high/critical (any scope) unless allowlisted with a tracked
//     justification (only legitimate when the sole fix is a breaking major
//     downgrade and the vulnerable path is provably not exercised)
//   WARN on transitive-dep moderate (usually can't be fixed without upstream action)
//
// Allowlist entries must cite a GHSA/CVE or equivalent advisory plus a reason
// and a review-by date (YYYY-MM-DD). The gate prints allowlisted items on
// every run so they stay visible. Allowlisting a high/critical is a
// deliberate risk-acceptance — keep the reason specific (why the vulnerable
// code path is unreachable) and the reviewBy short.
//
// CI-01 — reviewBy is ENFORCED:
//   FAIL when an entry's reviewBy is in the past (expired risk-acceptance)
//   FAIL when an entry's reviewBy is more than MAX_REVIEW_HORIZON_DAYS ahead
//   FAIL when an entry's reason is missing / too short
//   WARN when an entry no longer matches any reported advisory (stale — delete it)
//
// History: the 2026-11 audit found 7 expired entries (Stagehand/langsmith,
// the OpenTelemetry cluster, next/postcss). The OTel cluster was bumped to
// sdk-node / exporter-trace-otlp-http 0.301.x and the other advisories no
// longer reproduce against the lockfile, so the allowlist is now empty.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const MAX_REVIEW_HORIZON_DAYS = 90;

/** @type {Array<{ pkg: string; reason: string; reviewBy: string }>} */
const ALLOWLIST = [];

/**
 * Resolve how to invoke npm WITHOUT a shell. On Windows `npm` is a .cmd
 * shim that execFileSync cannot spawn without `shell: true`, so we run
 * npm's JS entry point with the current node binary instead.
 */
function npmCommand() {
  const execPath = process.env.npm_execpath;
  if (execPath && /\.c?js$/.test(execPath) && existsSync(execPath)) {
    return { file: process.execPath, prefix: [execPath] };
  }
  if (process.platform === "win32") {
    const cli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    if (existsSync(cli)) return { file: process.execPath, prefix: [cli] };
  }
  return { file: "npm", prefix: [] };
}

function runAudit() {
  const { file, prefix } = npmCommand();
  try {
    const out = execFileSync(
      file,
      [...prefix, "audit", "--audit-level=moderate", "--omit=dev", "--json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 },
    );
    return JSON.parse(out);
  } catch (err) {
    if (err.stdout) return JSON.parse(err.stdout);
    throw err;
  }
}

/** Validate allowlist entries against today (UTC). Returns failure messages. */
function checkAllowlistEntries(now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const horizon = new Date(now.getTime() + MAX_REVIEW_HORIZON_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const problems = [];
  for (const entry of ALLOWLIST) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.reviewBy ?? "")) {
      problems.push(`${entry.pkg}: reviewBy "${entry.reviewBy}" is not a YYYY-MM-DD date`);
    } else if (entry.reviewBy < today) {
      problems.push(
        `${entry.pkg}: reviewBy ${entry.reviewBy} has EXPIRED (today is ${today}) — re-review the risk or remove the entry`,
      );
    } else if (entry.reviewBy > horizon) {
      problems.push(
        `${entry.pkg}: reviewBy ${entry.reviewBy} is more than ${MAX_REVIEW_HORIZON_DAYS} days ahead (max ${horizon})`,
      );
    }
    if (!entry.reason || entry.reason.trim().length < 40) {
      problems.push(`${entry.pkg}: reason is missing or too short to be a real justification`);
    }
  }
  return problems;
}

const report = runAudit();
const vulns = report.vulnerabilities || {};
const failures = [];
const warnings = [];
const allowlisted = [];

for (const [name, v] of Object.entries(vulns)) {
  const severity = v.severity;
  const isDirect = v.isDirect === true;
  const match = ALLOWLIST.find((a) => a.pkg === name);

  if (severity === "critical" || severity === "high") {
    // A high/critical may be allowlisted ONLY when the sole available fix is
    // a breaking major downgrade and the vulnerable path is not exercised
    // (documented per-entry). Otherwise it fails the gate.
    if (match) {
      allowlisted.push({ name, severity, match });
    } else {
      failures.push({ name, severity, isDirect, range: v.range });
    }
    continue;
  }

  if (severity === "moderate") {
    if (isDirect) {
      if (match) {
        allowlisted.push({ name, severity, match });
      } else {
        failures.push({ name, severity, isDirect: true, range: v.range });
      }
    } else {
      warnings.push({ name, severity, range: v.range });
    }
  }
}

let exitCode = 0;

if (failures.length > 0) {
  console.error("❌ audit gate FAIL");
  for (const f of failures) {
    console.error(
      `   ${f.severity} ${f.isDirect ? "DIRECT" : "transitive"}: ${f.name} (${f.range})`,
    );
  }
  console.error(
    "\nFix path: bump the dependency, file a GHSA if non-public, or add to ALLOWLIST with reason + reviewBy.",
  );
  exitCode = 1;
}

const entryProblems = checkAllowlistEntries();
if (entryProblems.length > 0) {
  console.error("❌ audit gate FAIL — allowlist entries:");
  for (const p of entryProblems) console.error(`   ${p}`);
  exitCode = 1;
}

const stale = ALLOWLIST.filter((a) => !Object.prototype.hasOwnProperty.call(vulns, a.pkg));
if (stale.length > 0) {
  console.warn(
    `⚠️  audit gate WARN — ${stale.length} stale allowlist entries (no matching advisory, delete them):`,
  );
  for (const a of stale) console.warn(`   ${a.pkg}`);
}

if (warnings.length > 0) {
  console.warn(`⚠️  audit gate WARN — ${warnings.length} transitive-dep moderate:`);
  for (const w of warnings) {
    console.warn(`   ${w.severity} transitive: ${w.name} (${w.range})`);
  }
}

if (allowlisted.length > 0) {
  console.log(`ℹ️  audit gate INFO — ${allowlisted.length} allowlisted advisories (tracked):`);
  for (const a of allowlisted) {
    console.log(`   ${a.severity} ${a.name} — ${a.match.reason}`);
    console.log(`     reviewBy: ${a.match.reviewBy}`);
  }
}

if (exitCode === 0) {
  console.log("✅ audit gate PASS");
}

process.exit(exitCode);
