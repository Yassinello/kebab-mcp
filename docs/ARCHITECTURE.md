# Architecture & Contributor Guide

Reading this if you want to: add a connector, add a tool, change auth/registry, or understand why the framework looks the way it does. For first-time setup of an instance, see [README.md](../README.md).

> **Note:** this document was previously called `CLAUDE.md` at the repo root. It moved here in 2026-04 because (a) the contents are useful for any contributor regardless of which AI tooling they use, and (b) keeping a personal-AI-context file at the root invited dropping credentials or private workflow notes into a publicly-tracked file. Don't put secrets anywhere in this repo — see [SECURITY.md](SECURITY.md).

## Project Overview

Open-source personal MCP server framework. Ships 100+ pre-built tools across 17 connectors (Google Workspace, Obsidian Vault, Browser Automation, Slack, Notion, Composio, Skills, API Connections, Custom Tools, Paywall, Apify, Unipile (LinkedIn + WhatsApp), GitHub, Linear, Airtable, Webhook, Admin) — plus dynamic, user-defined tools via the Skills, API Connections, and Custom Tools connectors. Deployed on Vercel or Docker as a Next.js app. Config-driven: connectors auto-activate based on env vars.

## Architecture

- **Runtime**: Next.js on Vercel (serverless). The MCP transport route declares `maxDuration = 90` (90s); Vercel Hobby plans silently clamp this to 60s, Pro allows up to 300s
- **MCP SDK**: `mcp-handler` wraps `@modelcontextprotocol/sdk` for Streamable HTTP
- **Registry**: Static manifests in `src/connectors/*/manifest.ts` — single source of truth
- **Config**: All via env vars (no config files). See `src/core/config.ts`
- **Auth**: MCP_AUTH_TOKEN (endpoint) + ADMIN_AUTH_TOKEN (dashboard, optional fallback)

## Key Directories

```
src/core/                        — Framework: types, registry, config, auth, logging, events, tracing
src/connectors/google/manifest.ts        — Google Workspace connector (18 tools)
src/connectors/vault/manifest.ts          — Obsidian Vault connector (14 tools)
src/connectors/browser/manifest.ts        — Browser Automation connector (7 tools)
src/connectors/slack/manifest.ts          — Slack connector (6 tools)
src/connectors/notion/manifest.ts         — Notion connector (5 tools)
src/connectors/apify/manifest.ts          — Apify / LinkedIn scraping connector (10 tools)
src/connectors/unipile/manifest.ts        — Unipile LinkedIn + WhatsApp connector (10 tools)
src/connectors/github/manifest.ts         — GitHub Issues connector (6 tools)
src/connectors/linear/manifest.ts         — Linear Issues connector (6 tools)
src/connectors/airtable/manifest.ts       — Airtable connector (7 tools)
src/connectors/composio/manifest.ts       — Composio bridge (2 tools)
src/connectors/paywall/manifest.ts        — Paywall readers (1 tool, +1 conditional on Browser)
src/connectors/webhook/manifest.ts        — Webhook receiver (3 tools)
src/connectors/skills/manifest.ts         — Skills — dynamic user-defined tools
src/connectors/api/manifest.ts            — API Connections — user-defined HTTP tools (v0.15+)
src/connectors/custom-tools/manifest.ts   — Custom Tools — composed from existing tools via JSON spec
src/connectors/admin/manifest.ts          — Admin connector (5 tools)
src/connectors/*/tools/               — Individual tool handlers
src/connectors/*/lib/                 — API wrappers and helpers
app/api/[transport]/route.ts     — MCP endpoint (~30 lines, reads from registry)
app/api/health/route.ts          — Public liveness: { ok, version }
app/api/admin/status/route.ts    — Private diagnostics (auth-gated)
app/api/webhook/[name]/route.ts  — Inbound webhook receiver
app/page.tsx                     — Landing page or redirect to /config
app/welcome/page.tsx             — First-run setup + welcome flow
app/config/                      — Unified dashboard (connectors, tools, skills, logs, settings)
```

## How the Registry Works

1. `src/core/registry.ts` holds `ALL_CONNECTOR_LOADERS` — one lazy loader entry per connector (17 today)
2. For each connector, checks if all `requiredEnvVars` are present
3. Returns `ConnectorState[]` with enabled/disabled + reason
4. `route.ts` iterates enabled connectors, registers tools via `server.tool()`
5. Dashboard, health, admin API all read from the same registry

## Durable bootstrap pattern

Kebab MCP runs on Vercel serverless lambdas, which means any in-memory
state (`MCP_AUTH_TOKEN`, signing secret, first-run mode flag) is lost on
cold start. The framework persists this state to Upstash KV and
rehydrates on-demand at every auth-gated entry point.

### The rehydrate contract

Every auth-gated API route handler MUST do one of:

1. Wrap the handler in `withBootstrapRehydrate(handler)` from
   `src/core/with-bootstrap-rehydrate.ts` (declarative, preferred —
   the HOC calls `rehydrateBootstrapAsync()` before the inner handler
   and also fires the one-shot v0.10 tenant-prefix migration on the
   first invocation per process).
2. Call `rehydrateBootstrapAsync()` at function entry (explicit —
   legacy pattern, most routes migrated to the HOC during Phase 37
   DUR-01).
3. Mark itself exempt with a `// BOOTSTRAP_EXEMPT: <reason>` comment
   in the first 10 lines of the file. The only legitimate exemptions
   are `/api/health` (public liveness) and the handful of callback
   endpoints (`/api/auth/google/callback`, `/api/webhook/[name]`,
   `/api/cron/health`).

A contract test (`tests/contract/route-rehydrate-coverage.test.ts`)
fails the build if a new auth-gated route is added without the wrapper
or an explicit exemption. Do NOT silence the test — if a new route
truly does not need rehydrate, document why with the exempt tag.

### When rehydrate fails

`rehydrateBootstrapAsync()` is idempotent and short-circuits if the
in-memory bootstrap cache is already populated (warm lambda). On a cold
lambda with KV unreachable, it logs at `[FIRST-RUN]` and returns — the
env stays unchanged, and subsequent auth checks 401. This is
intentional: we refuse to serve an unauthenticated request rather than
serve a misconfigured one.

### Middleware seam

The request-entry middleware (`proxy.ts`) also rehydrates via
`ensureBootstrapRehydratedFromUpstash()` from
`src/core/first-run-edge.ts` — an Edge-runtime-safe variant that hits
Upstash REST directly (no `node:fs`). This guarantees that by the
time any handler runs, the bootstrap auth cache is populated if KV
has it. Route handlers still call `rehydrateBootstrapAsync()` as
defense-in-depth, via the `withBootstrapRehydrate` HOC.

### Fire-and-forget rule

KV writes in route handlers MUST be awaited. Fire-and-forget
`void persistBootstrapToKv(...)` is banned — Vercel's reaper can kill
in-flight promises before they resolve, which was the root cause of
one of the 2026-04-20 session's shipped bugs (see `BUG-07` in
[`TROUBLESHOOTING.md`](TROUBLESHOOTING.md)). The contract
test `tests/contract/fire-and-forget.test.ts` enforces this via grep.

If you genuinely need fire-and-forget (metrics, logs, recovery
cleanup where the caller cannot block), annotate the callsite with a
`// fire-and-forget OK: <reason>` comment — the grep test treats
annotated lines as allowed.

### Upstash env var variants

Both `UPSTASH_REDIS_REST_*` (manual Upstash setup) and `KV_REST_API_*`
(Vercel Marketplace Upstash KV) are recognized by `getUpstashCreds()`
in `src/core/upstash-env.ts`. Do **not** read these env vars directly
— route all access through the helper. Contract test:
`tests/contract/upstash-env-single-reader.test.ts`.

If both variants are set, `UPSTASH_REDIS_REST_*` wins (explicit
configuration over Marketplace default). The `UpstashCreds.source`
field exposes the active variant for observability hints.

### Reference

Case studies for every bug that motivated this pattern:
[TROUBLESHOOTING.md](TROUBLESHOOTING.md). The durability
integration test lives at
`tests/integration/welcome-durability.test.ts`.

## Adding a Tool

1. Create `src/connectors/<connector>/tools/my-tool.ts` with `{ schema, handler }` exports
2. Add entry to connector's `manifest.ts` tools array
3. Done — registry picks it up automatically

## Adding a Connector

You can scaffold the boilerplate in one command:

```bash
npm run scaffold:connector mything --label "My Thing" --env MYTHING_API_KEY
```

This generates `src/connectors/mything/manifest.ts`, a stub `tools/hello.ts`, patches `src/core/registry.ts`, and appends env-var stubs to `.env.example`. Then edit the manifest to add real tools.

Manual route (if you prefer):

1. Create `src/connectors/myconnector/manifest.ts` exporting a `ConnectorManifest`
2. Add a `ConnectorLoaderEntry` (id + label + description + requiredEnvVars + `toolCount` + `loader: () => import(...)`) to `src/core/registry.ts` `ALL_CONNECTOR_LOADERS` table — v0.11 Phase 43 replaced the static `ALL_CONNECTORS` array with lazy loaders (PERF-01). Keep `toolCount` in sync with `manifest.tools.length`; a contract test enforces this
3. Document required env vars in `.env.example`

## Bundle-size gate

PERF-05 (Phase 43) adds a CI gate that fails on first-load JS regressions.

- Budgets live in `config/size-limit.json` (route + byte limit)
- Enforced by `scripts/check-bundle-size.ts` reading
  `.next/diagnostics/route-bundle-stats.json`
- CI runs `npm run size:check` after `npm run build`
- Default headroom: 10% over the Phase-43 final measurements

**When CI fails on `size:check`:**

- If your change legitimately added weight (new connector, new major
  dep): bump the budget in `config/size-limit.json` by the minimum needed and
  include a 1-line rationale in the commit body. Don't add more
  headroom than required — the budget is a ratchet, not a target.
- If the regression is unexpected: run `npm run build` locally, inspect
  `.next/diagnostics/route-bundle-stats.json`, compare `firstLoadChunkPaths`
  against the prior build to find the added chunk. Fix before bumping
  the budget.

## Framework vs Instance

**Framework-level** (code, shared by all users):
- Connector manifests, registry, types, auth, dashboard structure
- NO personal references, NO hardcoded locale/timezone/names

**Instance-level** (env vars, unique per deployment):
- Secrets (API keys, tokens)
- Settings (MYMCP_TIMEZONE, MYMCP_LOCALE, MYMCP_DISPLAY_NAME)
- Connector activation (presence of credentials)

## Conventions

- Tool handlers export `{ schema, handler }` pattern
- Every tool is wrapped in `withLogging()` via the registry
- Use `getInstanceConfig()` for timezone/locale — never hardcode
- Descriptions are generic (no personal names or pronouns)
- Google API responses use typed interfaces (not `any`)
- Commit messages: `feat:` / `fix:` / `refactor:` / `docs:` / `chore:`

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MCP_AUTH_TOKEN` | Yes | MCP endpoint auth |
| `ADMIN_AUTH_TOKEN` | No | Dashboard auth (fallback: MCP_AUTH_TOKEN) |
| `KEBAB_ADMIN_TOKEN_FALLBACK` | No | Set to `1` to opt back into the legacy fallback (MCP token also grants admin) in production. Default: hard-fail in prod when `ADMIN_AUTH_TOKEN` is missing but `MCP_AUTH_TOKEN` is set. |
| `KEBAB_SKILLS_HMAC_SECRET` | No | If set (>=32 chars), every remote-skill fetch must carry an `x-skill-signature: hex(hmac-sha256(secret, body))` header. Prevents MITM injecting prompt content. |
| `GOOGLE_CLIENT_ID` | Google connector | OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google connector | OAuth client secret |
| `GOOGLE_REFRESH_TOKEN` | Google connector | OAuth refresh token |
| `GITHUB_PAT` | Vault connector | GitHub PAT with `repo` scope |
| `GITHUB_REPO` | Vault connector | `owner/repo` format |
| `GITHUB_BRANCH` | No | Default branch (default: `main`) |
| `BROWSERBASE_API_KEY` | Browser connector | Browserbase API key |
| `BROWSERBASE_PROJECT_ID` | Browser connector | Browserbase project ID |
| `OPENROUTER_API_KEY` | Browser connector | OpenRouter API key for Stagehand |
| `SLACK_BOT_TOKEN` | Slack connector | Slack Bot User OAuth Token |
| `NOTION_API_KEY` | Notion connector | Notion Internal Integration Token |
| `MYMCP_TIMEZONE` | No | Default: `UTC` |
| `MYMCP_LOCALE` | No | Default: `en-US` |
| `MYMCP_DISPLAY_NAME` | No | Default: `User` |
| `MYMCP_CONTEXT_PATH` | No | Default: `System/context.md` |
| `APIFY_TOKEN` | Apify connector | Apify API token |
| `GITHUB_TOKEN` | GitHub connector | GitHub PAT for Issues connector |
| `GITHUB_DEFAULT_REPO` | No | Default repo for GitHub Issues (owner/repo) |
| `LINEAR_API_KEY` | Linear connector | Linear personal API key |
| `AIRTABLE_API_KEY` | Airtable connector | Airtable personal access token |
| `COMPOSIO_API_KEY` | Composio connector | Composio API key |
| `UNIPILE_DSN` | Unipile connector | Unipile API DSN (e.g. `https://apiXX.unipile.com:NNNNN`) |
| `UNIPILE_TOKEN` | Unipile connector | Unipile API token |
| `UNIPILE_WEBHOOK_SECRET` | No | Shared static secret for verifying inbound Unipile webhooks at `/api/unipile/webhook` |
| `KEBAB_UNIPILE_LINKEDIN_WRITES_DISABLED` | No | Global kill switch — set to `true` to halt all LinkedIn write tools (connect, DM, InMail, engage) |
| `KEBAB_UNIPILE_LINKEDIN_DAILY_CONNECT_CAP` | No | Max LinkedIn connection requests per day (default: 25) |
| `KEBAB_UNIPILE_LINKEDIN_WEEKLY_CONNECT_CAP` | No | Max LinkedIn connection requests per week (default: 100) |
| `KEBAB_UNIPILE_LINKEDIN_DAILY_DM_CAP` | No | Max LinkedIn DMs per day (default: 50) |
| `KEBAB_UNIPILE_LINKEDIN_DAILY_INMAIL_CAP` | No | Max LinkedIn InMails per day (default: 15) |
| `KEBAB_UNIPILE_RATELIMIT_FAIL_MODE` | No | `closed` (default — refuse on quota-store error) or `open` (allow) |
| `MYMCP_WEBHOOKS` | Webhook connector | Comma-separated webhook names |
| `INSTANCE_MODE` | No | Set to `showcase` to render the marketing landing on `/`. Otherwise `/` redirects to `/welcome` (no token) or `/config` (token present). |
| `MYMCP_TOOL_TIMEOUT` | No | Tool timeout in ms (default: 30000) |
| `MYMCP_ERROR_WEBHOOK_URL` | No | Webhook URL for error alerts |
| `MYMCP_DURABLE_LOGS` | No | Persist logs to KV store (default: false) |
| `MYMCP_RATE_LIMIT_ENABLED` | No | Enable per-token rate limiting (default: false) |
| `MYMCP_RATE_LIMIT_RPM` | No | Max requests per token per minute (default: 60) |
| `KEBAB_API_CONN_ALLOW_LOCAL` | No | Dev-only: allow custom API connections to point at loopback / private networks. Refused at runtime in production (NODE_ENV=production or VERCEL=1) — would defeat SSRF protection on cloud-metadata IPs. |
| `OTEL_SERVICE_NAME` | No | Enables OTel tracing when set |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | OTLP HTTP endpoint (default: localhost:4318) |
| `UPSTASH_REDIS_REST_URL` | No | Upstash Redis URL for production KV |
| `UPSTASH_REDIS_REST_TOKEN` | No | Upstash Redis token |
| `CRON_SECRET` | No | Auth for /api/cron/health |

## Security Notes

- `crypto.timingSafeEqual` for all auth comparisons
- SSRF protection in browser tools (blocks private IPs, cloud metadata)
- Error messages sanitized (API keys stripped)
- OAuth uses state parameter + PKCE
- Health endpoint is public but returns minimal info only
- Dashboard/welcome are auth-gated via middleware
- Optional HMAC signature on remote skills (`KEBAB_SKILLS_HMAC_SECRET`)
- Admin token isolation enforced in production (see `KEBAB_ADMIN_TOKEN_FALLBACK`)

For the responsible disclosure process, see [SECURITY.md](SECURITY.md).
