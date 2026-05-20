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
// and a review-by date. The gate prints allowlisted items on every run so they
// stay visible. Allowlisting a high/critical is a deliberate risk-acceptance —
// keep the reason specific (why the vulnerable code path is unreachable) and the
// reviewBy short.

import { execFileSync } from "node:child_process";

const ALLOWLIST = [
  {
    pkg: "@browserbasehq/stagehand",
    reason:
      "HIGH inherited via @langchain/core → langsmith (GHSA-3644-q5cj-c5c7 untrusted prompt-manifest deserialization, plus 3 moderate langsmith advisories: SSRF GHSA-v34v-rq6j-cj6p, prototype pollution GHSA-fw9q-39r9-c252, output-redaction bypass GHSA-rr7j-v2q5-chgv). Mitigation: the only fix npm offers is a MAJOR downgrade to Stagehand 2.5.8, which would break the browser connector (web_browse/act/extract/observe/agent + linkedin_feed). Stagehand 3.2.x pulls langsmith transitively but Kebab never calls LangSmith tracing or prompt-pull — the vulnerable code paths (LangSmith client SDK) are not exercised. Allowlist until Stagehand upstream ships a clean @langchain/core peer.",
    reviewBy: "2026-08-20",
  },
  {
    pkg: "@langchain/core",
    reason:
      "HIGH — transitive parent of langsmith (see @browserbasehq/stagehand entry). Same advisory chain (GHSA-3644-q5cj-c5c7). Pulled in only via Stagehand 3.2.x; Kebab does not import @langchain/core directly and never invokes LangSmith. Fixable only by the breaking Stagehand 2.5.8 downgrade. Tracked with the Stagehand entry.",
    reviewBy: "2026-08-20",
  },
  {
    pkg: "langsmith",
    reason:
      "HIGH GHSA-3644-q5cj-c5c7 (public prompt pull deserializes untrusted manifests) + moderates. Transitive via @langchain/core via Stagehand. Kebab never calls the LangSmith SDK (no tracing client, no prompt pull), so the vulnerable surface is unreachable. Fix = breaking Stagehand 2.5.8 downgrade. Tracked with the Stagehand entry.",
    reviewBy: "2026-08-20",
  },
  {
    pkg: "@opentelemetry/sdk-node",
    reason:
      "HIGH inherited via its bundled @opentelemetry/exporter-prometheus (GHSA-q7rr-3cgh-j5r3 — Prometheus exporter process crash on malformed HTTP request). Kebab uses the OTLP-HTTP trace exporter (@opentelemetry/exporter-trace-otlp-http / OTLPTraceExporter in src/core/tracing.ts) and NEVER instantiates the Prometheus exporter — verified by grep: zero references to exporter-prometheus / PrometheusExporter in src or app. The vulnerable HTTP listener is never started. Only fix is a MAJOR bump to sdk-node 0.218.0 which churns the whole OTel peer set; deferred. Tracing is also opt-in (off unless OTEL_SERVICE_NAME is set).",
    reviewBy: "2026-08-20",
  },
  {
    pkg: "@opentelemetry/exporter-prometheus",
    reason:
      "HIGH GHSA-q7rr-3cgh-j5r3 — the vulnerable package itself, pulled in transitively by @opentelemetry/sdk-node. Kebab never imports or starts the Prometheus exporter (OTLP-HTTP only). Unreachable. Tracked with the sdk-node entry.",
    reviewBy: "2026-08-20",
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
