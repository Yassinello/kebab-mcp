#!/usr/bin/env node
// Phase 44 SCM-03 — audit policy gate
//
// Policy:
//   FAIL on direct-dep moderate+ unless allowlisted with a tracked justification
//   FAIL on any high/critical severity regardless of scope
//   WARN on transitive-dep moderate (usually can't be fixed without upstream action)
//
// Allowlist entries must cite a GHSA/CVE or equivalent advisory plus a reason
// and a review-by date. The gate prints allowlisted items on every run so they
// stay visible.

import { execFileSync } from "node:child_process";

const ALLOWLIST = [
  {
    pkg: "@browserbasehq/stagehand",
    reason:
      "Transitive via @langchain/core → langsmith (SSRF + prototype pollution + output redaction bypass, 3 moderate advisories). Mitigation: Stagehand 3.2.x is the only installed path and its default call surface does not exercise the vulnerable langsmith code. Allowlist remains until Stagehand upstream ships a clean langchain peer.",
    reviewBy: "2026-10-22",
  },
  {
    pkg: "next",
    reason:
      "Moderate advisory inherited via postcss <8.5.10 (XSS via unescaped </style> in CSS Stringify). Next.js 16.x ships postcss 8.5.6 internally; the vulnerable path requires server-rendered CSS-in-JS with attacker-controlled style strings, which Kebab MCP does not expose (all styles are static Tailwind/PostCSS at build time, never user-controlled). Allowlist until Next.js bumps its bundled postcss; npm audit fix --force would downgrade Next.js to 9.3.3 which would break the entire app.",
    reviewBy: "2026-07-31",
  },
];

function runAudit() {
  try {
    const out = execFileSync(
      "npm",
      ["audit", "--audit-level=moderate", "--omit=dev", "--json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: true },
    );
    return JSON.parse(out);
  } catch (err) {
    if (err.stdout) return JSON.parse(err.stdout);
    throw err;
  }
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
    failures.push({ name, severity, isDirect, range: v.range });
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

if (warnings.length > 0) {
  console.warn(`⚠️  audit gate WARN — ${warnings.length} transitive-dep moderate:`);
  for (const w of warnings) {
    console.warn(`   ${w.severity} transitive: ${w.name} (${w.range})`);
  }
}

if (allowlisted.length > 0) {
  console.log(
    `ℹ️  audit gate INFO — ${allowlisted.length} allowlisted direct-dep moderate (tracked):`,
  );
  for (const a of allowlisted) {
    console.log(`   ${a.name} — ${a.match.reason}`);
    console.log(`     reviewBy: ${a.match.reviewBy}`);
  }
}

if (exitCode === 0) {
  console.log("✅ audit gate PASS");
}

process.exit(exitCode);
