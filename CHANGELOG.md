# Changelog

All notable changes to Kebab MCP.

## [Unreleased]

## [v0.15.0] — API Connections & Custom Tools

Lets users bring their own HTTP APIs as first-class connectors and
expose their endpoints as MCP tools Claude can call. Two new objects
are introduced: **API Connection** (URL + auth + headers) and
**Custom Tool** (action attached to a connection).

### Added

- **API Connections CRUD (CONN-01..05):** New "API Connections" section
  in `/config → Connectors`. Supports four auth variants — `none`,
  `bearer`, `api_key_header`, `basic`. Default headers + timeout are
  per-connection. SSRF guard at save + invocation (`isPublicUrl` /
  `isPublicUrlSync`). Secrets are redacted in GET responses — rotation
  requires a fresh PATCH payload.
- **Custom Tools (TOOL-01..06):** Registered via a new
  `api-connections` connector that reads from the KV-backed tool store
  and injects definitions at registry scan time. Tool name collisions
  across connectors are rejected at create time (409). Tools declare
  `read` / `write` + `destructive` so MCP clients can prompt.
- **cURL importer (TOOL-06):** `POST /api/config/api-tools/parse-curl`
  accepts a command string copy-pasted from Postman / Chrome DevTools /
  API docs and returns a pre-filled tool draft (method, path, query,
  body, Authorization bearer promoted to connection auth).
- **Tool builder UI (UI-02, UI-03):** New **+ New custom tool** button
  on the Tools tab opens a 2-step wizard — step 1 chooses "paste cURL"
  vs blank template, step 2 edits method / path / arguments / query /
  body / auth flags. Custom tools appear inline in the aggregated
  Tools view with their connector label ("API Connections").
- **Connection test endpoint (CONN-05):** `POST
  /api/config/api-connections/:id/test` probes the base URL with the
  current auth and returns `{ ok, status, ms }` so users can verify
  reachability before wiring tools.
- **Delete cascade:** Removing an API Connection also removes every
  tool attached to it (count returned in the DELETE response).

### Safety

- **SSRF guard (SAFE-01):** Private IPs (127/8, RFC1918, CGNAT, IPv6
  ULA, link-local), cloud-metadata IPs (169.254.169.254 +
  `metadata.google.internal`), and loopback hostnames blocked unless
  `KEBAB_API_CONN_ALLOW_LOCAL=1` is set.
- **Response size cap:** Tool invocations truncate response bodies at
  512 KB (tagged `[truncated]` in the Claude-visible output).
- **Timeouts:** Configurable per tool, capped at 60s (default 30s).

### Routes

- `GET/POST /api/config/api-connections`
- `GET/PATCH/DELETE /api/config/api-connections/:id`
- `POST /api/config/api-connections/:id/test`
- `GET/POST /api/config/api-tools`
- `GET/PATCH/DELETE /api/config/api-tools/:id`
- `POST /api/config/api-tools/parse-curl`

All routes are `withAdminAuth`-gated.

### Infrastructure

- New connector `api-connections` registered in `ALL_CONNECTOR_LOADERS`
  with dynamic tool count. Contract test
  `registry-metadata-consistency.test.ts` updated to skip equality for
  this dynamic connector (same pattern as `skills`).
- 33 new unit tests: 8 store CRUD + 9 invoke (interpolation, auth
  header synthesis, SSRF rejection, truncation) + 16 cURL parse
  (tokenizer, flag handling, draft extraction).

### Configuration

- **New env var:** `KEBAB_API_CONN_ALLOW_LOCAL` — 1/true to allow
  private-network URLs. Default: off. Example in `.env.example`.

### Known limitations (deferred)

- OpenAPI spec import.
- Response JSON-schema validation.
- Pagination helpers.
- Secrets-at-rest encryption (tokens currently live in KV alongside
  other instance state; equivalent trust boundary as env vars).

## [v0.14.0] — Skills sync & governance

Elevates Skills from individual Markdown payloads to reusable playbooks
with explicit tool governance and one-click sync to a local Claude Code
installation.

### Added

- **Allowed tools governance (SKILL-01..03):** Each skill can now declare
  `toolsAllowed: string[]` — an explicit list of MCP tool names it may
  invoke. Set via the Skill editor's new **Allowed tools** multi-select
  (backed by `GET /api/config/available-tools`). The list is embedded
  into all export formats (`.md` frontmatter, Claude `.skill` JSON, sync
  push), so Claude Code and human reviewers see the skill's surface
  before invocation. Empty = no explicit restriction (inherits ambient
  surface).
- **Skills sync to Claude Code (SYNC-01..05):** Configure sync targets
  via `KEBAB_SKILLS_SYNC_TARGETS` (JSON array of `{name, path}`). Skills
  tab gains a **Sync** button per skill + **Sync all** in the header.
  `POST /api/config/skills/:id/sync` writes `<target>/<skill_id>.md`
  with YAML-like frontmatter (name, description, arguments,
  tools_allowed, kebab_version). Bulk sync surfaces partial failures
  via 207 Multi-Status.
- **Per-target sync state:** Each skill tracks
  `syncState[target] = { lastSyncedHash, lastSyncedAt, lastSyncStatus,
  lastSyncError? }`. Server-side SHA-256 hash of
  `(name + \x1f + description + \x1f + content)` is stable and
  collision-resistant across name/description boundary.
- **Passive drift detection (DRIFT-01):** When `updatedAt` is newer than
  the last successful sync, the Skills tab shows an orange "drift" badge
  on the affected skill. Hover tooltip lists the stale targets. A green
  "synced" badge surfaces when all targets are current. No background
  polling — detection is pure client-side diff on load.

### Infrastructure

- `src/connectors/skills/lib/sync.ts` — pure sync module:
  `listSyncTargets()` / `getSyncTarget()` / `renderSkillMarkdown()` /
  `syncSkillToTarget()`. Refuses to write to filesystem roots
  (`/`, `C:\`, etc.) even if user-configured. Target directory is
  auto-created.
- Skill schema extends `toolsAllowed: string[]` + `syncState: Record<string,
  SkillSyncState>` with Zod defaults so existing skills in KV round-trip
  cleanly (pre-v0.14 skills read back with empty arrays).
- 3 new routes: `GET /api/config/skills-sync-targets`,
  `GET /api/config/available-tools`, `POST /api/config/skills/:id/sync`.
  All `withAdminAuth`-gated; contract tests pass.
- 16 new unit tests (10 sync + 6 store sync-state + hash collision
  resistance). 994 baseline → 1010 unit tests, 22 contract unchanged.

### Configuration

- **New env var:** `KEBAB_SKILLS_SYNC_TARGETS` — JSON array of sync
  targets. Optional. Example in `.env.example`.

### Removed

- `KEBAB_BROWSER_CONNECTOR_V2` env flag + the V2/V3 dispatch layer in the browser connector. The flag was an abstraction for a future Stagehand-v3 idiomatic code path that never diverged — both branches always delegated to the same implementation. With Stagehand 3.2.x as the only installed path and no user-facing need for rollback, the flag was pure complexity with a misleading name. Tools (`handleWebBrowse`, `handleWebAct`, `handleWebExtract`, `handleLinkedinFeed`) now expose a single handler. Regression test collapses from 24 cases (4 tools × 3 flag states × 2 scenarios) to 8 (4 tools × 2 scenarios). `.env.example` + `docs/CONNECTORS.md` + `scripts/audit-gate.mjs` updated to drop all flag references.

## [v0.1.13] — v0.13 — Daily-user delight

### Phase 53 — Observability UI expansion (OBS-06..11)

Turns the /config Health tab from a "is the server alive?" answer into a
daily monitoring dashboard. 5 new live sections, tenant selector (root
only), configurable 60s auto-refresh. No new durable storage — data
reads from the existing primitives (per-tenant ring buffer, durable
log-store, rate-limit KV buckets, Upstash REST `/info`).

**Added**

- `/config → Health` gains a **Usage & health** section below the
  existing OBS-01..05 blocks:
  - Requests chart: 24 hourly buckets, per-tool dropdown filter
    (populated from the live latency response, not a registry snapshot).
  - p95 latency bar chart: top-10 slowest tools.
  - Error heatmap: connector × 24h grid, cells painted via
    `log10(errors+1) / log10(maxErrors+1)` so 1 error vs 100 stay
    visually distinct. Zero-error cells surface as gray (active but
    healthy); no-activity cells dark gray.
  - Rate-limit panel: live bucket table (masked tenantId, scope,
    current/max, reset-in).
  - KV quota gauge: bytes used / limit with red warn banner above 80%,
    "unknown" badge + "set UPSTASH_REDIS_REST_URL" hint when creds absent.
- 5 `GET /api/admin/metrics/{requests,latency,errors,ratelimit,kv-quota}`
  routes, all `withAdminAuth`-gated. Response shapes documented in
  `docs/API.md` (TBD in this phase's OPERATIONS doc for now).
- `src/core/metrics.ts` — pure aggregation helpers
  (`aggregateRequestsByHour`, `aggregateLatencyByTool`,
  `aggregateErrorsByConnectorHour`) + `getMetricsSource()` which picks
  the in-process ring buffer first and falls back to
  `getLogStore().since(Date.now() - 24h)` on cold-start. `source` tag
  surfaces the active path to the UI ("cold-start (durable)" badge).
- `src/core/upstash-rest.ts` — thin Upstash REST `/info` client with
  3s `AbortSignal.timeout`, token-sanitized error messages, and a pure
  `parseUpstashUsedBytes()` helper (unit-tested independently).
- `src/core/rate-limit.ts::parseRateLimitKey()` extracted — shared by
  `/api/admin/rate-limits` and the new `/api/admin/metrics/ratelimit`
  (parse drift prevention). Handles all three shipped shapes: 6-part
  tenant-wrapped, 5-part legacy, 4-part null-tenant.
- `app/config/tabs/health/useMetricsPoll.ts` — custom SWR-style hook
  (no SWR dep added). 60s default, `?refresh=<seconds>` URL param
  override (clamp 10..600), manual `refresh()` method, AbortController
  cancellation on unmount / URL change.
- `TenantSelector`, `RefreshControls`, `MetricsSection` components +
  `RequestCountChart` / `LatencyBarChart` (Recharts) + `ErrorHeatmap`
  (hand-rolled SVG) + `RateLimitPanel` + `KvQuotaPanel`.
- `recharts@^2.13` (resolved 2.15.4) added as a direct dependency.
  Install requires `--legacy-peer-deps` due to pre-existing stagehand
  peer-dep chain.
- `UPSTASH_FREE_TIER_BYTES` new env var (default `250 * 1024 * 1024` =
  250 MB, Upstash free tier). Override for paid tiers.

**Changed**

- Bundle-size ceiling for `/config` re-baselined **600 KB → 620 KB** to
  absorb Recharts footprint + new chart components. Actual measured at
  phase close: **544 KB** (holds under the new ceiling with headroom).
- `.planning/` evidence file captures the API-surface map for future
  metrics surfaces.

**Files**

- `src/core/metrics.ts` + `src/core/upstash-rest.ts` + shared helper in
  `src/core/rate-limit.ts`.
- `app/api/admin/metrics/{requests,latency,errors,ratelimit,kv-quota}/route.ts`.
- `app/config/tabs/health/{MetricsSection,TenantSelector,RefreshControls,useMetricsPoll,RequestCountChart,LatencyBarChart,ErrorHeatmap,RateLimitPanel,KvQuotaPanel}.{ts,tsx}`.
- `app/config/tabs/health.tsx` — mounts `<MetricsSection />` below
  existing OBS-01..05; new `rootScope` + `tenantIds` props.
- `app/config/page.tsx` — tenant-ID discovery from `MCP_AUTH_TOKEN_*`.
- Tests: `tests/core/metrics.test.ts` (16) + `tests/core/upstash-rest.test.ts` (9) +
  `tests/integration/metrics-routes.test.ts` (15) +
  `tests/ui/{request-count-chart,error-heatmap,metrics-section}.test.tsx` (14).
- `docs/OPERATIONS.md` — new — dashboard operator guide.

**Data retention (no new storage)**

- Ring buffer: 100 entries per tenant (configurable
  `KEBAB_LOG_BUFFER_PER_TENANT`).
- Durable log-store: `MYMCP_LOG_MAX_ENTRIES` (default 500).
- KV quota: Upstash /info cached 30s (`Cache-Control: private, max-age=30`).

**Follow-ups (deferred)**

- Long-term metrics storage (keep 24h window for now).
- Alerting webhooks on rate-limit / error-rate thresholds.
- Prompts invocation count on the same Requests chart (v0.14).

### Phase 52 — Devices tab (DEV-01..06)

Closes operator pain point F7 (multi-client setup). The `MCP_AUTH_TOKEN` comma-list is now a first-class UX: one row per token in `/config → Devices`, with per-device rotate / revoke / rename + a 24h HMAC-signed invite URL so a second client (Claude Code, web, phone) can join without hand-editing env vars.

**Added**

- `/config → Devices` tab (root-scope gated) — per-token rows with label (inline-editable), 8-hex tokenId, relative `lastSeenAt` (derived from rate-limit bucket timestamps), `createdAt`, and rotate/revoke actions. Tenant-scoped admins see a "root admin only" notice instead of device rows.
- `src/core/devices.ts` — KV helpers: `listDevices` / `setDeviceLabel` / `deleteDevice` / `rotateDeviceToken` / `getLastSeenAt` / `clearDeviceRateLimit`. Rate-limit-bucket cleanup on revoke via idHash scan. No raw tokens stored in KV — only `{ label, createdAt }` at `tenant:<id>:devices:<tokenId>`.
- `/api/admin/devices` route (GET list / POST rotate|rename|invite / DELETE revoke) gated by `composeRequestPipeline([rehydrateStep, authStep('admin'), rateLimitStep({ scope: 'admin-devices', keyFrom: 'token', limit: 10 })])`. Tighter per-minute cap than the default 60 rpm because mutating admin actions should not be mass-triggerable from a compromised token.
- HMAC-signed 24h device-invite URL flow — `src/core/device-invite.ts` (mint/verify/consume) + `/api/welcome/device-claim`. Reuses Phase 37b's `getSigningSecret()` (SEC-05 refusal already applies). Single-use via atomic `kv.setIfNotExists` nonce. Canonical JSON (alphabetical keys) before HMAC so signatures are deterministic across runtimes.
- `KEBAB_DEVICE_INVITE_TTL_H` env override (default 24h).
- Claude Desktop install-snippet modal: `claude_desktop_config.json` block + per-OS config paths (macOS / Windows / Linux).
- 2-device integration test — mint → invite → claim → rotate → revoke → replay (409) → expiry (410) — in `tests/integration/devices-two-device.test.ts`.

**Files**

- `src/core/devices.ts` + `src/core/device-invite.ts`
- `app/api/admin/devices/route.ts` + `app/api/welcome/device-claim/route.ts`
- `app/config/tabs/devices.tsx` + `app/config/tabs/device-invite-modal.tsx` + `app/config/tabs/device-install-snippet.tsx` — 494 LOC total, ≤ 500 per DEV-06
- Tests: `tests/core/devices.test.ts` (12) + `tests/core/admin-devices-route.test.ts` (12) + `tests/core/device-invite.test.ts` (7) + `tests/core/device-claim-route.test.ts` (6) + `tests/integration/devices-two-device.test.ts` (1 scenario, 7 steps)

**Migration note**

Existing comma-list `MCP_AUTH_TOKEN` setups auto-discover — each existing token becomes a row with label `"unnamed"` and `createdAt "unknown"` until the operator renames inline. No breaking change. On Vercel deployments, rotate/revoke persist via the Phase 46 env-store facade the same way welcome-init already does — a redeploy propagates the change to other lambdas (same constraint as existing auto-magic mint).

**Follow-ups (deferred, not in this phase)**

- Token scope / permission granularity (all devices currently equal — any can invoke any tool).
- Device fingerprinting / IP tracking (only `lastSeenAt` + `label` today).
- Email/webhook notifications on revoke / rotate.
- QR-code rendering in the invite modal (dropped for DEV-06 LOC budget).

### Phase 51 — Langsmith CVEs default-on (LANG-01..03)

The Stagehand v3 adapter shipped Phase 44 behind `KEBAB_BROWSER_CONNECTOR_V2=1` is now **default**. Unset or `=1`/`=true` → v3 (clean langsmith chain, moderate CVEs no longer on the default call path). Explicit `=0`/`=false` → v2 (rollback only). Unknown values fail safe to v3.

- `src/connectors/browser/flag.ts` — `getBrowserConnectorVersion()` semantics inverted
- 16/16 Phase 44 browser-regression test suite still green under the new default
- `docs/CONNECTORS.md` gains a "Browser connector — Stagehand adapter version" section
- `.env.example` updated to reflect the new default
- `scripts/audit-gate.mjs` allowlist reason rewritten + `reviewBy` bumped `2026-07-01` → `2026-10-22` (transitive moderates remain reported by `npm audit` until Stagehand upstream ships a clean langchain peer)

**Operator action:** If your env currently sets `KEBAB_BROWSER_CONNECTOR_V2=1`, remove it — the new default is v3 anyway. Keep the override only if an edge case forces a return to v2.

## [v0.1.12] — v0.12 — Welcome hardening + v1.0 readiness

### Phase 50 — Rebrand + risk-weighted coverage + docs + MCP resources (2026-04-22)

**v1.0 blocker cleared: MyMCP → Kebab rename complete.**

**Branding (BRAND-01..04):**

- `KEBAB_*` env vars take priority; `MYMCP_*` fallback with one boot-time deprecation warning per variable per process (dedupe via module-level `Set<string>`). `src/core/config-facade.ts` `resolveAlias()` step wires the aliasing between request-context override and live process.env.
- Admin cookie: `kebab_admin_token` primary, `mymcp_admin_token` accepted during 2-release transition. `setAdminCookies(headers, token)` emits TWO Set-Cookie headers with identical attributes (HttpOnly + SameSite=Strict + Secure + Path=/ + Max-Age). `readAdminCookie(cookieHeader)` reads kebab first, legacy second (once-per-process warning on legacy hit). `proxy.ts` (Edge middleware) updated with dual-write + dual-read; `app/welcome/page.tsx` `isAdminAuthed()` reads both.
- OTel spans use `kebab.tool.name` / `kebab.connector.id` / `kebab.kv.key_prefix` / `kebab.request.id` by default. `KEBAB_EMIT_LEGACY_OTEL_ATTRS=1` (or `MYMCP_EMIT_LEGACY_OTEL_ATTRS=1`) restores `mymcp.*` aliases alongside. Central `brandSpanAttrs()` + `brandSpanName()` helpers in `src/core/tracing.ts`; all emission sites routed through them. Callers (auth, first-run, kv-store) pass unprefixed logical names and attribute keys.
- `src/core/constants/brand.ts` — single source of truth for `BRAND.envPrefix` / `BRAND.cookieName` / `BRAND.otelAttrPrefix` + the `LEGACY_BRAND` mirror. `deprecationMsg(legacyKey, modernKey)` formats the single-line boot warning.
- `tests/contract/no-stray-mymcp.test.ts` — contract test scanning `src/**/*.ts` + `app/**/*.{ts,tsx}` for `/\bmymcp\b/i` or `MYMCP_` literals outside a 53-entry allowlist. Allowlist covers brand constants, alias/fallback paths, cross-session state (headers `x-mymcp-tenant`, cookies `mymcp_oauth` / `mymcp.storage.ack.v3`, KV key `mymcp:firstrun:bootstrap`, Tailwind `prose-mymcp`, `Symbol.for("mymcp.transport.subscribed")`), external export formats (skills `source: "mymcp"`), and connector manifest UI copy. Budget guard: current + 1 headroom prevents silent allowlist creep.

**Coverage (COV-01..04) — risk-weighted, not 80% global:**

- Priority-path floor `≥ 65%` line coverage — verified at Phase 50 close:
  - `src/core/auth.ts` 97.84% · `src/core/first-run.ts` 93.96% · `src/core/signing-secret.ts` 96.82% · `src/core/kv-store.ts` 71.26% · `src/core/rate-limit.ts` 83.63% · `src/core/credential-store.ts` 65.38% · `src/core/pipeline.ts` 100% · `src/core/pipeline/*` 97.89%.
- Global ratchet raised `46 → 50` in `vitest.config.ts`. Actual `55.01%` at phase close (+8.6 percentage points aggregate since Phase 43). Conservative floor chosen to avoid fighting connector-module churn.
- `src/core/proxy.ts` (Edge middleware): Phase 40's grep-contract (`proxy-async-rehydrate.test.ts`) complemented with `tests/core/proxy-behavioral.test.ts` — 7 real behavioral scenarios covering rehydrate / cookie-auth / early-return / unauthorized / legacy-cookie / first-time-setup / showcase-mode.
- Connector lib backfill (6 new test files, 37 tests): `vault/lib/github` (17 — validateVaultPath + read/write/list + 4xx/5xx), `apify/lib/client` (9 — happy + 408/504/400 with redacted token), `slack/lib/slack-api` (7 — shape mapping + 3 error classifications), `google/lib/calendar` (4 — list + events multi-cal). All 4 connector-lib families now exceed the ≥ 60% local floor per `CONTRIBUTING.md`.
- `CONTRIBUTING.md` gains the risk-weighted coverage philosophy section — rejects the 80% metric chase, documents the 9 priority paths + ratchet discipline + connector lib policy + when-to-add-tests guidance.

**Documentation (DOCS-01..03):**

- `docs/API.md` — new — route-by-route reference (318 lines, all 42 endpoints) grouped by 9 concerns (`[transport]`, `health`, `admin/*`, `welcome/*`, `setup/*`, `config/*`, `auth/google/*`, `storage/*`, `webhook + cron`). Per-route: method, auth, request/response shape, pipeline steps, rate limit, tenant behavior. Phase 50 annotations throughout.
- `docs/CONNECTOR-AUTHORING.md` — new — zero-to-live walkthrough (359 lines, 8 steps + appendix). Manifest → tool handler → registry → .env → tests → resources → dev server → publish. Uses `getConfig` facade + `toMsg` helper + `McpToolError` + brand-aware OTel attrs. Appendix: pagination, rate-limit step, credential rotation via KV, tenant-scoped vs operator-wide, Phase 50 OTel conventions. `docs/CONNECTORS.md` gains top-of-file link.
- `README.md` — Documentation index reordered by reader journey (discover → deploy → use → author → contribute), adds `docs/API.md` + `docs/CONNECTOR-AUTHORING.md`. Instance-settings table: `KEBAB_*` as primary column with `MYMCP_*` as "Legacy name" column + pointer to migration guide.

**MCP ecosystem (MCP-01..02):**

- `src/core/resources.ts` — new — MCP `resources/*` capability registry. `ResourceProvider` interface (`scheme` + `list()` + `read(uri)`), `registerResources(server, providers)` wires `ListResourcesRequestSchema` + `ReadResourceRequestSchema` on `server.server.setRequestHandler`. List is concat of providers; read dispatches by URI scheme. Partial-failure tolerant (one provider's `list()` throw doesn't nuke the whole enumeration). Duplicate-scheme → first wins with warning. Graceful skip when SDK version lacks the request schemas.
- `ConnectorManifest.resources?: ResourceProvider` field (optional). App-level transport (`app/api/[transport]/route.ts`) collects every enabled connector's provider and registers after tool registration — empty array → zero overhead.
- Obsidian Vault pilot — `src/connectors/vault/resources.ts` exposes every `.md` file under `vault://<path>` URI. Uses existing `vaultTree()` + `vaultRead()` + `validateVaultPath()` (path-traversal guard from v0.6).
- `tests/core/resources-registry.test.ts` (10 tests) + `tests/connectors/vault-resources.test.ts` (9 tests) — unit + round-trip coverage.

**Carry-over cleanups (bundled in one chore commit):**

- `scripts/audit-gate.mjs` no-undef lint errors (Phase 44 carry-over): added `scripts/**/*.mjs` + `*.mjs` override to `eslint.config.mjs` with Node globals + `sourceType: "module"`. `npm run lint` now 0 errors.
- `tests/integration/welcome-durability.test.ts` NODE_ENV TS2540 (Phase 42 carry-over): cast through `process.env as Record<string, string | undefined>`. `npx tsc --noEmit` clean.
- vitest 4 `poolOptions` deprecation (Phase 45 carry-over): migrated `pool: "forks" + poolOptions.forks` → `pool: "forks" + forks` (top-level) per vitest 4 migration guide. `npm test` emits 0 deprecation warnings.

**Deviations (Rule 3 auto-fixes documented in commits):**

- `proxy.ts` added to `ALLOWED_DIRECT_ENV_READS` + ESLint FACADE-03 override (Edge runtime predates the facade module graph — not routable through `getConfig()` without blowing the Edge bundle).
- `KEBAB_ENABLED_PACKS` migration folded into Task 5: `MYMCP_ENABLED_PACKS` readers in `src/core/config.ts` + `src/core/registry.ts` + 3 test files + `scripts/registry-test.ts` all updated (facade alias still accepts MYMCP_*). Without this, every `npm test` run tripped the Phase 50 BRAND-01 deprecation warning via the registry smoke test.
- Task 7 ships as a single atomic commit instead of 4 sub-commits (Judgment call — connector-lib test shapes proved uniform enough to commit coherently; revertibility preserved via file-level granularity).
- Task 8 ships no new per-path test files — priority paths were already at 78% average line coverage from Phases 41/46/49 over-delivery, so adding redundant tests for paths at 93-100% would be net-negative churn without confidence gain.

### Migration guide (v0.11 → v0.12)

**Env vars:** No action required. Set `KEBAB_*` for new deployments. Existing `MYMCP_*` continues to work through v0.13 (support removed in v0.14) — one deprecation warning per variable per process.

**Cookie:** No action required. Existing sessions continue to authenticate via `mymcp_admin_token`. New sessions write both cookies. Logout clears both.

**OTel consumers:** If your dashboards filter on `mymcp.tool.name`, set `KEBAB_EMIT_LEGACY_OTEL_ATTRS=1` to restore the old attribute names alongside the new ones, then migrate dashboards at your leisure. Span NAMES are single-valued and always emit `kebab.*` (e.g., `kebab.auth.check`, `kebab.kv.write`, `kebab.bootstrap.rehydrate`) — the legacy flag only duplicates attribute KEYS.

**Codebase forks:** `src/core/constants/brand.ts` is the single source of truth. All new code should reference `BRAND.envPrefix` / `BRAND.cookieName` / `BRAND.otelAttrPrefix`; never hardcode. `tests/contract/no-stray-mymcp.test.ts` prevents regressions. Grandfathered paths (cross-session state — headers, cookies, KV keys — and external export formats) are on the allowlist with per-entry rationale.

### Phase 49 — Type tightening (T19) (2026-04-22)

**Goal:** close the class of type-drift that shipped 2 silent `any` leaks
through previous milestones. Ratchet TypeScript strictness to catch the
remaining 4 well-known holes. Dedupe the 60+ `err instanceof Error ?
err.message : String(err)` ternary callsites through a single canonical
helper. Replace 8 `getConfig("X")!` non-null-bang sites with a typed
`getRequiredEnv(key, connectorName)` throwing `McpConfigError`.
Unblocks v1.0 code-quality gate.

**TypeScript strictness (TYPE-01):** 4 new compiler flags enabled in
`tsconfig.json`, each in its own commit for `git bisect` friendliness.
Landing order cheapest → most-valuable (per INVENTORY.md baseline):

- `noImplicitOverride: true` — 2 errors fixed (React error-boundary
  overrides). Trivial `override` keyword additions.
- `verbatimModuleSyntax: true` — 10 errors fixed across 10 connector
  tool files (GitHub + Linear). Mechanical `import type` additions
  now that `isolatedModules: true` was already in effect.
- `exactOptionalPropertyTypes: true` — 117 baseline errors. Systematic
  pattern: zod's `.optional()` yields `T | undefined`, but handler
  signatures previously declared `?: T`. Widened ~90 handler
  parameters + key shared types (McpToolError opts, ConnectorManifest,
  ToolLog, PipelineContext, KVStore interface, ImportOptions,
  SlackMessage, ConnectorSummary, AutoMagicState, WelcomeAction,
  Phase/UI state unions, 4 browser-tool Params aliases, CalendarEvent
  + DriveFile, RequestContextData, Sidebar + AppShell props).
  2 semantic-correctness call-site fixes (skills/store selective
  spread; TenantKVStore scan via `NonNullable<KVStore["scan"]>`).
  3 omit-vs-undefined config-shape fixes (useStoragePolling signal
  coerced to `?? null`; playwright.config.ts webServer +
  storageState spread conditionally; admin-rate-limits-tenant test
  omits match when undefined).
- `noUncheckedIndexedAccess: true` — 229 baseline errors (145 in
  src/app + 84 in tests). **Highest-value flag** — would have
  caught the 2 silent `any` leaks audited in POST-V0.11-AUDIT §A.6.
  Landed LAST to keep the earlier bisect-friendly commits stable.
  Guard-based fixes only in production code (NO blanket `!` reintroductions):
  extract + validate tuple parts before narrowing
  (`app/api/admin/rate-limits/route.ts`); line-binding `const next =
  lines[i]; if (next === undefined) break;` in iterative parsers
  (`markdown-lite.ts`, `env-store.ts`); hoist bucket references
  post-lookup + ensure-path assignment (`logging.ts`); regex-group
  narrowing via `match?.[1] ?? ""` (frontmatter, url-safety,
  vault/lib/github, paywall); `if (!page) throw` gates in browser
  tool handlers. Tests use `!` assertions where the surrounding
  `expect(arr).toHaveLength(N)` already proved the invariant.

`npx tsc --noEmit` green on main with all 4 flags active (only
pre-existing Phase 42 carry-over `tests/integration/welcome-durability
.test.ts:328 TS2540` remains — unchanged by this phase).

**Error-handling dedupe (TYPE-02):** new `toMsg(e: unknown): string`
helper in `src/core/error-utils.ts` with 12 unit tests covering Error
/ subclass / string / number / null / undefined / object / Symbol /
toString / boolean / unicode / empty-Error. Regex-driven codemod at
`scripts/codemod-to-msg.ts` (tracked in VCS for future re-runs)
rewrote 63 STRICT-shape sites + 2 WEIRD-shape sites (`err instanceof
Error ? err.message : err` — returns raw err, unsafe) across 45 files
in `src/` + `app/`. Depth-aware import insertion (relative for
`src/core/**`, `@/core/error-utils` alias for everywhere else) +
preservation of `"use client"` / `"use strict"` / shebang directives.
28 LITERAL-fallback sites (`err instanceof Error ? err.message :
"Cannot reach Notion"`) intentionally NOT codemodded — rewriting
would regress their bespoke user-facing strings to `"[object Object]"`
/ `"undefined"`. Filed to FOLLOW-UP as T-LITFB audit.

**Typed required env (TYPE-03):** new `getRequiredEnv(key,
connectorName)` helper in `src/core/env-utils.ts`. Delegates to
`getConfig()` (preserving the Phase 48 SEC-02 tenant-isolation seam)
and throws `McpConfigError` with an actionable per-connector message
naming both the env var AND the connector ("Connector browser
requires BROWSERBASE_API_KEY. Set it in the dashboard or .env and
redeploy."). 8 unit tests covering present / missing / empty-string /
message content / structured `.key` + `.connector` fields / actionable
message / whitespace-only (valid).

`McpConfigError` extended backward-compatibly with an optional
third `connector` constructor arg. Existing `getRequiredConfig()`
callers (Phase 48 FACADE-01) continue to work unchanged.

8 `getConfig("X")!` non-null-bang sites migrated (7 in
`src/connectors/browser/lib/browserbase.ts`, 1 in
`src/connectors/composio/manifest.ts`). Note: the plan said
"8 `process.env.X!` bangs" — Phase 48's FACADE-02 migration had
already routed those through `getConfig()`. Same site count, same
files, same outcome. Missing env now throws `McpConfigError` naming
both the connector + env var instead of "undefined is not a string"
from the SDK downstream.

**Regression fence (TYPE-04):** new contract test
`tests/contract/no-err-ternary.test.ts` (Windows-safe — uses
`fs.readdirSync`, NOT `rg`/`grep` subprocess; precedent:
`fire-and-forget.test.ts`). Detects both STRICT and WEIRD shapes;
tests/** + `**/*.test.ts` grandfathered at the walker level (roadmap
D-04). Tight 2-entry allowlist (`src/core/error-utils.ts` as the
canonical shape, `scripts/codemod-to-msg.ts` as the regex string
literal) with a defensive "stale entry" check so dead allowlist rows
can't hide a future regression. Flip-test validated: synthetic pattern
injection → test fails with actionable `file:line: line-content`
output; revert → test passes.

**Fork-maintainer notes:**

- **New catch block?** Use `toMsg(err)` from `@/core/error-utils`
  instead of the legacy ternary. The TYPE-04 contract test will fail
  CI otherwise.
- **New connector needs a required env var?** Prefer
  `getRequiredEnv("KEY", "connector-name")` from `@/core/env-utils`
  over `getConfig("KEY")!` / `process.env.KEY!`. Missing env now
  produces an actionable error at the connector-testConnection /
  first-call boundary, not a cryptic SDK-side crash.
- **4 strict flags active on main:**
  `tsconfig.json` ships noUncheckedIndexedAccess +
  exactOptionalPropertyTypes + verbatimModuleSyntax +
  noImplicitOverride. New PRs touching production code must satisfy
  all 4. The `git log -- tsconfig.json` shows one bisect-friendly
  commit per flag.
- **Zod schemas** with optional fields now produce handler-args types
  with `?: T | undefined` in tool-handler signatures. When defining a
  new handler, match the `?: T | undefined` shape (or rely on the
  `defineTool()` inference instead of re-declaring).

**Aggregate diff:** 9 atomic commits (evidence folded into first
helper commit; 2 helper commits + 2 codemod/migration commits + 1
contract test + 4 flag-enable commits + 1 CHANGELOG). Commit list:
`9cec16e` (toMsg helper) → `e5bceb2` (codemod 65 sites) → `5c39ce9`
(env-utils helper + McpConfigError extension) → `64e56c9` (migrate 8
bangs) → `28810c5` (no-err-ternary contract test) → `e260342`
(noImplicitOverride) → `ff39a3e` (verbatimModuleSyntax) → `82d05de`
(exactOptionalPropertyTypes + 93 files) → `5ad651e`
(noUncheckedIndexedAccess + 70 files).

**Test count:** 793 baseline → 815 unit (+12 error-utils, +8 env-utils,
+2 no-err-ternary contract) + 37 UI + 44 registry + contract + doc-counts
all green. `npm run lint` clean (no new errors beyond the pre-existing
Phase 44 `scripts/audit-gate.mjs` carry-over).

**Explicitly deferred (out of scope):**
- `as` cast audit → T-AS backlog, separate phase
- Zod → Valibot migration — not this milestone
- React strict-mode style tightening — not this milestone
- T-LITFB audit: the 28 literal-fallback sites left by the codemod —
  each should be evaluated individually for whether the bespoke user-
  facing string adds more value than `toMsg(err) ?? 'literal'` would

### Phase 48 — In-memory tenant isolation + config facade (2026-04-22)

**Goal:** close the last two tenant-isolation + global-state gaps carried from
Phases 42 and v0.11 — the `src/core/logging.ts` in-memory ring buffer (still
operator-wide post-TEN-02) and 166 direct `process.env.X` reads scattered across
`src/` + `app/` that defeat the v0.10 request-context credential seam.

**Requirements closed:** ISO-01, ISO-02, ISO-03, FACADE-01, FACADE-02,
FACADE-03, FACADE-04. Closes Phase 42 FOLLOW-UP §1 (in-process ring buffer
tenant scoping) + POST-V0.11-AUDIT §A.3 NIT (redundant tokenId filter).

**Commits (10, atomic, each green on main):**

- `3c3cd39` chore(48): evidence — process.env read classification + logging ringbuffer callsites
- `a2a25a1` refactor(logging): ring buffer Map<tenantId, ToolLog[]> with LRU (ISO-01, ISO-03)
- `2e629fd` feat(config-logs): tenant selector + scoped query (ISO-02)
- `38ab1fd` feat(config-facade): getConfig<T> + bootEnv freeze (FACADE-01)
- `c1663ef` refactor(48): migrate src/core process.env reads to facade (FACADE-02a)
- `988650a` refactor(48): migrate connector libs process.env reads (FACADE-02b)
- `848e136` refactor(48): migrate route handlers process.env reads (FACADE-02c)
- `<ci eslint>` ci(eslint): kebab/no-direct-process-env custom rule + allowlist contract (FACADE-03)
- `71578a0` feat(config-facade): per-tenant setting overrides (FACADE-04)
- `docs(48)` — this entry

**ISO-01 — per-tenant ring buffer** (`src/core/logging.ts`):

- Replaced single `const recentLogs: ToolLog[] = []` (operator-wide, cap 100)
  with `Map<tenantId | "__root__", ToolLog[]>`. Each bucket LRU-trims
  independently so one noisy tenant cannot evict another's entries.
- Cap default: 100 per-tenant. Override via `KEBAB_LOG_BUFFER_PER_TENANT` (new
  env var; `MYMCP_*` alias is Phase 50 rebrand work).
- `getRecentLogs(n, { tenantId?, scope? })` — optional second arg. Legacy
  single-arg callers unchanged (read current-tenant bucket or `__root__`).
  `scope: 'all'` returns chronological union (root-operator path).
- `getToolStats()` aggregates across the union — admin-metrics tab stays
  operator-wide (byToken field preserved).

**ISO-02 — /config → Logs tenant selector** (`app/api/config/logs/route.ts`,
`app/config/tabs/logs.tsx`):

- Route drops the obsolete application-code `tokenId` filter in the
  in-memory branch (redundant post-ISO-01). Adds `?scope=all` and
  `?tenant=<id>` query args (privacy guard: tenant-scoped callers cannot
  elevate to scope=all). Durable branch already tenant-scoped via Phase 42.
- LogsTab surfaces a "Current tenant / All tenants (root)" selector only
  when the admin has root scope (no x-mymcp-tenant header).

**ISO-03 — test coverage** (`tests/core/logging-tenant-isolation.test.ts`):

- 7 tests (alpha/beta isolation, root union via scope=all, per-tenant LRU at
  the cap, `__root__` sentinel, env override, aggregate stats,
  `__resetRingBufferForTests`).

**FACADE-01 — single resolution point** (`src/core/config-facade.ts`):

- New ~230 LOC module with `getConfig(key)`, `getRequiredConfig(key)`,
  `getConfigInt(key, fallback)`, `getConfigBool(key, fallback)`,
  `getConfigList(key, fallback)`, `getTenantSetting(envKey, kvKey, tenantId?)`.
- Resolution order: request-context (when active) → RUNTIME_READ_THROUGH
  (VERCEL_*, NODE_ENV) → live process.env. SEC-02 tenant isolation is
  carried by step 1 (`runWithCredentials`), not by the bootEnv snapshot
  — which is retained as advisory (`__getBootEnvSnapshotForTests`).
- `McpConfigError` added to `src/core/errors.ts` for missing-required throws.
- 8 unit tests in `tests/core/config-facade.test.ts`.

**FACADE-02 — migration** (3 atomic commits, ~170 process.env reads → facade):

- Commit A (src/core/**): ~30 reads in auth.ts, config.ts, logging.ts,
  rate-limit.ts, pipeline/auth-step.ts, pipeline/rate-limit-step.ts,
  request-utils.ts, env-safety.ts, credential-store.ts, log-store.ts.
- Commit B (src/connectors/**): ~35 reads across all 13 connector libs +
  manifests + tools (vault/lib/github.ts carried a local `getConfig` name
  collision — resolved via `import { getConfig as readConfig }`).
- Commit C (app/api/** + app/**/*.tsx): ~35 reads across route handlers +
  RSC server components.
- Residual allowlist (`ALLOWED_DIRECT_ENV_READS`) = 10 entries (all boot-path,
  all with ≥20-char reasons): config-facade.ts (owns bootEnv), env-store.ts,
  first-run.ts, first-run-edge.ts, kv-store.ts, log-store.ts,
  request-context.ts, signing-secret.ts, storage-mode.ts, tracing.ts,
  upstash-env.ts (DUR-06 single-reader).

**FACADE-03 — lint + contract** (`.eslint/rules/no-direct-process-env.mjs`,
`tests/contract/allowed-direct-env-reads.test.ts`,
`tests/eslint/no-direct-process-env.test.mjs`):

- Custom flat-config ESLint rule `kebab/no-direct-process-env` at error
  severity. Matches both `process.env.X` and computed `process.env[key]`;
  excludes AssignmentExpression LHS (SEC-02 owns assignments).
- `eslint.config.mjs` override block mirrors ALLOWED_DIRECT_ENV_READS.
- Contract test walks src/ + app/ with a regex fallback (catches IDE-silenced
  rule violations). 5 assertions: file-allowlist match, sorted, ≥20-char
  reasons, no duplicates, non-empty vars.
- RuleTester test (run via `node --test`): 3 valid + 3 invalid cases.

**FACADE-04 — per-tenant settings** (`src/core/config.ts`,
`app/api/config/env/route.ts`, `app/config/tabs/settings.tsx`):

- `saveInstanceConfig(patch, tenantId?)` — new second arg routes writes to
  tenant-scoped KV via `getTenantKVStore(tenantId)`. Null-tenant writes stay
  global (backwards compatible).
- `app/api/config/env` PUT handler threads `getCurrentTenantId()` into the
  save path. GET handler reads via `getInstanceConfigAsync(tenantId)` so the
  dashboard surfaces the per-tenant override.
- Settings tab renders a scope badge: `Scope: Global (root)` or
  `Scope: Tenant alpha (override)`.
- 5 tests in `tests/core/config-facade-per-tenant.test.ts` covering
  `getTenantSetting` resolution, read-side `getInstanceConfigAsync(tenantId)`
  isolation, and write-side `saveInstanceConfig(patch, tenantId)` routing.

**Operator notes:**

- `KEBAB_LOG_BUFFER_PER_TENANT` (new env var; default 100). No `MYMCP_*`
  predecessor — Phase 50 adds the `KEBAB_*` ↔ `MYMCP_*` alias resolution.
- Per-tenant KV settings: existing `MYMCP_TIMEZONE` / `MYMCP_LOCALE` /
  `MYMCP_DISPLAY_NAME` / `MYMCP_CONTEXT_PATH` env vars unchanged; adding a
  `tenant:alpha:settings:timezone` KV entry under `x-mymcp-tenant: alpha`
  now takes precedence for that tenant. Global env/KV values remain the
  fallback for any tenant without an override.
- Ring buffer cap semantics changed: pre-Phase-48 the buffer was operator-wide
  (100 total). Post-Phase-48 it is per-tenant (100 per bucket, no global cap).
  On warm lambdas serving many tenants, memory usage scales with tenant count
  — tune `KEBAB_LOG_BUFFER_PER_TENANT` downward if this is a concern.

**Fork-maintainer notes:**

- The new `kebab/no-direct-process-env` rule will flag any direct
  `process.env.X` read introduced post-v0.11. Migration: swap to
  `getConfig('X')` from `@/core/config-facade`. Boot-path reads that
  genuinely cannot migrate (module-load ordering, circular dep) go on
  `ALLOWED_DIRECT_ENV_READS` with a ≥20-char reason + an override block
  entry in `eslint.config.mjs`.
- Test fixtures that `vi.mock('@/core/request-context')` must now also export
  `getCredential` + `runWithCredentials` + `requestContext` (the facade
  imports these). Example pass-through: `getCredential: (k) => process.env[k]`.

### Phase 47 — WelcomeShell runtime wiring (2026-04-22)

**Goal:** wire the 923 LOC of dormant step components + hooks + reducer
shipped in Phase 45 into the live `/welcome` render path. Reduce
`WelcomeShell.tsx` from 2194 LOC → ≤ 200 LOC orchestrator. Closes
Phase 45 FOLLOW-UP A (the deferred JSX migration) and the last
structural welcome-flow debt.

**Requirements closed:** WIRE-01, WIRE-02, WIRE-03, WIRE-04, WIRE-05,
WIRE-06. WIRE-06 (per-step revertibility) was enforced across all 8
commits — each per-step commit reverts independently against the prior
step's component + the dual-path contract during migration (Tasks
1–5); Task 6 collapsed the dual-path to reducer-only, and Task 7
Part B (shim retirement) is itself a standalone revert if the
import-graph simplification is undesired.

**Commits (8, atomic, per-step revertible):**

- `b8a9cca` refactor(welcome): wire WelcomeStateContext at WelcomeShell root (dual-path) — WIRE-02
- `49583a9` refactor(welcome): migrate step-1 storage JSX to steps/storage.tsx — WIRE-01a
- `ee410bc` refactor(welcome): migrate step-2 mint JSX to steps/mint.tsx — WIRE-01b
- `ce1fb81` refactor(welcome): migrate step-3 test JSX to steps/test.tsx — WIRE-01c
- `07fedd0` refactor(welcome): migrate already-initialized panel — WIRE-01d
- `c15edb6` refactor(welcome): retire legacy useState + WelcomeShell ≤ 200 LOC — WIRE-03 + WIRE-04
- `18abd64` refactor(welcome): welcome-client.tsx shim to page.tsx direct import — WIRE-05
- `docs(47)` — this entry

**Measurements:**

- `app/welcome/WelcomeShell.tsx`: 2194 → 190 LOC (-91%). Zero useState.
- `app/welcome/steps/*.tsx`: 351 → ~1930 LOC (4 step components carrying
  the real JSX; ~815 storage + ~600 mint + ~410 test + ~110 already-init).
- `app/welcome/chrome.tsx`: new (158 LOC) — Shell + WizardStepper +
  RecoveryFooter + PreviewBanner + RecoveryResetBanner.
- `app/welcome/welcome-client.tsx`: 29 LOC → deleted (shim retired).
- `WizardStorageSummary.durable?` field added to `wizard-steps.ts` so
  mint + test gates can distinguish durable backends from acked
  ephemeral without reading the raw `StorageStatus` shape.
- Test count: 801 unit + 37 UI + 59 regression/contract — Phase 45
  baseline held. Phase 46 `welcome-init-concurrency.test.ts` 10 passed
  (behavioral safety net intact).
- Playwright E2E baseline: unchanged (no visual refresh).

**Reducer state ownership (post-migration):**

- `state.claim` — driven by `useClaimStatus()` invoked from the
  orchestrator + `AlreadyInitializedPanel`.
- `state.step` — orchestrator `setStep()` + step Continue/Back buttons.
- `state.storage.{mode,healthy,durable}` — `<StorageStep />` bridges the
  `/api/storage/status` poll result into `STORAGE_UPDATED`.
- `state.token`, `state.instanceUrl`, `state.autoMagic` — `<MintStep />`
  via `useMintToken().mint()` → `TOKEN_MINTED`.
- `state.tokenSaved` — MintStep's save-checklist checkbox.
- `state.permanent` — MintStep's /api/welcome/status poll.
- `state.testStatus`, `state.testError` — `<TestStep />`.
- `state.ack`, `state.ackPersisted` — StorageStep's cookie read/write.

**Deviations / judgment calls:**

- **Widened WizardStorageSummary** (Rule 2): added optional `durable:
  boolean` so mint/test persistenceReady reads from the reducer
  without a parallel raw StorageStatus reference. Optional field
  preserves `wizard-steps.test.ts` truth-table back-compat.
- **Grep-contract updates** (Rule 2):
  `tests/regression/storage-ux.test.ts` `readClient()` reads ALL
  per-step files + chrome.tsx + WelcomeShell + the welcome-client
  shim (with try/catch fallback). `welcome-flow.test.ts` BUG-04
  reads steps/test.tsx + steps/mint.tsx alongside WelcomeShell.tsx
  since `persistenceReady` migrated. `fire-and-forget.test.ts`
  FILE_ALLOWLIST gains app/welcome/steps/{storage,mint,test}.tsx.
- **Step-local transients kept as useState** (ROADMAP judgment):
  `copied`, `skipTest`, `storageChecking`, `storageFailures`,
  `upstashCheck*`, `lastCheckOutcome`, `StarterSkillsPanel` locals —
  single-consumer UI flags, not reducer values.
- **Dual-path during migration** (ROADMAP judgment: YES). Tasks 1–5
  ran with BOTH legacy useState AND the context provider active.
  Task 6 collapsed to reducer-only.
- **React.lazy on step components** NOT applied (ROADMAP: NO).
  Components are small; lazy adds runtime cost without bundle-size
  win at this scale.
- **`useTestMcp` fetch inline** in `steps/test.tsx` rather than a
  dedicated hook (ROADMAP). No reuse site; premature abstraction.
- **`welcome-client.tsx` shim retired** — judgment taken. 29-LOC shim
  had one consumer; direct import simplifies. Grep-contracts guard
  via try/catch-wrapped reads.
- **StepHeader + StepFooter copy-per-step** (minor): each step
  declares its own chrome (~50 LOC total duplication). Not hoisted
  because signatures vary slightly (`tertiary` only on test-step,
  `href` only on test + mint) — unifying would create higher-
  friction API than the duplication costs.

**Follow-up items:**

- `tests/integration/multi-host.test.ts` HOST-05 pre-existing failure
  (Phase 39 carry-over) unchanged.
- `scripts/audit-gate.mjs` no-undef lint errors (Phase 44 carry-over)
  unchanged.
- `tests/integration/welcome-durability.test.ts:328` TS2540 NODE_ENV
  (Phase 42 carry-over) unchanged.
- The `// Phase 47 WIRE-01*: … moved to steps/*.tsx` breadcrumb
  comments in WelcomeShell.tsx prevent accidental re-inlining of the
  JSX in a future refactor.

### Phase 46 — Welcome correctness hardening (2026-04-21)

Closes the HTTP-level concurrent mint-race coverage gap GPT review
flagged on the initial v0.12 proposal. Five atomic test + docs
commits, no behavioral changes to the 409 response shape.

- **CORR-01**: Real concurrent HTTP race test — two `POST /api/welcome/init`
  calls with the same claim cookie now assert exactly one `200+token` and
  one `409 { error: "already_minted" }` (no token echo). Closes the
  coverage gap the prior sequential-helper-only test left open
  (`tests/integration/welcome-mint-race.test.ts` ran flushes SEQUENTIALLY
  with DIFFERENT claim IDs; the new
  `tests/integration/welcome-init-concurrency.test.ts` fires them through
  `Promise.all` against a module-mocked Upstash backend enforcing atomic
  NX semantics, plus a 5-iteration loop to catch scheduler artifacts).
- **CORR-02**: Same race covered against `FilesystemKV` (single-process
  serialization documented as the contract — cross-process arbitration
  requires Upstash, flagged inline + in `docs/HOSTING.md`).
- **CORR-03**: Mode matrix tests — no-external-KV dev mode (race window
  documented as dev-only behavior), auto-magic Vercel env-write path
  (Vercel REST client stubbed at the `@/core/env-store` module boundary
  with 3 it() blocks covering happy / write-fail / redeploy-fail),
  `MYMCP_RECOVERY_RESET=1` refusal (409 + no KV write on the bootstrap
  key; `=0` baseline proves the strict `=== 1` equality gate).
- **CORR-04**: JSDoc degraded-mode contract on `flushBootstrapToKvIfAbsent()`
  (per-backend race-arbitration guarantees + `@see` anchor) + 6-line
  inline comment in `app/api/welcome/init/route.ts` above the flush call.
- **CORR-05**: `docs/HOSTING.md` — new `## Degraded-mode contract` section
  with 5-row host × backend race-protection matrix (Vercel+Upstash,
  Vercel+no-KV, Docker+FilesystemKV single/multi-process, Node+MemoryKV).
- Test count: 801 → 811 (+10 new integration tests across 5 describe
  blocks); `npm run test:integration` includes the new file,
  `npm test` explicitly excludes it via `vitest.config.ts`.

## [Unreleased] — v0.11 — Multi-tenant real

### Phase 45 — Welcome refactor + QA polish (UX-01..04 + QA-01..02)

Landed 6 requirements in 10 atomic commits (`9094b7d`, `c3f4fb2`,
`9a7e8b0`, `67f013d`, `37fd1bf`, `866602f`, `f3c70e6`, `a2160e4`,
`09a4aad`, `docs:45` final). welcome-client.tsx dropped from
**2207 LOC to 29 LOC** (shim) without any visual or behavioral
regression — the render tree moved verbatim into
`app/welcome/WelcomeShell.tsx`, and the new per-step components +
hooks + pure modules land as dormant infrastructure ready for a
follow-up JSX migration.

**Welcome refactor (UX-01..03):**

- `app/welcome/welcome-client.tsx` is a 29-LOC shim that re-exports
  the new `WelcomeShell` named component from
  `app/welcome/WelcomeShell.tsx`. Prop contract unchanged;
  `app/welcome/page.tsx` import site untouched.
- Reducer-backed state machine at
  `app/welcome/WelcomeStateContext.tsx` with 10-action
  discriminated union + `WelcomeStateProvider` + `useWelcomeState`
  + `useWelcomeDispatch`.
- 4 step components split under `app/welcome/steps/`:
  `storage.tsx`, `mint.tsx`, `test.tsx`, `already-initialized.tsx`.
  Each wires to the context + the relevant hook (storage
  polling, mint, or inline test-mcp fetch).
- 3 custom hooks under `app/welcome/hooks/`: `useClaimStatus`,
  `useStoragePolling`, `useMintToken`. Each ≤ 1 useEffect + ≤ 4
  useState; AbortController prevents setState-on-unmount leaks.
- 2 pure modules: `src/core/welcome-url-parser.ts` (named export
  `extractTokenFromInput` — the parallel re-implementation in
  `tests/regression/welcome-flow.test.ts:79-113` is deleted) and
  `app/welcome/wizard-steps.ts` (STEPS array + 3 gate predicates
  + `nextStep`). Both tested directly instead of via JSX-grep
  contracts — closes Phase 40 FOLLOW-UP A + B.
- Playwright E2E (`tests/e2e/welcome.spec.ts`) green post-refactor
  (3 passed, 1 skipped — same as pre-refactor). No visual
  regression.

**Mint-race fix (UX-04):**

- `KVStore.setIfNotExists(key, value, opts?)` atomic primitive
  added. UpstashKV uses native `SET key value NX EX`; FilesystemKV
  serializes via the write queue (single-process dev).
- `src/core/first-run.ts` gains `flushBootstrapToKvIfAbsent()` —
  returns `{ok:true}` for the winner or `{ok:false; reason:
  "already_minted"; existing}` for the loser. Idempotent retry
  path matches when the existing entry's claimId equals the
  current mint.
- `app/api/welcome/init/route.ts` switches to the new helper and
  returns 409 `{error: "already_minted"}` for the losing minter,
  without echoing the winner's token in the body.
- Integration test
  `tests/integration/welcome-mint-race.test.ts` covers the
  winner/loser split + idempotent retry + FilesystemKV SETNX
  smoke test (3 cases).

**CI stabilization (QA-01):**

- 4 flaky render tests across 3 files (HealthTab +
  ConnectorsTab + SkillsTab + SettingsTab) stabilized via the
  new isolated vitest pool at `vitest.ui.config.ts` (`pool:
  'forks'` + `singleFork: true` + `testTimeout: 10_000` +
  jsdom env). `vitest.config.ts` excludes `tests/components/**`
  and `tests/ui/**/*.test.tsx` so render tests don't run
  twice. `npm test` chains both configs; 2 consecutive green
  runs establish stability.

**NIT hygiene (QA-02):**

- `src/core/migrations/v0.10-tenant-prefix.ts` now uses
  `getLogger("MIGRATION")` (was 2× `console.info`). Zero
  `console.*` remaining in the migration file.
- `app/api/admin/health-history/route.ts:76` stale-sample cleanup
  logs partial failures via `getLogger("admin.health-history")`
  instead of silently swallowing.
- `app/api/cron/health/route.ts:69` error-webhook alert failure
  swapped `console.info` for `getLogger("cron.health").warn`
  (rationale comment preserved).
- `src/core/with-bootstrap-rehydrate.ts:59` outer migration
  swallow keeps `.catch(() => {})` pattern with an expanded
  comment cross-referencing the inner MIGRATION logger as
  authoritative.

**Test count delta:** 763 → 801 total (+38 new tests: 8
welcome-url-parser + 6 wizard-steps + 14 hooks + 3 mint-race + 2
UX-04 regressions + 5 knock-on). 37 UI tests isolated under
`vitest.ui.config.ts`.

**LOC delta:**

| File | Before | After |
|------|--------|-------|
| `app/welcome/welcome-client.tsx` | 2207 | 29 |
| `app/welcome/WelcomeShell.tsx` | — | 2194 |
| `app/welcome/WelcomeStateContext.tsx` | — | 140 |
| `app/welcome/steps/storage.tsx` | — | 70 |
| `app/welcome/steps/mint.tsx` | — | 100 |
| `app/welcome/steps/test.tsx` | — | 80 |
| `app/welcome/steps/already-initialized.tsx` | — | 85 |
| `app/welcome/hooks/useClaimStatus.ts` | — | 80 |
| `app/welcome/hooks/useStoragePolling.ts` | — | 120 |
| `app/welcome/hooks/useMintToken.ts` | — | 90 |
| `app/welcome/wizard-steps.ts` | — | 120 |
| `src/core/welcome-url-parser.ts` | — | 45 |

**Deferred (filed to FOLLOW-UP):**

- Full JSX migration from `WelcomeShell.tsx` into
  `app/welcome/steps/*.tsx` — the structural split is complete;
  the subtree migration is an incremental v0.12 follow-up with
  Playwright E2E as the safety net.
- `scripts/audit-gate.mjs` no-undef lint errors (pre-existing
  Phase 44 carry-over — eslint env missing for .mjs files).

### Phase 44 — Security supply chain + URL safety (SCM-01..05)

Landed 5 requirements in 6 atomic commits (`d957933`, `11cc628`, `6c0c8f0`, `e7b3cc2`, `c1f4639`, `547e4c2`).

**Supply chain:**
- `@modelcontextprotocol/sdk` bumped `^1.26.0` → `^1.29.0` within `mcp-handler` peer range.
- `KEBAB_BROWSER_CONNECTOR_V2=1` feature flag gates Stagehand v3 adapter dispatch in 4 browser tool handlers. Default OFF — v2 path stays active; operators opt in per deploy. Browser regression suite (16 cases: 4 tools × 2 flag states × 2 scenarios) covers both paths.
- `scripts/audit-gate.mjs` replaces the previous `npm audit --audit-level=high` CI step. Policy: FAIL on any high/critical, FAIL on direct-dep moderate unless allowlisted with reason + reviewBy, WARN on transitive-dep moderate. 1 allowlist entry (`@browserbasehq/stagehand`) tracks the langsmith CVEs — reviewBy 2026-07-01.
- Three moderate CVEs (`langsmith` SSRF + prototype pollution + output-redaction bypass) no longer block CI as `high`; they surface as tracked allowlisted direct + warning transitive every run.

**URL safety:**
- `src/core/url-safety.ts` consolidates `isPublicUrl`/`isPublicUrlSync` with RFC1918 + loopback + cloud-metadata + CGNAT + 0/8 + IPv4-mapped-IPv6 + DNS guards. Supersedes the divergent guards in `browserbase.ts` and `skills/lib/remote-fetcher.ts`.
- `src/core/fetch-utils.ts` gains `fetchWithTimeout`. 5 duplicate copies removed (`apify/lib/client.ts`, `skills/lib/remote-fetcher.ts`, `vault/lib/github.ts`, `paywall/lib/fetch-html.ts`, inline in `storage-mode.ts`). Each migrated callsite passes an explicit `timeoutMs` so default-timeout divergences don't regress.

**Policy docs:** `CONTRIBUTING.md` gains a "Security & supply chain policy" section documenting the gate, the allowlist contract, and the CVE-triage flow.

### Phase 43 — Performance & CI hardening (PERF-01/02/04/05 + CI-01..04)

Landed 4 perf wins + 4 CI gates in 8 atomic commits. PERF-03
(`serverExternalPackages`) was evaluated and deferred with a documented
rationale — Turbopack's current trace handling tripled the nft.json
footprint when the flag was enabled, defeating the intent.

- **PERF-01** `src/core/registry.ts` — lazy-load 14 connector manifests
  via `ALL_CONNECTOR_LOADERS` table. Disabled connectors (missing env
  vars, MYMCP_DISABLE_*, MYMCP_ENABLED_PACKS) never execute their
  manifest module. `resolveRegistryAsync()` is the primary entry point;
  concurrent resolves dedupe via an in-flight Map; `resolveRegistry()`
  (sync) throws when cold so no caller silently gets a stub. 11 callers
  migrated (`app/api/[transport]/route.ts`, `app/config/page.tsx`,
  admin/status, admin/verify, admin/call, health deep branch, cron/health,
  config/sandbox, config/skills, config/tool-schema, setup/test).
  `loadConnectorManifest(id)` added for the setup wizard's
  `testConnection()` on DRAFT credentials.
- **PERF-02** `app/config/tabs.tsx` — 9 tabs load via `next/dynamic()`;
  Overview stays eager. `/config` first-load JS drops 670,098 → 556,171
  bytes (−17.0%). Per-tab SSR config documented inline (ssr: false for
  Playground, Logs, Storage, Health; ssr: true for Connectors, Tools,
  Skills, Documentation, Settings).
- **PERF-04** `next.config.ts` — `experimental.optimizePackageImports:
  ["zod", "@opentelemetry/api"]`. Barrel-optimization effect on client
  bundles was negligible (Turbopack already concatenates; effect is
  primarily server-side) but the setting stays enabled for future edge
  routes and OTel-heavy paths.
- **PERF-05** `.size-limit.json` + `scripts/check-bundle-size.ts` —
  per-route first-load JS budget gate reading
  `.next/diagnostics/route-bundle-stats.json`. Custom script (not the
  `size-limit` CLI) because Turbopack's flat, hash-named chunk layout
  defeats per-route globs. Budgets at `ceil(actual * 1.10 / 10 KB)`:
  `/` = 560 KB, `/config` = 600 KB, `/welcome` = 610 KB. Current usage
  ~90% of cap across all 3 routes.
- **CI-01** `.github/workflows/ci.yml` — `strategy.matrix.node-version:
  [20, 22]` with `fail-fast: false`. Catches Node-20-only bugs +
  Node-22-only syntax pre-merge.
- **CI-02** `vitest.config.ts` — `coverage.thresholds.lines: 33 → 46`
  (floor(actual) ratchet). The v0.11 milestone 80% goal is NOT met;
  filed to FOLLOW-UP for a dedicated v0.12 coverage phase. The "Verify
  coverage thresholds" echo step in ci.yml was a placeholder — now
  enforced internally by vitest v8 provider.
- **CI-03** `.github/workflows/ci.yml` — removed `continue-on-error:
  true` on the knip step. Standalone cleanup commit
  (`chore(knip): b1fb3d1`) landed first with lint-staged + wait-on in
  the allowlist + husky plugin disabled; main-branch green.
- **CI-04** `.github/dependabot.yml` — split into 2 npm ecosystem
  blocks. Security block: daily, 10 PR cap, `applies-to:
  security-updates` group. Version-updates block: weekly, 5 PR cap,
  grouped by dep-family (typescript, testing, nextjs-core). Ensures
  CVE fixes are never queued behind minor bumps.

**Deferred (filed to FOLLOW-UP):**

- PERF-03 `serverExternalPackages` — regressed nft.json entries 417 →
  1574 (+277%) under Turbopack. Retry when Turbopack ships a
  `traceExternalPackages: false` option or equivalent.
- `/config` < 350 KB milestone goal — 543 KB actual; residual 543 KB is
  Next/React/Tailwind shell cost. Further reduction requires
  architectural work (RSC shell migration, Tailwind replacement).
- 80% coverage — 46.47% actual; requires dedicated v0.12 coverage phase.

**Commits (8 atomic on main):**
- `0a65680` chore(43): baseline bundle sizes + cold-start measurements
- `96b0550` perf(registry): lazy-load connector manifests (PERF-01)
- `2720d35` perf(dashboard): next/dynamic per /config tab (PERF-02)
- `53a00fa` perf(next): optimizePackageImports for zod + @opentelemetry/api (PERF-04)
- `b1fb3d1` chore(knip): allowlist lint-staged + wait-on (CI-03 prep)
- `b76925a` ci: bundle-size gate via per-route stats (PERF-05)
- `fcb7bda` ci: Node 20 + 22 matrix, coverage ratchet, size:check, un-gated knip (CI-01, CI-02)
- `9a71a48` ci(dependabot): split security-updates vs version-update (CI-04)

### Phase 42 — Tenant scoping completion (TEN-01..06)

Closes the "multi-tenant real" narrative opened by Phase 37b. Five files
that were still writing tenant-relevant data through the untenanted
`getKVStore()` path migrate to `getContextKVStore()`. A dual-read shim
(`src/core/migrations/v0.11-tenant-scope.ts`) keeps pre-v0.11 deploys
reading their legacy keys transparently during a 2-release transition
window; writes always land on the new (tenant-wrapped) keys.

- **TEN-01** `src/core/rate-limit.ts` — `checkRateLimit` routes through
  `getContextKVStore()`. Key body sheds its embedded tenantId:
  `ratelimit:<tenantId>:<scope>:<hash>:<bucket>` →
  `ratelimit:<scope>:<hash>:<bucket>` (TenantKVStore wraps to
  `tenant:<id>:ratelimit:...`). Atomic-path leniency during transition
  documented; 60-second bucket TTL bounds staleness.
  `app/api/admin/rate-limits/route.ts` default path is tenant-scoped;
  `?scope=all` restored as root-operator cross-tenant view.
- **TEN-02** `src/core/log-store.ts` — `getLogStore()` is now a
  per-tenant factory (`Map<tenantId, LogStore>`). Upstash list key
  `mymcp:logs` auto-wraps to `tenant:<id>:mymcp:logs`. Filesystem path
  becomes `data/logs.<tenantId>.jsonl` under a tenant context.
  `MYMCP_LOG_MAX_ENTRIES` applies per-tenant-per-list. The durable-log
  branch of `app/api/config/logs/route.ts` drops its application-code
  tokenId filter — namespace isolation handles it.
- **TEN-03** `src/core/tool-toggles.ts` — per-tenant disable flags.
  Cache keyed per-tenant (`Map<tenantId, {at, value}>`). Legacy
  un-wrapped flags dual-read via the shim. `env.changed` clears every
  tenant's cache.
- **TEN-04** `src/core/backup.ts` — default scope = current tenant.
  `opts.scope === "all"` restores the pre-v0.11 full-scan for root
  operators. BACKUP_VERSION bumps from 1 → 2 (adds top-level `scope`
  field). v1 backups still importable via compat branch. Cross-tenant
  contamination guard: importing a `scope: "all"` backup into a tenant
  namespace WITHOUT explicit `opts.scope='all'` is rejected.
  `scripts/backup.ts` CLI gains `--scope=all`.
- **TEN-05** `app/api/config/context/route.ts` — per-tenant Claude
  persona. `mymcp:context:inline` + `mymcp:context:mode` bare keys
  auto-wrap to `tenant:<id>:mymcp:context:*`. GET path dual-reads so
  pre-v0.11 operator deploys keep their inline context on first
  post-upgrade load.
- **TEN-06** `tests/contract/kv-allowlist.test.ts` ALLOWLIST shrinks
  from 19 → 15 entries. Removed: rate-limit.ts, log-store.ts,
  tool-toggles.ts, config/context/route.ts. Added:
  migrations/v0.11-tenant-scope.ts (new scanner — global by design).
  Retained with rationale: backup.ts (conditional scope=all path),
  admin/rate-limits/route.ts (?scope=all escape hatch).

**New migration shim** — `src/core/migrations/v0.11-tenant-scope.ts`:

- `dualReadKV(kv, newKey, legacyKey)` pure read-through helper
- `runV011TenantScopeMigration()` per-tenant first-boot inventory
  (marker key `tenant:<id>:migrations:v0.11-tenant-scope`)
- Legacy-key DELETE deferred to v0.13 (2-release transition window)

**Operator note:** no action required on upgrade. Pre-v0.11 data is
read through the shim for 2 releases; a per-tenant marker tracks
completion. After v0.13, legacy un-wrapped keys can be removed via a
forthcoming CLI (FOLLOW-UP).

**Testing:** 635 → 674 unit tests (+39 net). New:
`tests/integration/tenant-isolation-v0.11.test.ts` stitch test
exercises all 5 migrated surfaces under two concurrent tenants
(Promise.all + AsyncLocalStorage validation).

### Phase 41 — Composable request pipeline

The hand-rolled preamble that accumulated across the 6 entry-point
routes through v0.10 (`withBootstrapRehydrate` HOC → `isFirstRunMode()`
→ `checkMcpAuth` → `MYMCP_RATE_LIMIT_ENABLED` → `hydrateCredentialsFromKV`
→ `requestContext.run`) is now a single middleware-style composition:

```ts
export const POST = composeRequestPipeline(
  [rehydrateStep, firstRunGateStep, authStep("mcp"),
   rateLimitStep({ scope: "mcp", keyFrom: "token" }),
   hydrateCredentialsStep],
  transportHandler,
);
```

- **NEW** `src/core/pipeline.ts` — `composeRequestPipeline(steps, handler)`
  Koa-style `(ctx, next) => Promise<Response>`. 7 first-party steps:
  `rehydrateStep`, `firstRunGateStep`, `authStep('mcp' | 'admin' | 'cron')`,
  `rateLimitStep({ scope, keyFrom })`, `hydrateCredentialsStep`,
  `bodyParseStep({ maxBytes })`, `csrfStep`.
- **NEW** `src/core/with-admin-auth.ts` — thin HOC for the 27 admin
  routes that just need `rehydrate → admin-auth`. Collapses the 40-site
  `const authError = await checkAdminAuth(req); if (authError) return
  authError;` preamble to a single wrapper call. `grep 'checkAdminAuth('
  app/api/` drops from 34 to 6 (the 6 remaining are legit conditional
  auth ladders: storage-status, config/storage-status,
  welcome/starter-skills, setup/test, setup/save, health?deep=1).
- **FIX (CORRECTNESS)** Tenant-scoped rate-limit keys
  (POST-V0.10-AUDIT §B.2). `requestContext.run` now wraps the WHOLE
  pipeline, and `authStep` re-enters `requestContext.run({ tenantId })`
  on the MCP path so `rate-limit.ts:85 getCurrentTenantId()` observes
  the real tenant instead of always resolving to `"global"`. A 2-tenant
  integration test in `tests/core/pipeline/rate-limit-step.test.ts` and
  `tests/regression/transport-pipeline.test.ts` asserts the closure
  (tenant-A bursting a shared token does NOT 429 tenant-B).
- **NEW** Rate-limit gates on 4 surfaces (opt-in via
  `MYMCP_RATE_LIMIT_ENABLED=true`): `/api/webhook/[name]` (IP-keyed,
  30/min), `/api/cron/health` (CRON_SECRET tokenId-keyed, 120/min),
  `/api/welcome/claim` (IP-keyed, 10/min). `/api/[transport]` token-
  keyed gate was already present — now also sees tenantId.
- **MIGRATION** 6 entry-point routes converted to the pipeline:
  `[transport]`, `admin/call`, `welcome/init`, `storage/status`,
  `webhook/[name]`, `cron/health`. 27 admin routes converted to
  `withAdminAuth()` HOC. 5 routes with bespoke auth ladders converted
  to partial pipelines (rehydrate only): `welcome/starter-skills`,
  `welcome/status`, `welcome/test-mcp`, `setup/test`, `setup/save`,
  `config/storage-status`.
- **NEW** Contract test `tests/contract/pipeline-coverage.test.ts` —
  fails the build if a new `app/api/**/route.ts` exports a handler
  without `composeRequestPipeline(` / `withAdminAuth(` usage or a
  first-10-lines `PIPELINE_EXEMPT: <reason>` marker. Two routes
  grandfathered exempt: `app/api/health/route.ts` (1.5s budget on
  uptime-monitor hot path), `app/api/auth/google/callback/route.ts`
  (public OAuth redirect with no state to wire through).
- **CLEANUP** (T20 fold-in) `src/core/first-run.ts:609` module-load
  `rehydrateBootstrapFromTmp()` disk-read side effect removed —
  pipeline's `rehydrateStep` is the single deterministic entry. Fixes
  test-order dependence documented in ARCH-AUDIT §3.
- **CLEANUP** `app/api/cron/health/route.ts` historical silent swallow
  (`.catch(() => {})`) around error-webhook alert converted to
  log-then-swallow, keeping `no-silent-swallows` contract green.
- **COMPAT** `withBootstrapRehydrate` remains exported (PIPE-07) and is
  the implementation backing `rehydrateStep` (same `rehydrateBootstrapAsync`
  + one-shot migration trigger, same module flag). Existing
  `BOOTSTRAP_EXEMPT:` markers still honored by `route-rehydrate-coverage`
  contract (now also accepts `composeRequestPipeline(` /
  `withAdminAuth(` as rehydrate-on-entry shapes). **No public endpoint
  contract changes** — all URL paths + response shapes + status codes
  preserved.

Test delta: 554 → 636 (+82 new tests, 18 pipeline core + 29 step units + 4
withAdminAuth unit + 6 transport regression + 14 admin/welcome/storage
regression + 9 rate-limit regression + 1 enforced pipeline-coverage
contract + 1 enabled pipeline-coverage contract).

## [0.10.0] — Unreleased — Durability audit hardening

The v0.10 milestone is the preventive hardening pass triggered by the
2026-04-20 durability debugging session (17 production bugs shipped in
a single day across the welcome / bootstrap / cold-start flow on
Vercel) and the 2026-04-21 deep risk audit (4 exploitable findings
filed as GHSA candidates). Five phases:

- Phase 37b — Security critical fixes (SEC-01..06)
- Phase 37 — Durability primitives (DUR-01..07)
- Phase 38 — Safety & observability (SAFE-01..04, OBS-01..05)
- Phase 39 — Multi-host compatibility (HOST-01..06)
- Phase 40 — Test coverage & documentation (TEST-01..05, DOC-01..05)

The subsections below map 1:1 to those phases. No breaking changes
for operators. Connector authors should read **Fork-maintainer
notes** below — the `process.env` read semantics tightened.

### Fork-maintainer notes

The architectural changes forks should be aware of before pulling v0.10:

- **`proxy.ts` is now async.** If your fork wraps or composes
  middleware, re-check that your wrapper handles the `Promise<NextResponse>`
  return type. Pre-v0.10 proxy was effectively sync.
- **`process.env.X` reads inside handlers see the boot-time snapshot
  only.** Request-scoped credential overrides (dashboard saves,
  per-tenant creds) must migrate to `getCredential("X")` from
  `@/core/request-context`. An ESLint rule blocks
  `process.env[...] = ...` assignments outside the allowlisted boot
  path. Back-compat preserved for v0.10.x; v0.11 adds migration
  enforcement for connector handlers.
- **Both Upstash env var variants are recognized.**
  `UPSTASH_REDIS_REST_*` AND `KV_REST_API_*`. `getUpstashCreds()` is
  the only legitimate reader — a contract test blocks direct reads.
- **Welcome refuses to mint claims without durable KV.** Set Upstash
  env vars OR `MYMCP_ALLOW_EPHEMERAL_SECRET=1` for local dev. Public
  Vercel deploys without either now return 503 with an actionable
  operator error instead of silently minting a forgeable-tomorrow
  token.
- **Signing secret is KV-persisted.** Forks must either configure
  Upstash or opt into ephemeral secrets explicitly. The pre-v0.10
  `VERCEL_GIT_COMMIT_SHA`-derived secret is gone (SEC-04 fix).
- **`proxy.ts` matcher ordering.** Showcase mode (`INSTANCE_MODE=showcase`)
  short-circuits BEFORE the first-run check, so public template
  deploys no longer redirect through `/welcome` on cold lambdas.

### Phase 37b — Security critical fixes (SEC-01..06)

Expedited security release closing four findings from the 2026-04-20
deep risk audit (`.planning/research/RISKS-AUDIT.md`). See
`docs/SECURITY-ADVISORIES.md` for the full advisory index and
disclosure timeline.

#### Security

- **SEC-04 ([GHSA-pv2m-p7q3-v45c](https://github.com/Yassinello/kebab-mcp/security/advisories/GHSA-pv2m-p7q3-v45c))** — First-run claim-cookie HMAC signing
  secret was previously derived from `VERCEL_GIT_COMMIT_SHA`, a public
  value. An attacker who could read the commit SHA (trivial on public
  GitHub repos and Vercel preview URLs) could forge a valid claim
  cookie and hijack `/api/welcome/init` on any fresh public Vercel
  deploy that had not yet completed welcome bootstrap. The signing
  secret is now `randomBytes(32)`, KV-persisted at
  `mymcp:firstrun:signing-secret`, and rotated on
  `MYMCP_RECOVERY_RESET=1`. Advisory draft filed 2026-04-21 (publish
  from the GitHub Security tab when ready).
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

#### Breaking (connector authors)

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

#### Added

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

#### Deferred to v0.11+

Documented in `.planning/phases/37b-security-hotfix/FOLLOW-UP.md`:

- `src/core/rate-limit.ts`, `src/core/log-store.ts`,
  `src/core/tool-toggles.ts`, `src/core/backup.ts`,
  `app/api/config/context/*` tenant-scoping
- `langsmith` transitive CVEs via Stagehand
- Welcome-init race (two browsers racing the same claim cookie)
- Unbounded `health:sample:*` growth (folded in partially — 7d TTL
  added now; broader observability work in Phase 38)
- `log-store.ts:319` 5xx retry heuristic (Phase 38)

### Phase 37 — Durability primitives (DUR-01..07)

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

### Phase 38 — Safety & observability (SAFE-01..04, OBS-01..05)

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

#### Fixed (Phase 38 fold-ins)

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

### Phase 39 — Multi-host compatibility (HOST-01..06)

Validation pass to make sure the serverless-aware fixes from Phases
37b/37/38 do not silently break persistent-process deployments.

- **HOST-01** — `docs/HOSTING.md` host matrix covering Vercel,
  Docker (1 replica and N replicas), Fly.io, Render, Cloud Run, and
  bare-metal. Columns: persistence default, scaling model, required
  env vars, healthcheck path, SIGTERM handling, volume mount,
  migration checklist from Vercel.
- **HOST-02** — `Dockerfile` hardens the multi-stage dev-deps split,
  adds a graceful 5s SIGTERM drain, and ships a `.dockerignore`
  pruning `.next/dev/` + test artifacts from the build context.
  Healthcheck wired to `/api/health`.
- **HOST-03** — `docs/examples/` ships two working compose files:
  single-replica + filesystem KV (dev loop), N-replica + Upstash KV
  (production). Both exercise the `./data` volume mount pattern.
- **HOST-04** — `tests/integration/multi-host.test.ts` simulates
  three host scenarios in pure vitest (zero Docker dependency):
  cross-process state via shared KV, RECOVERY_RESET refusal on a
  persistent process, N-replica rate-limit convergence through a
  shared atomic-incr path.
- **HOST-05** — Rate-limit storage is KV-backed by default. The
  in-memory fast path is gated behind `MYMCP_RATE_LIMIT_INMEMORY=1`
  (explicit opt-in), so N-replica deploys don't silently diverge.
- **HOST-06** — `MYMCP_DURABLE_LOGS=1` documented as the default
  for Docker-N / Fly / Render / Cloud Run rows in `docs/HOSTING.md`.
  Single-replica dev loop keeps logs in-memory by default.

### Phase 40 — Test coverage & documentation (TEST-01..05, DOC-01..05)

Closes the gap between "436 unit tests pass" and "17 production bugs
shipped this session." Every session bug gets a regression test; the
welcome flow gains integration + E2E coverage; fork maintainers get
the documentation they need to run Kebab MCP without tailing Vercel
logs.

- **TEST-01** — `tests/integration/welcome-durability.test.ts`
  simulates cross-lambda rehydrate (lambda A mints + flushes, lambda
  B rehydrates from shared KV), cold-start after Vercel reap,
  HMAC-signed claim cookie trusted across cold lambdas (BUG-15), and
  SEC-05 refusal on no-durable-KV production deploys. Uses
  `vi.resetModules()` + `/tmp` clearing to model lambda boundaries.
- **TEST-02** — `tests/e2e/welcome.spec.ts` Playwright spec covering
  `/config?token=` handoff (BUG-03), `/welcome` render on both
  first-run and already-initialized branches, paste-token form
  visibility, and fresh-context cookie handoff. Cold-start mid-flow
  is not implemented as Playwright (would require dev-server
  restart); covered by TEST-01 instead. Rationale documented in
  `tests/e2e/README.md`.
- **TEST-03** — Five themed regression files under
  `tests/regression/` covering all 17 session bugs:
  `welcome-flow.test.ts` (6), `storage-ux.test.ts` (3),
  `kv-durability.test.ts` (4), `bootstrap-rehydrate.test.ts` (2),
  `env-handling.test.ts` (2). One `it()` per bug; assertion names
  start with the BUG-NN ID; test file headers list the commit SHAs
  they pin.
- **TEST-04** — `tests/core/proxy-async-rehydrate.test.ts` —
  additive unit test proving `proxy()` awaits
  `ensureBootstrapRehydratedFromUpstash()` at middleware entry. Not
  a duplicate of `csp-middleware.test.ts` or `request-id.test.ts` —
  this file targets the async rehydrate seam specifically (BUG-09,
  BUG-10).
- **TEST-05** — `npm run test:e2e` now targets Playwright; the
  legacy tools/list smoke is preserved as `test:e2e:legacy`. New
  `.github/workflows/test-e2e.yml` runs the Playwright suite against
  a spun-up dev server on PR touching welcome / middleware /
  bootstrap surfaces. Non-blocking for forks without GH secrets —
  durability scenarios skip gracefully when `UPSTASH_REDIS_REST_*`
  is unset.
- **DOC-01** — `CLAUDE.md` gains a new `## Durable bootstrap
  pattern` section covering the rehydrate contract
  (`withBootstrapRehydrate` HOC / inline `rehydrateBootstrapAsync()`
  / `BOOTSTRAP_EXEMPT:` tag), the middleware seam
  (`ensureBootstrapRehydratedFromUpstash` in `first-run-edge.ts`),
  the fire-and-forget ban (contract-test enforced), and the Upstash
  env-variant unification (`getUpstashCreds()`).
- **DOC-02** — `README.md` Quick Start → Vercel section gains a
  FAQ block covering `MYMCP_RECOVERY_RESET`, KV-not-set symptoms,
  Upstash naming variants (both are recognized), and the
  loop-back-to-`/welcome` three-cause checklist.
- **DOC-03** — This CHANGELOG entry reorganized into per-phase
  subsections (37b / 37 / 38 / 39 / 40) with a Fork-maintainer-notes
  callout at the top. The 17-bug list below catalogs the session
  bugs at summary level, each linked to its TROUBLESHOOTING case
  study.
- **DOC-04** — `docs/TROUBLESHOOTING.md` — new symptom-first index.
  17 BUG case studies + 4 SEC findings + 5 FAQ entries, each
  linking to the fix commit and the regression test.
- **DOC-05** — `README.md` nav gains Troubleshooting + Hosting
  entries; a new `## Documentation` section near the bottom lists
  all top-level docs (TROUBLESHOOTING, HOSTING, CONNECTORS,
  SECURITY-ADVISORIES, CLAUDE.md, CHANGELOG, CONTRIBUTING,
  SECURITY).

### The 17 session bugs (high level)

Authoritative count walked from `git log cdd3979..4e6fa0c` (16
session commits, one bundled 2 bugs = 17 total). Per-bug detail in
[`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) and
`.planning/phases/40-test-coverage-docs/BUG-INVENTORY.md`.

- BUG-01 (`4e6fa0c`) — Paste-token form rejected full MCP URL.
- BUG-02 (`bc31b69`) — "Already initialized" screen had no paste-token form.
- BUG-03 (`83b5a8e`) — Welcome handoff landed users on 401.
- BUG-04 (`f818e01`) — Step-3 Test MCP stuck on durable-no-auto-magic deploys.
- BUG-05 (`5273add`) — `MYMCP_RECOVERY_RESET=1` silently wiped tokens on every cold lambda.
- BUG-06 (`1460841`) — Init silently succeeded while KV persist failed.
- BUG-07 (`95f0df7`) — Fire-and-forget KV SET lost to Vercel reap.
- BUG-08 (`95f0df7`) — Edge rehydrate spoke wrong REST dialect.
- BUG-09 (`7f6ec80`) — Middleware didn't read `KV_REST_API_URL` alias.
- BUG-10 (`7325aa8`) — Middleware blind to KV bootstrap on cold lambdas.
- BUG-11 (`100e0b9`) — MCP transport handler never rehydrated.
- BUG-12 (`ccdaa3d`) — Token minted BEFORE storage configured.
- BUG-13 (`c339fc7`) — Storage step gave three equal-weight options.
- BUG-14 (`ab47f8d`) — `/api/storage/status` 401'd during bootstrap.
- BUG-15 (`748161d`) — `isClaimer` required in-memory match across cold lambdas.
- BUG-16 (`0b5c737`) — Welcome step 2 stuck on "Detecting your storage…".
- BUG-17 (`d747a1f`) — Showcase mode locked behind first-run gate.

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

