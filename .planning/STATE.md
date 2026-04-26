---
gsd_state_version: 1.0
milestone: v0.9
milestone_name: — Infrastructure & performance
status: Phase 53 closed 2026-04-23.
stopped_at: Completed 062-03-PLAN.md — STAB-03 (env-gated live GitHub Compare integration test + tests/integration/README.md), 2 commits on main
last_updated: "2026-04-26T22:13:20.039Z"
last_activity: 2026-04-23
progress:
  total_phases: 35
  completed_phases: 3
  total_plans: 10
  completed_plans: 23
  percent: 100
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-16)

**Current focus:** **v0.13 milestone in progress** — Phases 51 (Langsmith CVE default-on) + 52 (Devices tab) + **53 (Observability UI expansion)** shipped. Remaining v0.13: 54+ (prompts, alerting) per ROADMAP.
**Next:** v0.13 planning continues OR v0.12 tag (after v0.10.0 GHSA advisory lands).

## Current Position

Phase: **53 complete** — all 6 requirements (OBS-06..11) closed. /config → Health tab now hosts 5 live chart panels (Requests, Latency p95, Error heatmap, Rate-limit, KV quota) plus root-only tenant selector and 60s configurable auto-refresh.
v0.10 + v0.11 + v0.12 milestones complete; **v0.13 in progress** (51, 52, 53 shipped).
Status: Phase 53 closed 2026-04-23.
Last activity: 2026-04-23

## Session Continuity

Phase 53 completed 2026-04-23.

  - 14 commits on main (all green: 994 unit + 51 UI + 44 registry + 16 contract + doc-counts + build + lint + size:check).
    Task-level commit list:
    · 2733364 chore(53): evidence + add recharts@^2.13 + re-baseline bundle gate
    · e78f761 test(metrics): failing tests for aggregation module (RED)
    · b7edd6c feat(metrics): aggregation helpers for requests/latency/errors + source fallback (GREEN)
    · ef82b66 feat(metrics): upstash REST /info client for KV quota reads
    · 1c92faa feat(metrics): /api/admin/metrics/requests + latency + errors routes
    · f0a5891 feat(metrics): /api/admin/metrics/ratelimit + kv-quota routes + shared parseRateLimitKey helper
    · 767e4e1 test(metrics): integration coverage for 5 admin metrics routes
    · 7d49fbb feat(obs-ui): metrics poll hook + tenant selector + refresh controls
    · 19386a5 test(obs-ui): failing tests for chart components (RED)
    · f08fd4a feat(obs-ui): RequestCountChart + LatencyBarChart Recharts components (GREEN)
    · 9c5c4ca feat(obs-ui): ErrorHeatmap SVG grid + RateLimitPanel + KvQuotaPanel
    · 36e692d feat(obs-ui): Health tab metrics section — compose 5 panels + tenant selector
    · b56594a docs(53): CHANGELOG + OPERATIONS guide + .env.example for Phase 53
    · 1505db9 chore(53): contract auto-fixes + metrics hour-boundary test hardening

  - **New primitives:**
    · src/core/metrics.ts — aggregateRequestsByHour / aggregateLatencyByTool /
      aggregateErrorsByConnectorHour (pure) + getMetricsSource (async, buffer/durable).
    · src/core/upstash-rest.ts — thin /info client, 3s AbortSignal timeout, token-sanitized
      error messages, pure parseUpstashUsedBytes helper.
    · src/core/rate-limit.ts::parseRateLimitKey — shared between /api/admin/rate-limits and
      the new /api/admin/metrics/ratelimit. Handles 4/5/6-part key shapes.

  - **5 admin metrics routes:**
    · /requests (24 hourly buckets + ?tool= filter)
    · /latency (top-N p95 by tool)
    · /errors (connector × hour matrix)
    · /ratelimit (live bucket state, masked tenantId)
    · /kv-quota (Upstash /info + 80% warn threshold + Cache-Control 30s)

  - **Dashboard UI:**
    · useMetricsPoll<T> custom hook — no SWR dep added (~90 LOC).
    · TenantSelector / RefreshControls / MetricsSection components.
    · 5 chart panels — RequestCountChart + LatencyBarChart (Recharts) + ErrorHeatmap (SVG)

      + RateLimitPanel + KvQuotaPanel.
    · Health tab mounts <MetricsSection /> below existing OBS-01..05.

  - **Dependency:** recharts@^2.13 (resolved 2.15.4) added with --legacy-peer-deps.

  - **Bundle:** /config first-load JS 544 KB (ceiling re-baselined 600 → 620 KB). Lazy
    Health-tab chunk absorbs Recharts; /config eager bundle barely changes.

  - **Test count:** 954 baseline → 994 unit (+40: 16 metrics + 9 upstash + 15 integration).
    UI 37 → 51 (+14). Contract 14 (unchanged; 2 allowlist entries added).

  - **4 Rule 3 contract auto-fixes** (folded into 1505db9):
    · no-err-ternary: upstash-rest toMsg() + useMetricsPoll inline unwrap.
    · fire-and-forget: 3 `fire-and-forget OK:` annotations in useMetricsPoll.
    · kv-allowlist: metrics/ratelimit added (cross-tenant root-scope escape hatch).
    · no-stray-mymcp: metrics/ratelimit MYMCP_RATE_LIMIT_RPM literal allowlisted.

  - **1 Rule 1 auto-fix:** aggregateRequestsByHour tests pinned to :30 of hour to
    avoid hour-boundary flake when Date.now() fell within first 60-180s of an hour.

  - **1 Rule 2 auto-fix:** config-health-tab.test.tsx extended fetch mock for the 5
    new MetricsSection polls; "active" regex tightened to /^active$/.

  - **1 Rule 3 auto-fix (dep):** @testing-library/dom@^10 re-added after recharts
    install pruned it.

  - BLOCKERS.md filed: none on Phase 53.
  - FOLLOW-UP (pre-existing, unchanged):
    · tests/integration/multi-host.test.ts HOST-05 (Phase 39).
    · tests/integration/welcome-durability.test.ts:328 TS2540 (Phase 42).
    · tests/ui/useMintToken.test.tsx:28 TS2488 (pre-existing testing-library drift).
    · T-LITFB audit (Phase 49 follow-up).

  - FOLLOW-UP (new, deferred from Phase 53):
    · Long-term metrics storage + alerting webhooks + mobile-specific layout (v0.14).
    · Prompts invocation counts in Requests chart (v0.14+).
    · Unify Upstash /info reader with upstash-env getUpstashCreds() (today's /info
      reads UPSTASH_REDIS_REST_* only, not KV_REST_API_*).

Phase 50 completed 2026-04-22. **v0.12 milestone complete.**

  - 15 commits on main (all green: 908 unit + 37 UI + 44 registry + 14 contract + doc-counts + build + tsc + lint).
    Task-level commit list:
    · f5637b1 feat(brand): KEBAB_* env priority + MYMCP_* fallback alias (BRAND-01)
    · 1b9fb03 feat(brand): dual-write kebab_admin_token + mymcp_admin_token cookie (BRAND-02)
    · 8f33d19 feat(brand): OTel span attrs kebab.* with MYMCP_EMIT_LEGACY_OTEL_ATTRS flag (BRAND-03)
    · 807d03e test(contract): no-stray-mymcp prevents new legacy literals (BRAND-04)
    · cebc3e4 chore(cleanup): audit-gate lint + welcome-durability TS + vitest4 poolOptions
    · 2f3d4d7 test(coverage): proxy.ts middleware behavioral test (COV-03)
    · 3d9c473 test(coverage): connector lib backfill — vault/apify/slack/google (COV-04)
    · 66af97f test(coverage): ratchet lines=46 → 50; priority paths ≥ 65% verified (COV-01, COV-02)
    · f029d6d docs(50): CONTRIBUTING coverage philosophy — risk-weighted, not global %
    · f2b8398 docs(api): route-by-route API reference (DOCS-01)
    · 3d3f5ea docs(api): CONNECTOR-AUTHORING walkthrough (DOCS-02)
    · 0576b68 docs(50): README nav + brand sweep (DOCS-03)
    · f31f927 feat(mcp-resources): resources/* capability + Obsidian Vault pilot (MCP-01)
    · 062d060 test(mcp-resources): vault resources round-trip (MCP-02)
    · 0d854ef docs(50): CHANGELOG v0.12 Phase 50 + migration guide

  - **Branding rebrand (v1.0 blocker cleared):**
    · KEBAB_* env priority + MYMCP_* fallback via src/core/config-facade.ts resolveAlias();
      module-level Set<string> dedupe so operators see exactly ONE boot-time warning per
      legacy variable per process. Empty MYMCP_FOO='' does NOT trigger warning (noise-silencing).
    · Admin cookie: setAdminCookies() emits TWO Set-Cookie headers (kebab_admin_token +
      mymcp_admin_token) with identical HttpOnly + SameSite=Strict + Secure attributes.
      readAdminCookie() reads kebab first, legacy with warning. Wired into proxy.ts (Edge)

      + app/welcome/page.tsx isAdminAuthed().
    · OTel: brandSpanAttrs() + brandSpanName() in src/core/tracing.ts; all callers pass
      unprefixed logical names. KEBAB_EMIT_LEGACY_OTEL_ATTRS=1 dual-emits mymcp.* for
      attribute KEYS (span NAMES are single-valued).
    · src/core/constants/brand.ts — BRAND / LEGACY_BRAND / deprecationMsg single source.
    · tests/contract/no-stray-mymcp.test.ts — 53-entry allowlist + budget+1 guard; scans
      src/ + app/ production sources (test files grandfathered, migrations excluded).

  - **Coverage push:**
    · Priority paths all ≥ 65%: auth 97.84% | first-run 93.96% | signing-secret 96.82% |
      kv-store 71.26% | rate-limit 83.63% | credential-store 65.38% | pipeline 100% |
      pipeline/* 97.89%.
    · Global ratchet 46 → 50 in vitest.config.ts (actual 55.01%, +8.6 p.p. aggregate
      since Phase 43 close).
    · tests/core/proxy-behavioral.test.ts — 7 real behavioral scenarios replacing Phase 40
      grep-contract (rehydrate / cookie-auth / early-return / unauthorized /
      legacy-cookie / first-time-setup / showcase-mode).
    · Connector lib backfill (6 new test files, 37 tests): vault/lib/github (17),
      apify/lib/client (9), slack/lib/slack-api (7), google/lib/calendar (4).
    · CONTRIBUTING.md "Coverage philosophy — risk-weighted, not global %" section.

  - **Docs:**
    · docs/API.md 318 lines — all 42 routes grouped by 9 concerns.
    · docs/CONNECTOR-AUTHORING.md 359 lines — 8 steps + appendix.
    · README Documentation index reordered; KEBAB_* env-var table with legacy column.

  - **MCP ecosystem:**
    · src/core/resources.ts registry — ResourceProvider interface,
      registerResources(server, providers), scheme-based dispatch, partial-failure
      tolerant, duplicate-scheme first-wins, graceful SDK-version-skip.
    · src/connectors/vault/resources.ts — Obsidian Vault pilot, vault://<path> URIs,
      path-traversal guard via validateVaultPath, .md-only filter.
    · ConnectorManifest.resources?: ResourceProvider field.
    · app/api/[transport]/route.ts wired.
    · tests/core/resources-registry.test.ts (10) +
      tests/connectors/vault-resources.test.ts (9 round-trip).

  - **Carry-over cleanups (all closed):**
    · A. scripts/audit-gate.mjs no-undef — eslint.config.mjs added override for .mjs.
    · B. welcome-durability.test.ts NODE_ENV TS2540 — cast through Record<string,
      string|undefined>.
    · C. vitest 4 poolOptions deprecation — migrated to top-level forks: {} key.

  - 8 deviations documented in 50-01-SUMMARY.md (6 Rule 3 auto-fixes + 2 judgment calls
    on Task 7 bundling + Task 8 no-redundant-tests).

  - Test count: 815 → 908 (+93). Contract: 13 → 14.
  - Files created: 16 (brand constants, resources registry, vault resources, 7 test
    files, 2 docs, SUMMARY).

  - Files modified: 28 across src/core + app + tests + configs + CHANGELOG + README +
    CONTRIBUTING.

Phase 49 completed 2026-04-22.

  - 10 commits on main (all green: 815 unit + 37 UI + 44 registry + 13 contract + doc-counts + build + tsc + lint).
    Task-level commit list:
    · 9cec16e feat(error-utils): add toMsg(e) helper (TYPE-02)
    · e5bceb2 refactor(49): codemod 65 ternary err-message sites to toMsg (TYPE-02)
    · 5c39ce9 feat(env-utils): add getRequiredEnv helper (TYPE-03)
    · 64e56c9 refactor(49): replace 8 getConfig() bangs with getRequiredEnv (TYPE-03)
    · 28810c5 test(contract): no-err-ternary prevents pattern regression (TYPE-04)
    · e260342 refactor(49): enable noImplicitOverride (TYPE-01a)
    · ff39a3e refactor(49): enable verbatimModuleSyntax + type-import fixes (TYPE-01b)
    · 82d05de refactor(49): enable exactOptionalPropertyTypes + undefined drift (TYPE-01c)
    · 5ad651e refactor(49): enable noUncheckedIndexedAccess + guard indexed access (TYPE-01d)
    · f57b207 docs(49): CHANGELOG v0.12 Phase 49

  - tsconfig.json on main: all 4 strict flags active (noImplicitOverride, verbatimModuleSyntax, exactOptionalPropertyTypes, noUncheckedIndexedAccess). `npx tsc --noEmit` green (only pre-existing welcome-durability TS2540 carry-over).
  - Bisect inventory: 4 distinct tsconfig commits (e260342 / ff39a3e / 82d05de / 5ad651e) — `git bisect` isolates regressions to the specific flag.
  - New helpers: src/core/error-utils.ts (toMsg, 12 unit tests) + src/core/env-utils.ts (getRequiredEnv, 8 unit tests) + scripts/codemod-to-msg.ts (tracked in VCS).
  - Codemod: 45 files touched, 65 rewrites (63 STRICT + 2 WEIRD), 45 imports added. 28 LITERAL-fallback sites intentionally NOT codemodded (T-LITFB follow-up).
  - Bang migration: 8 `getConfig("X")!` sites migrated (7 browser, 1 composio) — matches roadmap estimate exactly. Phase 48 had already routed process.env.X! through getConfig(), so the migration target was the facade-layer bang, not raw process.env.
  - McpConfigError extended backward-compatibly with optional 3rd `connector` arg. Existing getRequiredConfig callers (Phase 48) unchanged.
  - Contract test tests/contract/no-err-ternary.test.ts (Windows-safe fs.readdirSync). 2-entry tight allowlist + stale-entry defensive check.
  - Per-flag error baselines (measured at Task 0): noImplicitOverride=2, verbatimModuleSyntax=10, exactOptionalPropertyTypes=117 src/app (→ 93 files modified), noUncheckedIndexedAccess=145 src/app (→ 70 files modified). All closed.
  - Test count: 793 baseline → 815 (+22: 12 error-utils, 8 env-utils, 2 no-err-ternary contract).
  - 7 deviations documented in 49-01-SUMMARY.md (all Rule 3 codemod auto-fixes + 1 Rule 1 TenantKVStore + 1 pre-existing-state adaptation).
  - FOLLOW-UP:
    · T-LITFB audit (28 literal-fallback ternary sites) — whether `toMsg(err) ?? 'literal'` is strictly better per site.
    · Pre-existing carry-overs unchanged: multi-host HOST-05 (Phase 39), audit-gate.mjs no-undef (Phase 44), welcome-durability TS2540 (Phase 42).

Phase 48 completed 2026-04-22.

  - 10 commits on main (all green: 793 unit + 37 UI + 44 registry + contract + doc-counts + build + tsc).
    Task-level commit list:
    · 3c3cd39 chore(48): evidence — process.env read classification + logging ringbuffer callsites
    · a2a25a1 refactor(logging): ring buffer Map<tenantId, ToolLog[]> with LRU (ISO-01, ISO-03)
    · 2e629fd feat(config-logs): tenant selector + scoped query (ISO-02)
    · 38ab1fd feat(config-facade): getConfig<T> + bootEnv freeze (FACADE-01)
    · c1663ef refactor(48): migrate src/core process.env reads to facade (FACADE-02a)
    · 988650a refactor(48): migrate connector libs process.env reads (FACADE-02b)
    · 848e136 refactor(48): migrate route handlers process.env reads (FACADE-02c)
    · 09a9ead ci(eslint): kebab/no-direct-process-env custom rule + allowlist contract (FACADE-03)
    · 71578a0 feat(config-facade): per-tenant setting overrides (FACADE-04)
    · 8c17864 docs(48): CHANGELOG v0.12 Phase 48

  - New files: src/core/config-facade.ts (~230 LOC), .eslint/rules/no-direct-process-env.mjs + .eslint/plugin-kebab.mjs, 5 new test files (logging-tenant-isolation, config-facade, config-facade-per-tenant, config-logs-route, allowed-direct-env-reads contract, no-direct-process-env RuleTester).
  - Migration: 166 direct process.env reads → getConfig(); residual ALLOWED_DIRECT_ENV_READS allowlist = 10 entries (boot-path only, ≥20 char reasons).
  - Test count: 788 baseline → 793 (+5 new FACADE-01 tests embedded within 8 existing assertions; +7 ISO-03; +4 ISO-02 route; +5 FACADE-04 per-tenant; +5 FACADE-03 contract; RuleTester tested via separate node --test).
  - ESLint rule active: new PRs introducing `process.env.X` outside the allowlist fail lint.
  - 5 deviations documented in the commits:
    · Rule 3: kv-allowlist contract — added src/core/config-facade.ts to ALLOWLIST (getTenantSetting falls back to getKVStore() for root-scope).
    · Rule 3: 4 request-context test-mock fixes (rate-limit-tenant, admin-rate-limits-tenant, backup, tool-toggles) — mocks now export getCredential + runWithCredentials + requestContext.
    · Rule 1: FACADE-03 rule surfaced 5 dynamic-read bugs not caught by initial grep (paywall, credential-store, registry, webhook, config/page) — all migrated.
    · Judgment: getConfig() live-process.env semantic over frozen-bootEnv (SEC-02 guarantee moved to step 1 runWithCredentials); bootEnv retained as advisory snapshot via __getBootEnvSnapshotForTests.
    · Judgment: upstash-env.ts added to allowlist (DUR-06 centralized reader predates facade).

  - FOLLOW-UP (pre-existing, unchanged by Phase 48):
    · tests/integration/multi-host.test.ts HOST-05 failure (Phase 39 carry-over).
    · scripts/audit-gate.mjs no-undef (Phase 44 carry-over).
    · tests/integration/welcome-durability.test.ts:328 TS2540 (Phase 42 carry-over).

Phase 47 completed 2026-04-22.

  - 8 commits on main (all green: npm test:ui + test:integration except pre-existing HOST-05 + build + tsc + regression + contract).
    Task-level commit list:
    · b8a9cca refactor(welcome): wire WelcomeStateContext at WelcomeShell root (dual-path) — WIRE-02
    · 49583a9 refactor(welcome): migrate step-1 storage JSX to steps/storage.tsx — WIRE-01a
    · ee410bc refactor(welcome): migrate step-2 mint JSX to steps/mint.tsx — WIRE-01b
    · ce1fb81 refactor(welcome): migrate step-3 test JSX to steps/test.tsx — WIRE-01c
    · 07fedd0 refactor(welcome): migrate already-initialized panel — WIRE-01d
    · c15edb6 refactor(welcome): retire legacy useState + WelcomeShell ≤ 200 LOC — WIRE-03 + WIRE-04
    · 18abd64 refactor(welcome): welcome-client.tsx shim to page.tsx direct import — WIRE-05
    · dfb1903 docs(47): CHANGELOG v0.12 Phase 47

  - LOC delta: WelcomeShell.tsx 2194 → 190 (-91%); 4 step
    components carrying the real JSX (~1930 LOC total); new
    chrome.tsx module (158 LOC); welcome-client.tsx shim deleted
    (29 LOC).

  - Test count: 801 unit + 37 UI + 59 regression/contract
    (+Phase 45 baseline held). Phase 46 concurrency test 10
    passed (behavioral safety net intact). Playwright E2E
    unchanged.

  - Zero useState in WelcomeShell.tsx verified via
    `grep -cE "^\s*const\s*\[.*\]\s*=\s*useState"` → 0.

  - 4 deviations documented in CHANGELOG:
    · Rule 2: WizardStorageSummary.durable? field widening (mint/
      test persistenceReady reads from reducer).
    · Rule 2: storage-ux.test.ts readClient() + welcome-flow.test.ts
      BUG-04 + fire-and-forget.test.ts allowlist updates for the
      step-file split.
    · Judgment: dual-path during Tasks 1–5 (per ROADMAP YES).
    · Judgment: welcome-client.tsx shim retired (per ROADMAP
      "cleaner import graph").

  - BLOCKERS.md: none on Phase 47.
  - FOLLOW-UP (pre-existing, unchanged by Phase 47):
    · tests/integration/multi-host.test.ts HOST-05 failure
      (Phase 39 carry-over).
    · scripts/audit-gate.mjs no-undef (Phase 44 carry-over).
    · tests/integration/welcome-durability.test.ts:328 TS2540
      (Phase 42 carry-over).

Phase 46 completed 2026-04-21.

  - 8 commits on main (all green: npm test + integration + build + tsc + lint).
    Task-level commit list:
    · 1b5e20e test(integration): real concurrent two-POST-same-cookie race test (CORR-01)
    · 090d11b test(integration): FilesystemKV serialized-race coverage (CORR-02)
    · 672b8e8 test(integration): no-KV mode behavior explicit (CORR-03a)
    · 872e918 test(integration): auto-magic Vercel path mocked (CORR-03b)
    · a3c3019 test(integration): MYMCP_RECOVERY_RESET refuses mint (CORR-03c)
    · 260c758 docs(first-run): degraded-mode contract JSDoc + inline comments (CORR-04)
    · be812eb docs(hosting): degraded-mode contract matrix (CORR-05)
    · 82863f4 docs(46): CHANGELOG — Phase 46 welcome correctness hardening

  - Test count: 801 default + 10 new integration = 811 total (default
    pool unchanged at 801 — new file excluded via vitest.config.ts;
    integration pool gains 10 tests across 5 describe blocks).

  - Key achievements:
    · `tests/integration/welcome-init-concurrency.test.ts` — real
      HTTP-level two-POST-same-cookie concurrent race test using
      Promise.all([POST(req1), POST(req2)]) against a module-mocked
      Upstash backend. Asserts exactly one 200+64-hex token and one
      409 {error:"already_minted"} with no token echo. 5-iteration
      loop catches scheduler artifacts.
    · 5 describe blocks: Upstash-atomic, FilesystemKV serialized,
      no-KV dev mode, auto-magic Vercel (happy + write-fail +
      redeploy-fail), MYMCP_RECOVERY_RESET (=1 refuses + =0 proceeds).
    · JSDoc "Degraded-mode contract" paragraph on
      `flushBootstrapToKvIfAbsent()` with @see
      docs/HOSTING.md#degraded-mode-contract anchor.
    · `app/api/welcome/init/route.ts` 6-line inline comment above
      the flush call summarizing per-backend race protection.
    · `docs/HOSTING.md` new ## Degraded-mode contract section with
      5-row host × backend race-protection matrix + 4 subsections.

  - 3 deviations documented in 46-01-SUMMARY.md:
    · Rule 3: vitest.config.ts default-pool exclude added (reference
      file welcome-mint-race.test.ts's header-comment-only contract
      was insufficient; our file is actually excluded via config).
    · Rule 3: relative-path route import (`@/app/*` alias doesn't
      exist — `@` points at `src/`, app/ uses relative imports).
    · Judgment: ghost-seeded KV to force genuine-race 409 branch.
      Single-claim same-lambda race is the idempotent-retry 200/200
      path (correct production behavior, not a bug). Ghost-seeding
      models the cross-lambda scenario the 409 wiring targets.

  - BLOCKERS.md filed: none on Phase 46.
  - FOLLOW-UP / deferred (pre-existing, NOT introduced by Phase 46):
    · `tests/integration/multi-host.test.ts` — 1 pre-existing Phase 39
      HOST-05 failure (incrCalls count).
    · `scripts/audit-gate.mjs` no-undef (Phase 45 FOLLOW-UP).
    · `tests/integration/welcome-durability.test.ts:328` TS2540
      (Phase 42 carry-over).

Phase 45 completed 2026-04-21.

  - 11 commits on main (all green: tests + lint + build + registry + contract + doc-counts + Playwright E2E 3 passed + 1 skipped).
    Task-level commit list:
    · 9094b7d refactor(welcome): extract welcome-url-parser pure module (UX-02a)
    · c3f4fb2 refactor(welcome): extract wizard-steps pure module (UX-02b)
    · 9a7e8b0 refactor(welcome): extract useClaimStatus / useStoragePolling / useMintToken hooks (UX-02c)
    · 67f013d refactor(welcome): split step components (storage / mint / test / already-initialized) (UX-01a)
    · 37fd1bf refactor(welcome): replace welcome-client body with WelcomeShell orchestrator (UX-01b)
    · [Task 6] UX-03 Playwright E2E smoke — auto-approved per Q1 (3 passed, 1 skipped; no new commit)
    · 866602f test(qa): stabilize 4 flaky render tests via vitest isolation (QA-01)
    · f3c70e6 refactor(qa): resolve 3 v0.10 NITs — migration logger + 3 silent swallows (QA-02)
    · a2160e4 feat(welcome): SETNX on persistBootstrapToKv + 409 for mint-race loser (UX-04)
    · 09a4aad test(integration): welcome-init mint-race regression (UX-04)
    · ee9e73f docs(45): CHANGELOG — Phase 45 welcome refactor + QA polish

  - Test count: 763 → 801 (+38 net). Split: 764 node-env unit + 37 jsdom-isolated UI.
    1 skipped unchanged (stress test).

  - Key achievements:
    · `app/welcome/welcome-client.tsx` 2207 → 29 LOC (shim). Body
      re-homed verbatim in `app/welcome/WelcomeShell.tsx`. Zero
      visual/behavioral regression (Playwright E2E baseline held).
    · Full dormant refactor infrastructure ships: 4 step
      components (steps/storage.tsx, mint.tsx, test.tsx,
      already-initialized.tsx), 3 hooks (useClaimStatus /
      useStoragePolling / useMintToken), 2 pure modules
      (src/core/welcome-url-parser.ts, app/welcome/wizard-steps.ts),
      reducer-backed state context (WelcomeStateContext.tsx).
    · Closes Phase 40 FOLLOW-UP A+B — parallel
      `extractTokenFromInput` re-implementation deleted; wizard
      step ordering + gate predicates now direct truth-table tests.
    · `KVStore.setIfNotExists()` atomic primitive (Upstash SET NX EX

      + FilesystemKV write-queue-serialized + TenantKVStore +
      tracing wrapper). `flushBootstrapToKvIfAbsent()` returns
      race outcome; /api/welcome/init returns 409 `already_minted`
      for the loser without echoing the winner's token. Integration
      test covers winner/loser split + idempotent retry + smoke.
    · `vitest.ui.config.ts` — isolated jsdom fork pool
      (pool:"forks" + singleFork:true + testTimeout:10s). `npm test`
      chains base + UI configs; 2 consecutive green runs establish
      stability (per Q1 directive; 37 UI tests).
    · 3 v0.10 NITs resolved: migration logger uses
      `getLogger("MIGRATION")` (zero console.* remaining);
      admin/health-history stale-sample cleanup logs partial
      failures; cron/health alert swaps console.info for structured
      logger; with-bootstrap-rehydrate cross-references the
      authoritative MIGRATION logger.

  - 9 deviations documented in CHANGELOG + FOLLOW-UP:
    · Rule 2: vitest.ui.config.ts standalone (not mergeConfig)
    · Rule 2: 4 regression test grep-contracts updated to read
      both welcome-client.tsx + WelcomeShell.tsx
    · Rule 2: useStoragePolling `void fetchOnce` annotated
    · Rule 3: vitest 4 `InlineConfig` cast (runtime vs type lag)
    · Rule 3: `@/src/core/...` plan typo → `@/core/...` correct alias
    · Rule 3: pre-existing welcome-durability NODE_ENV TS error
      left as-is (out of scope, logged to deferred-items.md)
    · Judgment: Task 4 ships step components as dormant
      infrastructure (per Q2 answer (a)); Task 5 does verbatim
      file-move to hit ≤ 300 LOC target without regression risk
    · Judgment: FilesystemKV SETNX via write queue (not fs.open
      wx) — dev-only backend, single-map design
    · Judgment: `flushBootstrapToKv()` kept as public export for
      back-compat with existing non-racing callers

  - BLOCKERS.md filed: none on Phase 45.
  - FOLLOW-UP.md items (deferred to v0.12):
    · Full JSX migration from WelcomeShell.tsx into
      app/welcome/steps/*.tsx (incremental, Playwright as safety net)
    · scripts/audit-gate.mjs no-undef lint errors (pre-existing
      Phase 44 — missing eslint env for .mjs)

Phase 44 completed 2026-04-21.

  - 6 commits on main (all green: tests + lint + build + registry + contract + doc-counts + audit-gate).
    Task-level commit list:
    · d957933 refactor(44): extract src/core/url-safety.ts isPublicUrl + consolidate SSRF guards (SCM-05)
    · 11cc628 refactor(44): extract fetchWithTimeout to src/core/fetch-utils + delete 5 duplicates (SCM-05)
    · 6c0c8f0 feat(browser): KEBAB_BROWSER_CONNECTOR_V2 feature flag gating Stagehand v3 (SCM-01)
    · e7b3cc2 test(browser): regression tests for 4 stagehand tools under v2 + v3 (SCM-02)
    · c1f4639 chore(deps): bump @modelcontextprotocol/sdk to ^1.29.0 (SCM-04)
    · 547e4c2 ci(audit): replace high-only gate with scripted direct/transitive policy (SCM-03)
    · 88d56f0 docs(44): Phase 44 CHANGELOG subsection + CONTRIBUTING audit policy

Phase 43 completed 2026-04-21.

  - 8 commits on main (all green: tests + lint + knip + build + registry + contract + doc-counts).
    Task-level commit list:
    · 0a65680 chore(43): baseline bundle sizes + cold-start measurements
    · 96b0550 perf(registry): lazy-load connector manifests in resolveRegistryAsync (PERF-01)
    · 2720d35 perf(dashboard): next/dynamic per /config tab (PERF-02)
    · 53a00fa perf(next): optimizePackageImports for zod + @opentelemetry/api (PERF-04)
    · b1fb3d1 chore(knip): allowlist lint-staged + wait-on; disable husky plugin (CI-03 prep)
    · b76925a ci: bundle-size gate via per-route stats (PERF-05)
    · fcb7bda ci: Node 20 + 22 matrix, coverage ratchet, size:check, un-gated knip (CI-01, CI-02)
    · 9a71a48 ci(dependabot): split security-updates vs version-update (CI-04)

  - Test count: 674 → 686 unit tests (+12). 1 skipped unchanged.
  - Key achievements:
    · `src/core/registry.ts` ALL_CONNECTOR_LOADERS lazy loaders — disabled connectors
      never load manifest modules (PERF-01 runtime win visible in cold-start p50
      -14.1% / -717ms on 20-iteration tsx measurement)
    · `app/config/tabs.tsx` rewritten to 9 `next/dynamic()` imports + 1 eager
      Overview — /config first-load JS 670,098 → 556,171 bytes (-17.0%)
    · `next.config.ts` `experimental.optimizePackageImports: ['zod',
      '@opentelemetry/api']`
    · `scripts/check-bundle-size.ts` (125 LOC) + `.size-limit.json` — bundle-size
      CI gate reading Next's authoritative route-bundle-stats.json
    · `.github/workflows/ci.yml` Node 20+22 matrix, size:check step,
      `continue-on-error: true` removed from knip, echo step deleted
    · `vitest.config.ts` coverage threshold 33 → 46 (ratchet; floor(actual))
    · `.github/dependabot.yml` split: security-updates (daily, 10 cap) +
      version-updates (weekly, 5 cap, grouped typescript/testing/nextjs-core)
    · `tests/core/registry-lazy.test.ts` (8 tests) +
      `tests/contract/registry-metadata-consistency.test.ts` (4 tests)
    · `loadConnectorManifest(id)` escape hatch for setup-wizard
      testConnection on DRAFT credentials (Rule 1 fix during PERF-01)
    · Knip cleanup: lint-staged + wait-on allowlisted; husky plugin disabled

  - 4 deviations documented:
    · Rule 1: setup-test regression for disabled connectors (fixed via
      loadConnectorManifest helper, folded into 96b0550)
    · Rule 1: void logRegistryState() missing DUR-04/05 annotation
      (fixed with comment, folded into 96b0550)
    · Rule 1: size-limit package incompatible with Turbopack
      (replaced with custom check-bundle-size.ts script; package uninstalled)
    · Rule 3: knip false-positives on shell-invoked binaries
      (allowlisted in knip.config.ts; commit b1fb3d1)

  - BLOCKERS.md filed for PERF-03:
    · serverExternalPackages tripled nft.json trace entries (417 → 1574)
      under Turbopack — NOT adopted; revisit when Turbopack matures

  - FOLLOW-UP.md filed with 7 deferred items:
    · PERF-03 retry criteria
    · /config first-load toward 350 KB milestone goal (543 KB achieved)
    · 80% coverage ratchet (46% current)
    · Playwright visual walk for /config tabs
    · Windows coverage file-system race (pre-existing, vitest v8 provider)
    · Next 16 Turbopack build race on Windows (pre-existing)
    · welcome-durability.test.ts TS2540 (pre-existing Phase 42 carry-over)

  - Post-Phase-43 measurements:
    · Cold-start p50: 4374 ms (vs baseline 5091 ms) = -14.1%
    · /config first-load JS: 556,171 bytes (vs baseline 670,098) = -17.0%
    · /welcome first-load JS: 562,347 bytes (unchanged — no tab split)
    · / first-load JS: 517,162 bytes (unchanged)
    · /api/[transport] nft.json: 419 entries (vs baseline 395; +24 for
      lazy-loader metadata, runtime gating is the actual win)

Phase 42 completed 2026-04-21.

  - 6 commits on main (all green: tests + lint + build + registry + contract + doc-counts).
    Task-level commit list:
    · ae8c923 feat(migrations): v0.11 tenant-scope dual-read shim framework (T1+T2, folded)
    · 54188ab refactor(42): tenant-scope rate-limit KV writes (TEN-01) [T3+T4, lock-step]
    · 9db9cd5 refactor(42): tenant-scope log-store (TEN-02)
    · d5423ee refactor(42): tenant-scope tool-toggles (TEN-03)
    · f3ea70b refactor(42): tenant-scope backup export/import (TEN-04)
    · 260ce3b refactor(42): tenant-scope config/context + allowlist shrink (TEN-05, TEN-06)

  - Test count: 635 → 674 unit tests (+39 net). 1 skipped unchanged.
  - Key achievements:
    · `src/core/migrations/v0.11-tenant-scope.ts` — dual-read shim with
      per-tenant `tenant:<id>:migrations:v0.11-tenant-scope` marker
    · 5 files migrated to `getContextKVStore()`:
      rate-limit / log-store / tool-toggles / backup / config/context
    · kv-allowlist shrunk 19 → 15 (4 drops; 1 new migration scanner;
      2 retained with `KV-ALLOWLIST-EXEMPT` rationale comments)
    · BACKUP_VERSION bumped 1 → 2 with cross-tenant contamination guard
    · `?scope=all` root-operator escape hatches on admin/rate-limits + backup
    · 2-tenant integration stitch test
      (`tests/integration/tenant-isolation-v0.11.test.ts`, 327 LOC,
      7 cases, covers all 5 migrated surfaces)

  - 7 deviations documented in 42-01-SUMMARY.md:
    · Rule 3: Task 1 folded into Task 2 (`.planning/` gitignored)
    · Rule 3: Tasks 3+4 folded (rate-limit + admin ship lock-step)
    · Rule 1: 2 pre-existing callsites using old exportBackup signature
    · Rule 3: kv-allowlist regression when shim landed (auto-fix)
    · Judgment: atomic-path dual-read skipped (doc'd)
    · Judgment: ALLOWLIST final = 15, not 13 (escape hatches retained)

  - FOLLOW-UP.md filed with 5 deferred items (in-process ring buffer
    tenant scoping, v0.13 legacy-key DELETE CLI, per-tenant
    MYMCP_LOG_MAX_ENTRIES override, UI tenant selector, pre-existing
    welcome-durability TS error).

Phase 41 completed 2026-04-21.

  - 7 commits on main (all green: tests + lint + build + typecheck).
    Task-level commit list:
    · 0c61e5c feat(pipeline): pipeline core + rehydrateStep + PIPE-06 scaffold (PIPE-01, PIPE-07)
    · 547517f feat(pipeline): 6 remaining steps (auth/rateLimit/firstRunGate/credentials/bodyParse/csrf)
    · d06e9a4 refactor(41): migrate [transport] route to composeRequestPipeline (PIPE-02, PIPE-03)
    · 3c9eaa0 refactor(41): migrate admin/call + welcome/init + storage/status
    · 0c60c12 refactor(41): migrate webhook + cron + welcome/claim — 4 new rate-limit gates (PIPE-04)
    · 0dea40c refactor(41): withAdminAuth HOC + migrate 33 admin/welcome/setup routes (PIPE-05)
    · a5a33cd docs(pipeline): enforce pipeline-coverage contract + CHANGELOG + CONNECTORS.md (PIPE-06)

  - Test count: 554 → 635 (+81 new tests, 1 skipped = pipeline-coverage scaffold in first-commit state)
  - Key achievements:
    · `src/core/pipeline.ts` + 7 step modules + `withAdminAuth` HOC
    · POST-V0.10-AUDIT §B.2 correctness closure: rate-limit buckets now key
      per-tenant via authStep's nested `requestContext.run({ tenantId })`
    · 4 NEW rate-limit gates (webhook/cron/welcome-claim + tenant-aware transport)
    · 6 entry-point routes migrated; 27 admin routes moved to withAdminAuth;
      5 conditional-auth routes moved to partial pipelines
    · pipeline-coverage contract enforced — new app/api routes must compose
      the pipeline or carry a documented `PIPELINE_EXEMPT:` marker
    · T20 fold-in: src/core/first-run.ts:609 module-load side effect removed
    · POST-V0.10-AUDIT §A.1 fold-in: cron/health silent swallow converted
      to log-then-swallow

  - 4 deviations documented in 41-01-SUMMARY.md (all Rule 3 auto-fixes +
    one judgment call on withAdminAuth count).

Phase 40 completed 2026-04-20.

  - 15 commits on main (1 integration test + 1 unit test + 1 E2E spec + 5
    regression test files + 1 package.json + 1 CI workflow + 5 docs).
    Task-level commit list:
    · 92fab64 test(durability): welcome flow across cold lambdas (TEST-01)
    · f203e56 test(durability): async proxy rehydrate (TEST-04)
    · 4c89712 test(e2e): welcome flow + cold-start mid-flow (TEST-02)
    · 11bd33e test(regression): welcome-flow bugs (TEST-03 batch A, BUG-01..BUG-06)
    · c537662 test(regression): storage-ux bugs (TEST-03 batch A.2, BUG-12, BUG-13, BUG-16)
    · e22bad7 test(regression): kv-durability bugs (TEST-03 batch B.1, BUG-07, BUG-08, BUG-14, BUG-15)
    · 80077c9 test(regression): bootstrap-rehydrate bugs (TEST-03 batch B.2, BUG-10, BUG-11)
    · d69d190 test(regression): env-handling bugs (TEST-03 batch B.3, BUG-09, BUG-17)
    · 917a376 chore(test): add test:e2e npm script targeting Playwright (TEST-05)
    · be328d1 ci: Playwright e2e workflow (TEST-05)
    · c234271 docs: troubleshooting page catalogs 17 bugs + 4 security findings (DOC-04)
    · c1c2802 docs(readme): Vercel deploy FAQ (DOC-02)
    · e1c324a docs(claude.md): durable bootstrap pattern section (DOC-01)
    · 58578e2 docs(readme): nav + documentation index (DOC-05)
    · f65735d docs(changelog): finalize v0.10.0 with 37b/37/38/39/40 subsections (DOC-03)

  - All TEST-01..05 + DOC-01..05 requirements closed.
  - Authoritative bug count: 17 (walked from git log cdd3979..4e6fa0c).
    Roadmap's "19 estimate" noted as discrepancy in BUG-INVENTORY.md
    header; housekeeping copy fix filed to FOLLOW-UP for v0.10.1.

  - Test count: 532 → 554 unit (+22), 9 → 13 integration (+4), 0 → 4
    Playwright E2E scenarios (3 pass, 1 skip when MCP_AUTH_TOKEN env
    mismatches between runner and dev server).

  - New artifacts:
    · .planning/phases/40-test-coverage-docs/BUG-INVENTORY.md — walked
      session-bug inventory (17 rows), authoritative for regression
      coverage
    · tests/integration/welcome-durability.test.ts — TEST-01, 4
      scenarios using vi.resetModules + /tmp clearing to simulate
      cross-lambda cold starts
    · tests/core/proxy-async-rehydrate.test.ts — TEST-04, additive
      async-middleware rehydrate coverage
    · tests/e2e/welcome.spec.ts + README.md — TEST-02 Playwright spec
      with cold-start-mid-flow rationale delegation to TEST-01
    · tests/regression/{welcome-flow,storage-ux,kv-durability,
      bootstrap-rehydrate,env-handling}.test.ts + README.md — one
      it() per BUG-NN, covering 17/17
    · .github/workflows/test-e2e.yml — CI for the Playwright suite
    · docs/TROUBLESHOOTING.md — 17 BUG + 4 SEC case studies + 5 FAQ

  - Modified:
    · package.json — test:e2e retargeted to Playwright, legacy
      preserved as test:e2e:legacy
    · playwright.config.ts — new 'e2e' project, 'chromium' alias
      kept, 'visual' unchanged
    · CLAUDE.md — new '## Durable bootstrap pattern' section
    · README.md — top nav + Vercel FAQ + ## Documentation index
    · CHANGELOG.md — v0.10.0 retitled to "Durability audit
      hardening", per-phase subsections 37b/37/38/39/40,
      Fork-maintainer-notes, 17-bug list

  - 3 deviations documented in 40-01-SUMMARY.md:
    · BUG-INVENTORY.md not committed (`.planning/` is gitignored —
      prior-phase convention)
    · Grep-contract regression tests accepted for module-scoped UI
      helpers; follow-up to extract to src/core/
    · Cold-start-mid-flow Playwright scenario delegated to TEST-01;
      documented in tests/e2e/README.md

Exit condition for operator attention:

  1. v0.10 + v0.11 milestones complete — all phases landed.
  2. **v0.12 milestone in progress** — Phases 46 + 47 + 48 + 49 shipped.
     1 phase remains: 50 MyMCP→Kebab rebrand +
     risk-weighted coverage + docs + MCP resources.

  3. GHSA advisory for Phase 37b's SEC-04 finding still needs human
     filing + substitution into docs/SECURITY-ADVISORIES.md +
     CHANGELOG.

  4. v0.10.0 tag can be cut once GHSA lands; v0.11 tag ships next;
     v0.12 tag after all 5 phases close.

  5. Phase 50 entry state (what Phase 49 leaves for the next phase):
     - tsconfig.json on main has all 4 strict flags active:
       noImplicitOverride + verbatimModuleSyntax +
       exactOptionalPropertyTypes + noUncheckedIndexedAccess.
       `npx tsc --noEmit` green (only pre-existing welcome-
       durability TS2540 carry-over remains).

     - src/core/error-utils.ts (toMsg) + src/core/env-utils.ts
       (getRequiredEnv) helpers established. 65 ternary sites
       codemodded to toMsg; 8 getConfig() bangs migrated to
       getRequiredEnv.

     - tests/contract/no-err-ternary.test.ts enforces the
       regression fence. Contract + registry + doc-counts test
       suite baselines unchanged except the new 2 contract tests.

     - McpConfigError extended with optional connector field —
       backward-compatible, existing callers unchanged.

     - 28 LITERAL-fallback ternary sites grandfathered (T-LITFB
       follow-up) — bespoke user-facing strings preserved.

     - 4 bisect-friendly tsconfig commits on main.

## Decisions Made

### Phase 37b / 37 (unchanged)

- HOC over inline rehydrate (Arch-audit §5 pipeline composition) —
  impossible to forget, enables future cross-cutting HOCs to chain.

- `src/core/upstash-env.ts` as a dedicated pure-config module (not
  co-located in kv-store.ts) — arch-audit §6; breaks circular import
  risk from log-store → kv-store → log-store.

- Contract test as the hard gate for DUR-04/05; ESLint advisory
  considered and dropped (flat-config severity-overlap incompatibility
  with SEC-02). Future work: custom ESLint plugin if noise becomes an
  issue.

- `BOOTSTRAP_EXEMPT` marker with ≥20-char reason string — easy to audit
  in code review, single-line.

- 2 FOLLOW-UP routes (auth/google/callback + webhook/[name]) marked
  EXEMPT rather than wrapped to stay within plan inventory scope; both
  have documented reasons valid for v0.10 and v0.11 follow-up paths.

- Preferred UPSTASH_* over KV_* when both set — explicit config wins
  over Marketplace default.

- [Phase 52-devices-tab]: Device KV schema: tenant:<id>:devices:<tokenId> carries label + createdAt only; raw token stays in MCP_AUTH_TOKEN env (single source of truth)
- [Phase 52-devices-tab]: HMAC-signed invite URL with intent=device-invite; single-use nonce via kv.setIfNotExists; 24h TTL overridable via KEBAB_DEVICE_INVITE_TTL_H
- [Phase 52-devices-tab]: admin-devices route rate-limited 10/min/token (vs default 60) — mutating admin ops should not be mass-triggerable from compromised admin token
- [Phase 061]: resolveMode() routes Vercel forks to github-api mode using GitHub Compare + merge-upstream APIs
- [Phase 061]: exactOptionalPropertyTypes forces conditional spread for optional prop assignments in UpdateStatus/UpdateResult setters
- [Phase 061-in-dashboard-updates]: Tests use vi.resetModules() + dynamic import per test to prevent module cache bleed in github-api mode tests
- [Phase 062-stabilize-phase-61 / 062-01]: GitHub Compare API URL semantics are BASE...HEAD; for "fork's position relative to upstream" use compare/${upstream}...main (BASE=upstream, HEAD=fork), NOT compare/main...${upstream}. STAB-01 silent feature failure was caused by this inversion in route.ts:159+219.
- [Phase 062]: Phase 62-04 (STAB-04): UI copy 'encrypted in KV' replaced with 'Upstash KV' (D-12); 5-step Phase-61 smoke-test recipe added to docs/TROUBLESHOOTING.md (D-14, D-15); Phase 61 SUMMARY audited — no overstatement found, audit note added (D-13).
- [Phase 062]: STAB-02 closed: per-route composeRequestPipeline + hydrateCredentialsStep replaces withAdminAuth on /api/config/update; PAT saved via /api/config/env now visible to getCredential() through requestContext.credentials
- [Phase 062]: STAB-03: env-gated live GitHub Compare integration test (describe.skipIf on GITHUB_TEST_TOKEN+OWNER+BEHIND+AHEAD; FORK_IDENTICAL further-gates the identical case). Sanity test always runs and asserts the gate. README.md at tests/integration/ as the env-var index.

### Phase 38 (unchanged)

- Typed `DESTRUCTIVE_ENV_VARS` const array, not a plugin pattern —
  5 entries today; premature abstraction.

- Lazy one-shot startup validation on first `getInstanceConfig()` call,
  not at module scope — avoids test-process pollution.

- `/api/health` hard-cap 1.5s via Promise.race — liveness probes must
  never hang on a slow Upstash; if the budget blows, return
  `kv.reachable: false` instead of waiting.

- OTel `mymcp.kv.key_prefix` captures ONLY the first 2 colon segments
  (e.g. `tenant:alpha`) — no full-key leak in traces.

- Rehydrate counter increments only on KV-hit (not /tmp-hit) — counter
  reflects meaningful cold-start events, not every warm request.

- `getLogger` is a thin `console` facade — no pino dep — keeps
  edge/worker runtime compatibility intact.

- `errorResponse` sanitize() is intentionally conservative.
- `app/config/tabs/health.tsx` allowlisted in fire-and-forget contract
  for `void refresh()` inside `setInterval` — React idiom precedent.

### Phase 39 (brief)

- Docker multi-stage split with dev-deps prune in stage 1 + a SIGTERM
  graceful drain shim — HOST-02.

- Rate-limit in-memory gated behind MYMCP_RATE_LIMIT_INMEMORY=1 —
  HOST-05; default is KV-backed for N-replica correctness.

- MemoryKV integration shim (tests/integration/multi-host.test.ts) —
  zero Docker dependency per phase prompt; models cross-process state
  sharing via a single shared instance reference.

### Phase 43

- **PERF-03 serverExternalPackages DEFERRED** — Turbopack under Next 16 did not
  remove externalized packages from the nft.json trace; enabling the 12-entry
  list tripled `/api/[transport]/route.js.nft.json` entries 417 → 1574.
  Intent was trace-reduction; actual result was trace-regression. Reverted
  in-flight (never committed); documented in BLOCKERS.md with retry criteria.

- **Coverage threshold = 46% (ratchet), NOT 80% (milestone goal)** — actual
  measured coverage is 46.45% lines; floor(actual) locks the ratchet, any
  regression fails CI. 80% goal is a 34-point gap requiring a dedicated
  coverage-ratchet phase in v0.12. Filed to FOLLOW-UP.

- **size-limit package REPLACED with custom script** — Next 16 Turbopack's
  flat, hash-named chunk output defeats size-limit's per-route glob patterns
  (all budgets matched nothing, silent "0 B" pass). `scripts/check-bundle-size.ts`
  reads `.next/diagnostics/route-bundle-stats.json` directly.

- **`loadConnectorManifest(id)` helper added** — setup-wizard's
  `POST /api/setup/test` calls `manifest.testConnection(credentials)` on
  DRAFT credentials BEFORE env vars are persisted. Under PERF-01's gated
  resolve, disabled connectors return a stub manifest without
  `testConnection`. The helper force-loads a manifest regardless of gate
  state (sharing the in-flight dedup Map). Rule 1 regression fix.

- **Two-phase registry resolve design** — gate pass 1 against static
  metadata (toolCount, requiredEnvVars) → load pass 2 via Promise.all on
  the active set. Keeps the module-cache lean.

- **Webhook + Paywall keep manifest-local `isActive(env)`** — 2/14 overshoot
  (load anyway) accepted because the audit showed hoisting the predicate
  to the loader entry would require editing those 2 manifests for marginal
  benefit (~0.5% cold-start overhead).

- **`/config` first-load 543 KB (-17% vs baseline; above 350 KB goal)** —
  remaining 500 KB is Next.js runtime + React + Tailwind shell cost that
  Phase 43's client-side tools can't reduce. Further reduction requires
  architectural work (RSC migration, CSS runtime swap); filed to FOLLOW-UP.

### Phase 42

- Task 1 inventory folded into Task 2 commit — `.planning/` is
  gitignored per prior-phase convention and Phase 42 has no contract
  test scaffold to ship alongside the inventory (unlike Phase 37).

- Tasks 3 + 4 folded into a single TEN-01 commit — rate-limit and
  admin/rate-limits ship lock-step because the Task 3-only commit
  would have left admin/rate-limits reading with the old key shape.

- Atomic `incr` branch in `checkRateLimit` SKIPS `dualReadKV` —
  preserving atomicity defeats the get-then-set race; transient
  bucket-reset over-leniency bounded by 60s TTL is acceptable.

- ALLOWLIST final count = 15 (milestone target was ≤ 13). +2
  overshoot justified: backup.ts retained for `scope="all"` root
  path; admin/rate-limits retained for `?scope=all` query-param
  escape hatch. 1 new entry (v0.11-tenant-scope.ts) mirrors the v0.10
  migration pattern.

- BACKUP_VERSION bumped 1 → 2 with new top-level `scope` field +
  cross-tenant contamination guard: rejects a `scope:"all"` backup
  imported without explicit `opts.scope='all'`.

- FilesystemLogStore path: `data/logs.<tenantId>.jsonl` under a
  tenant context; null tenant keeps legacy `data/logs.jsonl` for
  back-compat on single-tenant deploys.

- In-process ring buffer in `logging.ts` NOT tenant-scoped this
  phase — short-lived buffer; durable path is now correct; filed
  to FOLLOW-UP.

### Phase 40

- Bug count is 17, not 19 — the roadmap's estimate was from session
  memory; `git log cdd3979..4e6fa0c` is authoritative. All downstream
  artifacts use 17.

- Grep-contract regression tests accepted for module-scoped UI
  helpers (extractTokenFromInput, wizard step order) that can't be
  imported without modifying production code. Filed to FOLLOW-UP.

- Cold-start mid-flow E2E scenario delegated to TEST-01's module-reset
  integration test rather than implemented as Playwright. Rationale:
  restarting dev server mid-test is infeasible against user-owned
  `npm run dev` and would corrupt operator dev state.

- CHANGELOG restructure: per-phase `### Phase NN` subsections rather
  than flat v0.10.0 block. Gives forks a clear mental map of what
  each phase delivered.

- Playwright config keeps a `chromium` project alias alongside the
  new `e2e` and `visual` projects so any pre-existing script
  referencing `--project=chromium` still works.

### Phase 47

- **Widen WizardStorageSummary with optional `durable?` field.**
  Mint + test persistenceReady gates need to distinguish durable
  backends (kv OR non-ephemeral file) from acked-ephemeral. Optional
  field preserves `wizard-steps.test.ts` truth-table back-compat.

- **Step-local transients stay as useState, not reducer fields.**
  `copied`, `skipTest`, `storageChecking`, `storageFailures`,
  `upstashCheck*`, `lastCheckOutcome`, StarterSkillsPanel's 5 locals —
  single-consumer UI flags. Hoisting them would grow `WelcomeAction`
  with no cross-step value.

- **Dual-path migration** (ROADMAP judgment: YES). Tasks 1–5 ran
  with BOTH legacy useState chain AND the context provider active.
  Task 6 collapsed to reducer-only. Each per-step commit reverts
  independently.

- **React.lazy on step components NOT applied** (ROADMAP: NO).
  Components are small; lazy adds runtime cost without bundle-size
  win at this scale.

- **`useTestMcp` fetch inline** in steps/test.tsx rather than a
  dedicated hook. No reuse site; premature abstraction.

- **welcome-client.tsx shim retired** (ROADMAP: "cleaner import
  graph"). 29-LOC shim had one consumer; direct import simplifies.

- **Shared step chrome NOT extracted** (Rule 4 → NO deviation):
  StepHeader + StepFooter duplicated in storage/mint/test.tsx (~50
  LOC total) because signatures vary slightly per step. Unifying
  would create higher-friction API than duplication costs.

### Phase 46

- **Ghost-seed the mocked KV to force the 409 branch.** Single-claim
  same-lambda race is the idempotent-retry 200/200 path (correct
  production behavior, not a bug). The 409 branch at route.ts:119
  actually fires when the KV's stored claimId DIFFERS from the
  handler's in-memory activeBootstrap.claimId — i.e. the cross-lambda
  race. Ghost-seeding models this in-process: seed a bootstrap entry
  with a mismatched claimId, fire two validly-signed concurrent
  POSTs, both hit the genuine-race branch, exactly one wins the
  idempotent-retry adoption and one returns 409.

- **vi.mock at module boundary** (`@/core/kv-store` + `@/core/env-
  store`) — simpler than fetch() interception, enables direct
  assertion on the vars object passed to getEnvStore().write().

- **New file explicitly excluded from default `npm test` pool via
  vitest.config.ts.** Phase 45's welcome-mint-race.test.ts only
  documented the exclusion in a file-header comment; verification
  showed the file actually runs under both pools. For Phase 46
  correctness we enforce via config (exclude array). Phase 45 file
  left unchanged.

- **Route-level testing via imported POST export** (JC-1). The
  composed pipeline is the exact function Next.js calls; response
  bodies + status codes are equivalent to an HTTP round-trip.
  Avoids Next.js server startup cost + orthogonal flake surface.

- **FilesystemKV cross-process race OUT OF SCOPE** (JC-2). Documented
  inline in the test describe block + in docs/HOSTING.md.

- **Auto-magic Vercel stubbed at env-store module boundary** (JC-3).
  writeMock value-equality asserts `{ MCP_AUTH_TOKEN: body.token }`
  — closes the "does auto-magic actually write the right token" gap.

## Blockers

None on Phase 47.

SEC-04 GHSA advisory still needs human filing + advisory ID
substitution into docs/SECURITY-ADVISORIES.md + CHANGELOG before v0.10.0
tag can ship. This is a Phase 37b carry-over, not a Phase 40 blocker.

## Metrics

| Phase | Duration | Commits | Tests added | LOC Δ |
|-------|----------|---------|-------------|-------|
| 37b   | 1 day    | 9       | 28          | ~700  |
| 37    | 1 day    | 8       | 20          | ~600  |
| 38    | 1 day    | 10      | 48          | ~1600 |
| 39    | 1 day    | 6       | 9           | ~900  |
| 40    | 1 day    | 15      | 26          | ~1900 (tests+docs only) |
| **v0.10 total** | **5 days** | **48** | **131** | **~5700** |
| 41    | 1 day    | 7       | 81          | ~3500 |
| 42    | 1 session | 6      | 39          | ~1100 (incl. ~800 tests) |
| 43    | 1 session | 8      | 12          | ~1400 (registry refactor + CI) |
| 44    | 1 session | 7      | 16          | ~800 (security gate + URL safety) |
| 45    | 1 session | 11     | 38          | ~3400 (welcome refactor + mint-race + QA polish) |
| **v0.11 total** | **~5 sessions** | **39** | **186** | **~10,200** |
| 46    | 1 session | 8       | 10 (integration) | ~460 (tests + docs only) |
| 47    | 1 session | 8       | 0 (no new tests; grep-contract updates + allowlist) | WelcomeShell 2194 → 190 LOC; steps/*.tsx 351 → ~1930 LOC; chrome.tsx new (158 LOC); shim deleted (29 LOC) |
| 48    | 1 session | 10      | 34 (FACADE-01..04 + ISO-01..03 + contract + RuleTester) | ~1600 (config-facade 230 + migration 166 reads + 5 tests + ESLint rule + per-tenant) |
| 49    | 1 session | 10      | 22 (12 error-utils + 8 env-utils + 2 no-err-ternary contract) | 65 ternary rewrites across 45 files + 117 exactOptional fixes across 93 files + 145 noUnchecked fixes across 70 files + 8 bangs migrated + 4 strict flags in tsconfig |
| 53    | 1 session | 14      | 54 (16 metrics + 9 upstash + 15 integration + 14 UI) | src/core/metrics.ts (pure aggregators) + src/core/upstash-rest.ts + 5 metrics routes + MetricsSection + 5 chart panels + useMetricsPoll hook + parseRateLimitKey shared helper + Recharts 2.15 added (bundle 544 KB under re-baselined 620 KB) + docs/OPERATIONS.md |

## Last session

Stopped at: Completed 062-03-PLAN.md — STAB-03 (env-gated live GitHub Compare integration test + tests/integration/README.md), 2 commits on main
Ready for: 062-02-PLAN.md (wire hydrateCredentialsStep into /api/config/update via explicit composeRequestPipeline — STAB-02). Phase 62 plan progress: 1/4 complete. Pre-existing follow-ups unchanged: multi-host HOST-05, audit-gate.mjs lint, welcome-durability TS2540, useMintToken TS2488 (still pre-existing in tests/ui/useMintToken.test.tsx:28), T-LITFB audit.
