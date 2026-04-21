# Changelog

All notable changes to Kebab MCP.

## [0.10.0] — Unreleased — Security hotfix (SEC-01..06)

Expedited security release closing four findings from the 2026-04-20
deep risk audit (`.planning/research/RISKS-AUDIT.md`). See
`docs/SECURITY-ADVISORIES.md` for the full advisory index and
disclosure timeline.

### Security

- **SEC-04 (GHSA pending)** — First-run claim-cookie HMAC signing
  secret was previously derived from `VERCEL_GIT_COMMIT_SHA`, a public
  value. An attacker who could read the commit SHA (trivial on public
  GitHub repos and Vercel preview URLs) could forge a valid claim
  cookie and hijack `/api/welcome/init` on any fresh public Vercel
  deploy that had not yet completed welcome bootstrap. The signing
  secret is now `randomBytes(32)`, KV-persisted at
  `mymcp:firstrun:signing-secret`, and rotated on
  `MYMCP_RECOVERY_RESET=1`. A private GHSA advisory has been filed;
  advisory ID will be added here on publication.
- **SEC-05** — On public Vercel deploys with no durable KV configured
  and `MYMCP_ALLOW_EPHEMERAL_SECRET` unset, the welcome routes now
  refuse to mint claims and return HTTP 503 with an actionable operator
  error. Prevents the no-KV silent-takeover class of vulnerability.
- **SEC-01** — Cross-tenant KV data leak. Connector code paths
  (skills, credentials, webhooks, health samples, admin rate-limit
  scan) previously bypassed `TenantKVStore` by calling the untenanted
  `getKVStore()` directly. All refactored to `getContextKVStore()`;
  contract test `tests/contract/kv-allowlist.test.ts` enforces
  going forward. `health:sample:*` gained a 7-day TTL.
- **SEC-02** — `process.env` is no longer mutated at request time.
  Credential hydration now populates a module-scope snapshot consumed
  by a new `getCredential(envKey)` helper that reads through
  request-scoped `AsyncLocalStorage`. Fixes concurrent-request
  torn-write races on warm lambdas. Connectors still reading
  `process.env.X` directly will see the boot-time snapshot only
  (v0.10) — migrate to `getCredential()` before v0.11 (see Breaking).
- **SEC-03** — `/api/admin/call` now wraps tool invocations in
  `requestContext.run({ tenantId })` matching the MCP transport. Tool
  calls from the dashboard playground respect the `x-mymcp-tenant`
  header.
- **SEC-06** — This CHANGELOG, `docs/SECURITY-ADVISORIES.md`, and
  the GHSA draft document the disclosure timeline.

### Breaking (connector authors)

- `process.env.X` reads from within tool handlers now see the
  **boot-time snapshot** only. Request-scoped credential overrides
  (dashboard saves, per-tenant creds) require migrating to
  `getCredential("X")` from `@/core/request-context`. Back-compat is
  preserved for v0.10.x; v0.11 adds an ESLint rule enforcing the
  migration.
- A `no-restricted-syntax` ESLint rule now blocks
  `process.env[...] = ...` assignments outside the allowlisted boot
  path (`src/core/env-store.ts`, `scripts/`, `tests/`). Use
  `runWithCredentials()` instead.

### Added

- `src/core/signing-secret.ts` — KV-backed signing secret with
  `getSigningSecret()`, `rotateSigningSecret()`,
  `SigningSecretUnavailableError`.
- `src/core/request-context.ts` — `getCredential()`,
  `runWithCredentials()`, frozen boot-env snapshot.
- `tests/contract/kv-allowlist.test.ts` — grep-style enforcement for
  `getKVStore()` callsite allowlist.
- `tests/contract/process-env-readonly.test.ts` — grep-style defense
  in depth on top of the ESLint rule (see SEC-02-enforce).
- `MYMCP_ALLOW_EPHEMERAL_SECRET=1` env var — explicit opt-in to
  `/tmp`-seed signing secret for local dev without Upstash.
- Data migration on first boot: legacy `cred:*` and `skills:*` KV
  keys from pre-v0.10 deploys are copied into the default-tenant
  namespace (see `src/core/migrations/v0.10-tenant-prefix.ts`),
  preserving existing single-tenant deploys.

### Deferred to v0.11+

Documented in `.planning/phases/37b-security-hotfix/FOLLOW-UP.md`:

- `src/core/rate-limit.ts`, `src/core/log-store.ts`,
  `src/core/tool-toggles.ts`, `src/core/backup.ts`,
  `app/api/config/context/*` tenant-scoping
- `langsmith` transitive CVEs via Stagehand
- Welcome-init race (two browsers racing the same claim cookie)
- Unbounded `health:sample:*` growth (folded in partially — 7d TTL
  added now; broader observability work in Phase 38)
- `log-store.ts:319` 5xx retry heuristic (Phase 38)

### Durability hardening (Phase 37, non-breaking)

Preventive pass closing the class of bugs shipped by the 2026-04-20
debugging session (see `.planning/milestones/v0.10-durability-ROADMAP.md`
§Phase 37). Seven atomic commits, three contract tests, no breaking
changes for connector authors or operators.

- **DUR-01 / DUR-02 / DUR-03** — Every auth-gated API route now wraps
  its exported HTTP-verb handlers in
  `withBootstrapRehydrate(handler)` from
  `src/core/with-bootstrap-rehydrate.ts` (new). The HOC awaits
  `rehydrateBootstrapAsync()` at entry, so cold lambdas that respond
  to MCP / dashboard / welcome traffic always see bootstrap state
  rehydrated from /tmp or KV before reading `MCP_AUTH_TOKEN`. 35
  routes wrapped; 4 routes (`/api/health`, `/api/cron/health`,
  `/api/auth/google/callback`, `/api/webhook/[name]`) carry a
  `// BOOTSTRAP_EXEMPT: <reason>` marker. The new contract test
  `tests/contract/route-rehydrate-coverage.test.ts` fails the build
  if a future route lands without the wrapper or exemption.
- **DUR-04 / DUR-05** — Every `void <promise>()` callsite in `src/`
  is either awaited, wrapped in an annotated janitor path, or
  deleted. Most notably `src/core/first-run.ts:312`
  `void persistBootstrapToKv(activeBootstrap)` — the original
  session-bug root cause (Vercel's reaper killed the write before
  Upstash SET landed) — is DELETED along with the now-unused
  `persistBootstrapToKv()` helper. The authoritative persistence
  path is `flushBootstrapToKv()`, awaited by the welcome routes.
  Remaining janitor / cleanup calls carry
  `// fire-and-forget OK: <reason>` annotations. Enforced by
  `tests/contract/fire-and-forget.test.ts` (grep-based, cannot be
  bypassed via `eslint-disable`).
- **DUR-06 / DUR-07** — Upstash REST credential reads centralize
  behind `getUpstashCreds()` / `hasUpstashCreds()` in
  `src/core/upstash-env.ts` (new, pure config, no I/O). The helper
  supports both `UPSTASH_REDIS_REST_*` (manual Upstash setup) and
  `KV_REST_API_*` (Vercel Marketplace auto-inject) naming variants,
  preferring UPSTASH_* when both are set. Nine previously-divergent
  callsites are migrated (kv-store, log-store, storage-mode,
  credential-store, first-run, first-run-edge, signing-secret,
  skills/store, storage/status route). `.env.example` documents both
  naming variants with an operator-facing comment block. Contract
  test `tests/contract/upstash-env-single-reader.test.ts` enforces
  the single-reader invariant going forward.
- **ARCH-AUDIT fold-in** — The module-load disk-I/O side effect at
  `first-run.ts:422` (ran the v0.10 tenant-prefix migration on every
  `rehydrateBootstrapAsync()` call, making test order depend on
  file-system state) is eliminated. The migration now fires once per
  process from inside the `withBootstrapRehydrate` HOC, gated by an
  in-process one-shot flag.

No breaking changes. Operators see identical behavior; connector
authors see no API surface shifts. Phase 37 ships mergeable independent
of Phases 38-40 (safety/observability, multi-host, tests/docs).

### Safety & observability (Phase 38, non-breaking)

Visibility + foot-gun prevention pass. Every surface added in Phase 38
is additive — existing payload fields remain; operators see identical
behavior unless a destructive env var is actively wiping state (in
which case they now see the warning).

- **SAFE-01 / SAFE-04** — Destructive env-var registry
  (`src/core/env-safety.ts`). Typed constant `DESTRUCTIVE_ENV_VARS`
  enumerates every env var with a destructive side-effect (initial
  set: `MYMCP_RECOVERY_RESET`, `MYMCP_ALLOW_EPHEMERAL_SECRET`,
  `MYMCP_DEBUG_LOG_SECRETS`, `MYMCP_RATE_LIMIT_INMEMORY`,
  `MYMCP_SKIP_TOOL_TOGGLE_CHECK`). Startup validation runs on the
  first `getInstanceConfig()` call: warn-severity vars log to
  `console.warn`; reject-severity vars + `NODE_ENV=production`
  refuse to boot (`process.exit(1)`). The registry is extensible
  via a PR adding a row — no plugin API.
- **SAFE-02 / SAFE-03** — Destructive vars surface as a public
  warning. `/api/health` returns a `warnings[]` array when a
  destructive var is active in a non-allowed `NODE_ENV`. `/config`
  renders a red dashboard-wide banner with the var name + operator-
  facing effect description. Happy path stays clean: both surfaces
  omit the warning when no destructive var is set.
- **OBS-01** — `/api/health` enriched with `bootstrap.state`,
  `kv.reachable` (1s-capped ping), `kv.lastRehydrateAt` (ISO string
  or `null`). Handler has a hard 1.5s overall budget via
  `Promise.race`. Zero secret / env-value leak verified by test.
- **OBS-02** — `/api/admin/status` gains a `firstRun` section:
  `rehydrateCount` (total + last-24h sliding window, KV-persisted at
  `mymcp:firstrun:rehydrate-count`), `kvLatencySamples` (in-process
  ring buffer, size 20, populated by `pingKV` and future per-op
  hooks), `envPresent` (boolean-only map for every `WATCHED_ENV_KEYS`
  entry — union of destructive vars, core infra, runtime hints).
- **OBS-03** — Structured logger facade `getLogger(tag)` in
  `src/core/logging.ts`. New tags: `[FIRST-RUN]`, `[KV]`, `[WELCOME]`,
  `[CONNECTOR:skills]`, `[LOG-STORE]`, `[API:<route>]`, `[TOOL:<name>]`.
  Every try/catch in `src/core/first-run*.ts`, `src/core/kv-store.ts`,
  and `app/api/welcome/**/route.ts` either logs, rethrows, returns, or
  carries a `// silent-swallow-ok: <reason>` annotation. Enforced by
  `tests/contract/no-silent-swallows.test.ts` — regex-based, same
  pattern as the DUR-04/05 fire-and-forget contract.
- **OBS-04** — OTel spans on the three hot paths:
  `mymcp.bootstrap.rehydrate`, `mymcp.kv.write`, `mymcp.auth.check`.
  KV span attributes capture only the first 2 colon segments of the
  key (e.g. `tenant:alpha` from `tenant:alpha:skills:foo`) — no
  full-key leak in traces. Zero overhead when `OTEL_EXPORTER_OTLP_ENDPOINT`
  is unset. New helpers: `startInternalSpan`, `withSpan`, `withSpanSync`.
- **OBS-05** — `/config` gains a Health tab (`app/config/tabs/health.tsx`)
  rendering the combined live state from `/api/health` +
  `/api/admin/status`: bootstrap badge, KV block, rehydrate counter,
  KV latency samples table, env presence checklist, warnings list.
  Auto-refreshes every 15s. Gracefully shows "admin auth required"
  when /api/admin/status returns 401 (welcome-first-user path).

Fold-ins from the milestone's "Deferred findings" section:

### Fixed (Phase 38 fold-ins)

- **P0** — `UpstashLogStore` circuit-breaker (`src/core/log-store.ts`)
  no longer trips on any error message containing the digit "5".
  New `extractHttpStatus(err)` helper parses an actual 3-digit HTTP
  status code from the error message; the breaker opens only on
  `500 ≤ status < 600`. Regression test:
  `tests/core/log-store-retry.test.ts`.
- **P1** — `listSkillsSync()` (`src/connectors/skills/store.ts`) no
  longer silently returns `[]` on filesystem errors. Now logs via
  `[CONNECTOR:skills]` before returning the empty fallback. Hides no
  bugs; breaks no existing code paths.
- **P1** — `/api/config/env` (GET + PUT 500 paths) and
  `/api/config/update` (POST 500 path) no longer leak `err.message`
  to the client. New canonical response shape
  `{ error: "internal_error", errorId, hint }` via
  `src/core/error-response.ts`. Server-side log retains the full
  sanitized error + `errorId` under the `[API:<route>]` tag for
  operator correlation.
- **T10** — `MYMCP_TOOL_TIMEOUT` is now enforced at the transport.
  `getToolTimeout()` was defined but never called pre-v0.10 —
  hanging tools ran until Vercel's 60s lambda reap, returning an
  opaque 504. Now wired into `withLogging` via `Promise.race`; a
  slow handler returns an `MCP tool error` with
  `errorCode: "TOOL_TIMEOUT"` and logs under `[TOOL:<name>]`.

## [0.1.0] - 2026-04-18 — Stabilization release

This is the consolidated v0.1.0 release: the project was internally
versioned up to v0.3.5 during pre-OSS development but `package.json`
was reset to v0.1.0 (commit `87985d6`) to mark the open-source launch
baseline. Everything described under the "Pre-stabilization development
log" section below was rolled into this release; it is the first
version intended for public consumption.

### Known limitations

- **MCP SDK pinned at 1.26**: `mcp-handler@1.1.0` hard-pins
  `@modelcontextprotocol/sdk@1.26.0` as a peer dependency, so the
  bump to SDK 1.29 was reverted. Tracked: revisit when `mcp-handler@1.2+`
  ships (likely soon — the SDK has had 3 patch releases since).
- **3 residual moderate vulnerabilities** in the stagehand → langchain
  transitive chain (`langsmith`, `@langchain/core`, `@browserbasehq/stagehand`
  parent advisory). Cannot patch without semver-major regression of the
  browser connector. Tracked: revisit on next stagehand release.
  Audit-level=high CI gate is unaffected.

### Renamed

- **Project renamed**: MyMCP → **Kebab MCP**. Display strings, docs, package names (`kebab-mcp`, `@yassinello/create-kebab-mcp`), Docker compose service name, MCP client config snippet keys all updated. **Internal identifiers preserved** (`MYMCP_*` env var prefix, KV key prefixes, cookie names, `x-mymcp-tenant` header, `mymcp_admin_token` cookie) so existing deployments keep working with no env-var changes. New users get clean naming everywhere they look; legacy users get zero-disruption migration.

### Added

- `.husky/pre-commit` now blocks accidental commits of `.env`, `.env.local`, `.env.vercel`, etc. (the `.env.example` template stays whitelisted). Closes audit R6.
- `CODE_OF_CONDUCT.md` adopting the Contributor Covenant 2.1 by reference, with a project-specific reporting contact and enforcement statement. Linked from `CONTRIBUTING.md`. Closes audit R1.
- User-facing GitHub issue templates: `bug_report.yml`, `feature_request.yml`, `config.yml` (disables blank issues, surfaces SECURITY.md and Discussions). The existing dev templates (`new-connector.md`, `new-tool.md`) are preserved unchanged. Closes audit R2.
- `SECURITY.md` gains a "Token rotation" section walking through Vercel multi-token zero-downtime, Docker, and local dev rotation flows with concrete commands and verification steps. Closes audit C3 procedural follow-up.

### Security

- **Resolved 3 dependency vulnerabilities** via `npm audit fix`:
  - `protobufjs` 7.5.4 → 7.5.5 — **CRITICAL** arbitrary code execution (GHSA-xq3m-2v4x-88gg), pulled by `@browserbasehq/stagehand → @google/genai` and by `@opentelemetry/exporter-trace-otlp-http`
  - `basic-ftp` 5.2.2 → 5.3.0 — **HIGH** DoS via unbounded memory in `Client.list()`, pulled via `stagehand → puppeteer-core → proxy-agent`
  - `hono` 4.12.12 → 4.12.14 — moderate JSX SSR HTML injection, pulled via `mcp-handler → @modelcontextprotocol/sdk`
- `npm audit --audit-level=high` (the CI gate) now exits 0 again
- **Recommended**: rotate your `MCP_AUTH_TOKEN` if you've shared this repo or your `.env` file with anyone (audit hygiene; no leak detected — verification confirmed `.env` was never in git history)

### Changed

- 11 minor dependency bumps surfaced by `npm outdated`:
  - **Production**: `next` 16.2.3 → 16.2.4, `react` + `react-dom` 19.2.4 → 19.2.5, `@opentelemetry/exporter-trace-otlp-http` + `@opentelemetry/sdk-node` 0.214 → 0.215
  - **Dev**: `typescript` 6.0.2 → 6.0.3, `eslint` 10.2.0 → 10.2.1, `prettier` 3.8.2 → 3.8.3, `fast-check` 4.6 → 4.7, `@types/node` 25.5 → 25.6, `typescript-eslint` 8.58.1 → 8.58.2

---

## Pre-stabilization development log

The entries below document per-patch development history during the
private build-out (April 2026). These versions were never published as
separate releases — `package.json` was at `0.1.0` throughout. They are
preserved for git-log cross-reference; the public v0.1.0 release above
supersedes them.

## [0.3.4] - 2026-04-14

### Added

- **Vercel auto-magic mode** — when `VERCEL_TOKEN` and `VERCEL_PROJECT_ID` are configured, `/api/welcome/init` now also writes the minted `MCP_AUTH_TOKEN` to Vercel via REST API and triggers a production redeploy. The welcome page shows a 3-step progress UI ("Token generated → Written to Vercel → Redeploying...") and the dashboard becomes permanent without any manual paste step. Falls back gracefully to manual paste when unavailable. Same auto-magic path is wired into the dry-run banner's "Generate token" CTA.
- **Setup health widget** in the dashboard overview tab — shows token status (Permanent / Bootstrap / Unconfigured), Vercel auto-deploy availability, and the instance endpoint at a glance. New endpoint `GET /api/config/health` (admin auth).
- **Dry-run dashboard mode** — claim-cookie holders can navigate to `/config` directly from the welcome page (via "Or explore the dashboard first →" link) to configure connectors before minting a token. A sticky amber banner appears across all dashboard pages reminding them to generate the token, with an inline "Generate token" CTA that triggers the welcome init flow.
- **Recovery escape hatch** — set `MYMCP_RECOVERY_RESET=1` in env vars and redeploy to wipe stale bootstrap state when locked out. Surfaced via a subtle expandable footer on the welcome page.
- **Optional KV cross-instance bootstrap persistence** — when an external KV store is configured (Upstash, or off-Vercel filesystem KV), bootstrap state is mirrored to the same KV abstraction used by rate-limit so cold-starts on different instances re-hydrate the same claim. Falls back transparently to /tmp-only persistence on Vercel without Upstash.
- **End-to-end integration tests** for the welcome flow covering happy path, locked-out visitor, forged cookies, MCP endpoint guard, recovery reset, and auto-magic mode (mocked Vercel API).

### Changed

- `app/api/welcome/{claim,init,status}/route.ts` now `await rehydrateBootstrapAsync()` at handler entry to pull KV state when available.
- `__internals` no longer exposes `COOKIE_NAME` and `CLAIM_TTL_MS` — they're proper exports as `FIRST_RUN_COOKIE_NAME` and `CLAIM_TTL_MS`.
- `first-run.ts` now logs structured `[Kebab MCP first-run]` info messages on claim creation, bootstrap mint, and re-hydration for production observability.
- Vitest config now runs test files sequentially (`fileParallelism: false`) to avoid races on shared OS `/tmp` paths used by the first-run bootstrap state.

## [0.3.3] - 2026-04-14

### Added

- **Zero-config Vercel onboarding** — the "Deploy to Vercel" button no longer requires `MCP_AUTH_TOKEN` or `MYMCP_DISPLAY_NAME` to be filled in upfront. After deploy, visitors are routed to a new `/welcome` page that mints a permanent token via an in-memory bridge (process.env mutation + `/tmp` persistence + signed first-run claim cookie), so the dashboard works immediately on the same instance. The page then walks the user through pasting the token into Vercel and redeploying for permanence, and polls `/api/welcome/status` to detect when the env var is set "for real."
- New module `src/core/first-run.ts` exposing `isFirstRunMode`, `isBootstrapActive`, `getOrCreateClaim`, `isClaimer`, `bootstrapToken`, `clearBootstrap`, and `rehydrateBootstrapFromTmp`.
- New API routes: `/api/welcome/claim`, `/api/welcome/init`, `/api/welcome/status`.
- Shared `src/core/request-utils.ts` with `isLoopbackRequest` (extracted from `app/api/setup/save/route.ts`).

### Security

- **Closed the first-run admin auth bypass** — `checkAdminAuth` previously returned `null` (open access) whenever no admin token was configured, leaving fresh public Vercel deploys exposed. It now requires either a loopback request OR a valid first-run claim cookie when no token is set; all other requests get 401.
- The MCP endpoint (`/api/[transport]`) now refuses traffic with `503 Instance not yet initialized` while in first-run mode, instead of accepting open requests.

## [0.3.2] - 2026-04-13

### Changed

- **Landing page header CTA** — replaced ambiguous "Login" button (which pointed to `/setup` and made no sense on the marketing landing) with **"Open my instance"**, a popover that asks for the user's deployed instance URL, validates it, persists it in `localStorage`, and redirects to `{url}/config`. Subsequent visits one-click straight through. Includes a "Forget saved instance" escape hatch and a "Don't have one yet? Deploy →" link that anchors to the hero deploy section.

## [0.3.1] - 2026-04-13

### Added

- Interactive setup wizard UI + simplified CLI
- Wizard in AppShell layout with sidebar, welcome intro, SaaS feel
- Comprehensive UX/UI improvements to setup wizard
- Hot env API (filesystem + Vercel REST)
- Per-request registry for hot env reloading
- Wizard simplified to 2 steps with auto token generation
- /config dashboard shell with 6 tabs + first-run middleware
- Sandbox + logs API endpoints for /config tabs
- Sidebar points to /config tabs; setup add-pack mode accepts empty query
- Skills store + schema + atomic file I/O
- Skills pack manifest + MCP tool exposure
- Skills MCP prompts exposure
- Skills CRUD UI + API routes
- Skills manual refresh endpoint
- Skills claude-skill export
- Pack-skeleton-and-source-registry
- Tier1-read-paywalled-tool
- Config-pack-credential-guide
- Tier2-read-paywalled-hard
- Cleanup-old-vault-paywall-tool
- Pack skeleton + runActor helper
- Manifest with allowlist + registry wiring
- Wizard + setup test + env example for apify
- Contract test + snapshot with apify pack
- Pluggable KV storage
- Destructive tool flag
- Read version from package.json instead of hardcoding
- Warn on missing ADMIN_AUTH_TOKEN at startup
- Add durable observability sink via KV store
- Add per-token rate limiting to MCP endpoint
- Add McpToolError class and structured error codes
- Add GitHub Issues pack (6 tools)
- Implement multi-token auth support
- Add Linear pack with 6 tools
- Add Airtable pack with 7 tools
- Auto-pull on dev start + dashboard update banner
- Add landing page at / route with INSTANCE_MODE toggle
- Connectors page redesign — accordion expand, inline guides, hide core

### Changed

- Typed tool handlers via generics
- Streaming fetch with byte cap
- Rename middleware to proxy
- Use fs.promises for non-blocking I/O
- Flatten config nav into sidebar, drop horizontal tabs
- Rename Packs → Connectors across codebase

### Documentation

- Update CHANGELOG for v0.2.1
- Update README to reflect 9 packs and 60 tools
- Fix tool counts to match contract snapshot (59 tools, not 60)
- Expand CONTRIBUTING.md into full community contribution guide
- Add SECURITY.md with vulnerability reporting policy
- Document three upgrade paths (auto predev, dashboard banner, manual)

### Fixed

- Wizard UI polish — design system alignment, tooltips, collapsible guides, better UX
- Suppress npm install warnings in CLI installer
- Merge wizard steps 1+2, fix Google test, add error details toggle
- Setup wizard hydration warning + Google test uses Gmail API
- Security hardening + sandbox validation + allowlist + hot reload
- Make update script Windows-compatible + bump to 0.3.1
- CheckAdminAuth now reads mymcp_admin_token cookie
- Bypass / redirect when INSTANCE_MODE != personal

### Maintenance

- Publish @yassinello/create-mymcp@0.3.1
- Remove unlinked /packs and /playground routes
- Release v0.3.0 — version bump, changelog, test fix
- Update contract test to include github and linear packs
- Bump version to 0.3.1

### Test

- Add unit tests for lib modules
- Add contract tests for GitHub Issues pack

## [0.2.1] - 2026-04-12

### Documentation

- Update CHANGELOG for v0.2.0

### Fixed

- CLI installer — Windows path handling, quotes, empty dir check, Composio pack, tool counts
- CLI UX overhaul + migrate composio-core to @composio/core v0.2.1

## [0.2.0] - 2026-04-11

### Added

- Slack thread/profile, Notion update/query, Composio pack — 51 tools / 7 packs v0.2.0

### Documentation

- Update CHANGELOG for v0.1.2
- Clarify no folder needed before running installer

### Fixed

- Option 1 now shows npx command explicitly

## [0.1.2] - 2026-04-11

### Added

- Create-mymcp CLI installer, GitHub template, pedagogical README v0.1.2

### Documentation

- Update CHANGELOG for v0.1.1

## [0.1.1] - 2026-04-10

### Added

- Add gmail_inbox and calendar_events tools
- Add browser tools (web_browse, web_extract, web_act, linkedin_feed) via Stagehand/Browserbase
- Registry foundation — pack-based tool loading from manifests
- Private status dashboard + admin API
- Guided setup page + Google OAuth flow
- Code quality + diagnostics + docs overhaul
- CI/CD, diagnostics, config export, IPv6 SSRF, repo rename
- Analytics, error webhooks, cron health, packs page, deprecation system
- ESLint + Prettier + Husky, E2E test, Tool Playground
- Slack + Notion packs, Docker support, auto-changelog
- Tailwind UI redesign, security fixes, tests, Docker compose, v0.1.1

### Changed

- Reorganize tools into packs + depersonalize

### Documentation

- Initialize project
- Complete project research (stack, features, architecture, pitfalls, summary)
- Define v1 requirements
- Create roadmap (3 phases)
- Start milestone v1.0 Open Source Framework
- Define milestone v1.0 requirements
- Create milestone v1.0 roadmap (5 phases)
- Packaging — README, .env.example, LICENSE, CONTRIBUTING, CHANGELOG
- README overhaul — architecture diagram, structured tool tables, full endpoint reference

### Fixed

- Add missing vault tools and updated lib files
- Critical code review fixes before open-source release
- Remove last any type in gmail search
- Cron to daily (Vercel free tier limit)
- Revert MCP SDK to ^1.26.0 (compat with mcp-handler 1.1.0)
- Code review — prettier formatting, update docs to 45 tools / 6 packs

### Maintenance

- Add project config

### V2.0

- Add vault_delete, vault_move, save_article + logging, auth, rate limiting, health check

### V3.0

- Complete audit fixes + admin UI redesign

### V3.1

- Add multi-client connection guide to dashboard

