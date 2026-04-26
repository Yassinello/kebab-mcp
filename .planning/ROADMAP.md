# Roadmap: MyMCP

## Current Milestone: v0.9 — Infrastructure & performance

**Started:** 2026-04-16
**Goal:** Replace O(N) KV operations with cursor-based SCAN, add request-level MGET batching, streaming tool responses, structured error types, RSC dashboard migration, dead code CI, coverage reporting, rate limit UI.

### Phase Overview (v0.9)

| # | Phase | Goal | Requirements | SC |
|---|-------|------|--------------|-----|
| 29 | Quick tech wins | Connection pooling verify, dead code CI, test coverage, rate limit UI | POOL, DEAD, COV, RLUI | 4 |
| 30 | KV & performance | SCAN cursor, MGET batching, LogStore SCAN | SCAN, BATCH | 3 |
| 31 | Architecture | Streaming responses, structured errors, RSC migration | STREAM, ERR, RSC | 4 |

## Next Milestone: v0.14 — TBD (not yet scoped). Phase 54 (MCP prompts) + Phase 55 (/config RSC migration) deferred to v0.14 backlog; re-prioritize when operator surfaces a concrete user need.

## Active Phase

### Phase 62: Stabilize Phase 61

**Goal:** Fix two confirmed bugs in the Phase 61 in-dashboard updates feature: (1) GitHub Compare API direction inverted (`main...upstream` returns wrong status semantics), (2) `withAdminAuth` does not include `hydrateCredentialsStep` so KV-saved PAT is invisible to `/api/config/update`. Validate end-to-end on a live Vercel fork before marking Phase 61 done. Correct documentation overstating implementation (e.g., "stored encrypted in KV", "major bump detection").

**Requirements:** STAB-01, STAB-02, STAB-03, STAB-04

**Depends on:** Phase 61

**Plans:** 4 plans

Plans:
- [x] 062-01-PLAN.md — TDD: invert GitHub Compare URL direction (BASE=upstream, HEAD=fork) in route.ts:159 + :219; update 6 mock URL assertions
- [x] 062-02-PLAN.md — Wire hydrateCredentialsStep into /api/config/update via explicit composeRequestPipeline (replaces withAdminAuth) + 1 unit test for credential visibility
- [x] 062-03-PLAN.md — Env-gated live integration test against real GitHub Compare API + tests/integration/README.md env-var index
- [x] 062-04-PLAN.md — Documentation audit: correct "Stored encrypted in KV" copy + add 5-step smoke-test recipe to TROUBLESHOOTING.md + audit Phase 61 SUMMARY for package.json overstatement

### Phase 63: Cron Update-Check

**Goal:** Add a Vercel cron at `/api/cron/update-check` that runs daily, calls the GitHub Compare API, and writes the result to KV under `global:update-check`. The Overview banner reads from KV first (instant load), falls back to live call if KV is empty. Includes a manual Refresh icon (`?force=1`) and "checked Xh ago" freshness indicator.

**Requirements:** CRON-01, CRON-02, CRON-03

**Depends on:** Phase 62

**Plans:** TBD

## Completed Phases (current milestone)

### Phase 61: In-Dashboard Updates

**Goal:** Extend `/api/config/update` with `github-api` mode so Vercel-deployed forks can sync upstream (Yassinello/kebab-mcp) with one click from the admin dashboard. No git CLI required.

**Requirements:** UPD-01, UPD-02, UPD-03, UPD-04, UPD-05

**Plans:** 3 plans

Plans:
- [x] 061-01-PLAN.md — Backend: github-api mode detection, GET/POST handlers, token resolution, breaking-change detection
- [x] 061-02-PLAN.md — UI: enriched overview banner (commits, breaking badge, diverged state, deploying) + Settings PAT configuration section
- [x] 061-03-PLAN.md — Tests: 6 unit test cases for github-api GET and POST handlers

## Archived Milestones

- **v0.13** (2026-04-24, tag `v0.1.13`) — 19 commits across 3 shipped phases (51 Langsmith v3 default + 52 Devices tab + 53 Observability UI). Code review surfaced 2 blockers (device-claim page missing, metrics routes leaked cross-tenant) — both fixed before tag. 994 unit + 51 UI + 16 contract tests. Phases 54-55 deferred to v0.14 backlog.
- **v0.12** (2026-04-21, tag `v0.1.12`) — 45+ commits, 908 unit + 37 UI + 44 registry + 14 contract + 4 Playwright + 19 MCP-resources tests, 5 phases (46 welcome correctness, 47 WelcomeShell wiring 2194→190 LOC, 48 tenant isolation + config facade, 49 T19 4 strict flags, 50 rebrand + coverage + docs + MCP resources). v1.0 rebrand blocker cleared, scorecard 4.0→4.6/5
- **v0.11** (2026-04-21, tag `v0.1.11`) — 40 commits, 765 unit + 37 UI-isolated + 11 contract + 4 Playwright tests, 5 phases (41 pipeline, 42 tenant scoping, 43 perf+CI, 44 supply chain, 45 welcome refactor). Multi-tenant real unlocked, scorecard 3.1→4.0/5
- **v0.10** (2026-04-21) — 48 commits, 554 unit + 13 integration + 4 Playwright + 6 contract tests, 5 phases (37b security hotfix + 37-40)

- **v0.8** (2026-04-16) — 4 commits, 360 tests, 84 tools, 14 connectors
- **v0.7** (2026-04-16) — 11 commits, 337 tests
- **v0.6** (2026-04-15) — 31 commits, 254 tests
- **v0.5** (2026-04-15) — Security, dedup, test coverage
- **v0.4** — Dashboard polish & onboarding
- **v0.3** — The Configurable Server
- **v1.0** — Open Source Framework
