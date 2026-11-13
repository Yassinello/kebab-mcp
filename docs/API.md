# Kebab MCP — API Reference

Route-by-route reference for all 42 HTTP endpoints under `app/api/**`. This document is the operator-facing counterpart to [CONNECTORS.md](CONNECTORS.md) (tools) and [HOSTING.md](HOSTING.md) (deployment).

## Conventions

- **Auth gates:** three scopes — `MCP_AUTH_TOKEN` for `/api/[transport]`, the admin cookie (`kebab_admin_token` or the legacy `mymcp_admin_token`) for `/api/admin/*` + `/api/config/*`, per-route tokens for the rest.
- **Pipeline:** every request-handling route (except `PIPELINE_EXEMPT` ones) composes through `src/core/pipeline.ts` (see [CONNECTORS.md § Pipeline](CONNECTORS.md)). Rate-limit + auth + CSRF + first-run gate + body parse run in one ordered chain.
- **Rate limits:** `KEBAB_RATE_LIMIT_RPM` (default 60). Per-tenant bucket keying was added in Phase 41. The legacy `MYMCP_RATE_LIMIT_RPM` is still read via the Phase 50 alias fallback.
- **Error shape:** 4xx/5xx bodies are plain text unless noted otherwise; the MCP endpoint returns Streamable HTTP. Sanitization strips token values from error messages.
- **Conditional auth** means the route inspects headers before gating: `/api/config/*` allows unauthenticated GET when `INSTANCE_MODE=showcase` but not when personal.

Routes below are grouped by concern (9 groups).

---

## /api/[transport] — MCP endpoint

### POST /api/[transport]

- **Auth:** Bearer `MCP_AUTH_TOKEN` (required unless loopback dev)
- **Body:** MCP Streamable HTTP envelope (JSON-RPC 2.0)
- **Pipeline:** rehydrate → auth → rateLimit → firstRunGate → bodyParse → csrf → handler
- **Rate limit:** `KEBAB_RATE_LIMIT_RPM` (default 60 per token, per-tenant bucket)
- **Tenant header:** `x-mymcp-tenant: <id>` optional (Phase 42 — renamed to `x-kebab-tenant` is a Phase 51+ candidate; legacy accepted for the 2-release transition)
- **Response:** Streamable HTTP response forwarded from `mcp-handler` 2.x — JSON or a one-event SSE stream
- **Protocol generations:** 2026-07-28 clients (`server/discover`, per-request `_meta` envelope + `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` headers) and 2025-era clients (`initialize`, served statelessly) on the same URL — see [ADR 0005](adr/0005-mcp-protocol-generation.md)
- **Example methods:** `tools/list`, `tools/call`, `resources/list`, `resources/read` (Phase 50), `prompts/list`, `prompts/get`
- **Path:** only `/api/mcp` is served; any other `[transport]` value (including the retired HTTP+SSE paths `/api/sse` and `/api/message`) answers `404 Not found` after auth

### GET / DELETE /api/[transport]

- **Auth:** Bearer `MCP_AUTH_TOKEN`
- **Response:** `405 Method not allowed` — serving is stateless, so there is no 2025 session stream to open (GET) or terminate (DELETE)

---

## /api/health — Public liveness

### GET /api/health

- **Auth:** PUBLIC (no gate)
- **Body:** none
- **Response shape:**
  ```json
  { "ok": true, "version": "0.12.0", "uptime": 12345 }
  ```
- **Hard cap:** 1.5s (Phase 38 — never hangs on slow Upstash; returns `kv.reachable: false` if KV probe exceeds budget)
- **Use case:** load-balancer + uptime monitor probe

### GET /api/config/health

- **Auth:** admin cookie
- **Purpose:** deeper health probe (backend-by-backend breakdown — KV, env store, connector registry) for the dashboard.

---

## /api/admin/* — Admin surface

All routes in this group: admin cookie required (HttpOnly `kebab_admin_token` or legacy `mymcp_admin_token`). Non-GET requests additionally pass the Origin-header CSRF check (`src/core/auth.ts#checkCsrf`).

### GET /api/admin/status

- **Auth:** admin
- **Body:** none
- **Response:** diagnostics JSON — connector enable/disable reasons, env-var presence flags, uptime, KV reachability.
- **Use case:** dashboard `/config` overview tab.

### GET /api/admin/metrics

- **Auth:** admin
- **Response:** Phase 38 metrics — tool-call counts, p95 latency, error rate (per-tool + per-token aggregates from `src/core/logging.ts` ring buffer).

### GET /api/admin/health-history

- **Auth:** admin
- **Query:** `?hours=6` (optional window)
- **Response:** rolling health samples (persisted by the `/api/cron/health` job).

### GET|POST /api/admin/rate-limits

- **Auth:** admin
- **Query:** `?scope=all` for root operator (Phase 42 cross-tenant visibility)
- **GET:** current buckets (per-token, per-tenant)
- **POST:** reset a bucket (body: `{ token: string }`)

### GET /api/admin/stats

- **Auth:** admin
- **Response:** aggregate request stats over 24h.

### POST /api/admin/call

- **Auth:** admin
- **Body:** `{ tool: string, params: Record<string, unknown> }`
- **Pipeline:** same as `[transport]` but bypasses the MCP wrapping — the dashboard uses this to invoke tools on behalf of the logged-in admin.
- **Tenant:** `x-mymcp-tenant` header for per-tenant scoping.

### GET /api/admin/verify

- **Auth:** admin
- **Response:** admin-token-presence confirmation (used by dashboard pre-flight).

---

## /api/welcome/* — First-run mint flow

The first-run path. `INSTANCE_MODE=personal` deploys with no `MCP_AUTH_TOKEN` set redirect to `/welcome`. These endpoints provision the operator's admin token.

### GET /api/welcome/status

- **Auth:** PUBLIC (first-run is public by definition)
- **Response:** `{ bootstrap: boolean, storage: string, ... }` — which step the flow is on.

### POST /api/welcome/claim

- **Auth:** first-run claim signature (signed via `src/core/signing-secret.ts`)
- **Body:** `{ step: string, ... }` — progress ack
- **Pipeline:** rate-limit gate (Phase 41)
- **Response:** signed claim cookie + next-step state.

### POST /api/welcome/init

- **Auth:** first-run claim cookie (set by `/api/welcome/claim`)
- **Body:** `{ token: string }` — operator-provided MCP token
- **Pipeline:** rehydrate → first-run gate → bodyParse → csrf
- **Response:**
  - 200 `{ ok: true, token: "<minted>" }` — winner
  - 409 `{ error: "already_minted" }` — race loser (no token echo; Phase 46)
- **Degraded-mode contract:** arbitration is atomic on Upstash (SET NX EX), serialized on FilesystemKV, unprotected in no-KV dev. See [HOSTING.md § Degraded-mode contract](HOSTING.md).
- **Auto-magic:** writes the minted token to `process.env.MCP_AUTH_TOKEN` + a `.env` file on Vercel (if `VERCEL_TOKEN` + `VERCEL_PROJECT_ID` available).

### POST /api/welcome/test-mcp

- **Auth:** first-run claim cookie OR admin cookie
- **Body:** `{ token: string }`
- **Purpose:** validate that the token authenticates against `/api/[transport]` — dashboard "Test MCP" button.
- **Response:** `{ ok: boolean, details: string }`.

### GET|POST /api/welcome/starter-skills

- **Auth:** admin, or the first-run claim cookie while the instance is not initialized
- **GET:** `{ skills: [{ id, name, title, description, icon, tags, status, installed }] }` — the ritual templates (`content/skill-templates/`).
- **POST:** `{ id }` → `{ ok, id, name, action: "created" | "updated" | "unchanged" }` — installs one template through the regular skills import (versioned, never duplicated). Unknown id → 404.
- **Purpose:** start with a ritual during welcome.

---

## /api/setup/* — Connector setup

Used by the dashboard's connector-credential wizard. These routes test + persist connector creds against `src/core/env-store.ts` (FilesystemEnvStore dev) or Vercel env (prod, auto-magic).

### POST /api/setup/test

- **Auth:** admin cookie
- **Body:** `{ connectorId: string, credentials: Record<string, string> }`
- **Pipeline:** admin auth + CSRF
- **Behavior:** loads the connector manifest via `loadConnectorManifest(id)` (Phase 43 escape hatch) and calls `testConnection(credentials)`. Returns `{ ok, details }`.

### POST /api/setup/save

- **Auth:** admin cookie
- **Body:** `{ connectorId: string, credentials: Record<string, string> }`
- **Behavior:** persists credentials via EnvStore; emits `env.changed` event; triggers registry re-resolve so the connector appears enabled without a server restart.

---

## /api/config/* — Dashboard UI backend

The dashboard at `/config` is an SPA; these are its data-plane endpoints. All gated by admin cookie + CSRF on mutations.

### GET /api/config/context

- **Auth:** admin
- **Response:** current `KEBAB_CONTEXT_PATH` (legacy `MYMCP_CONTEXT_PATH` via alias) + the markdown body of the context file.

### GET|PUT /api/config/env

- **Auth:** admin
- **GET:** redacted env-var inventory (keys + `***` masked values).
- **PUT:** `{ updates: Record<string, string> }` — writes through EnvStore.

### GET /api/config/env-export

- **Auth:** admin
- **Response:** `.env`-formatted export (no actual secrets — placeholders with instructions).

### GET /api/config/logs

- **Auth:** admin
- **Query:** `?tenantId=<id>` or `?scope=all` (Phase 48 ISO-02 root-operator tenant selector)
- **Response:** last N tool-call logs with status, duration, token-id. Ring buffer is tenant-scoped since Phase 48.

### POST /api/config/update

- **Auth:** admin
- **Body:** `Partial<InstanceConfig>` (displayName / timezone / locale / contextPath)
- **Behavior:** routes to `saveInstanceConfig()` — KV write + `env.changed` emit.

### GET|POST /api/config/auth-token

- **Auth:** admin
- **GET:** `{ hasToken: boolean, tokenId: string }` (first 8 hex of sha256)
- **POST:** `{ rotate: true }` — regenerates `MCP_AUTH_TOKEN`, returns new token (shown once).

### GET /api/config/tool-toggle-list

- **Auth:** admin
- **Query:** `x-mymcp-tenant` header optional — tenant-scoped toggles since Phase 42.
- **Response:** per-connector per-tool enable/disable state.

### POST /api/config/tool-toggle

- **Auth:** admin
- **Body:** `{ connectorId: string, toolName: string, enabled: boolean }`

### GET /api/config/tool-schema

- **Auth:** admin
- **Query:** `?tool=<name>`
- **Response:** Zod schema as JSON (for dashboard form generation).

### GET /api/config/sandbox

- **Auth:** admin
- **Purpose:** SSE stream of tool-invocation events (dashboard "Sandbox" tab live log).

### GET /api/config/storage-status

- **Auth:** admin
- **Response:** storage-mode detection (Phase 38 `src/core/storage-mode.ts`) — Upstash/Filesystem/Memory/Auto-magic.

### GET|POST|DELETE /api/config/skills/*

- **Auth:** admin
- **Endpoints:**
  - `GET /api/config/skills` — list skills
  - `POST /api/config/skills/import` — import skill bundle
  - `GET /api/config/skills/:id` — read one
  - `PUT /api/config/skills/:id` — update
  - `DELETE /api/config/skills/:id` — remove
  - `POST /api/config/skills/:id/refresh` — reload from vault
  - `GET /api/config/skills/:id/export` — download as Markdown (`?format=zip` Agent Skill, `?format=relay` relay skill)
  - `GET /api/config/skills/export-all` — whole library as an Agent Skills `.zip`
  - `POST /api/config/skills/bundle-import` — import `SKILL.md` / `.zip` (preview → save)
  - `GET|POST /api/config/skills/templates` — ritual templates with install status; `POST { id }` installs one
  - `GET /api/config/skills/relay-master[?tag=]` — master relay `.zip` (`kebab-house/SKILL.md`), optionally limited to one tag
  - `GET /api/config/skill-versions` — version history
  - `POST /api/config/skill-rollback` — rollback to a version

---

## /api/auth/google/* — OAuth flow

Google OAuth is handled specially (not a regular connector credential form) because of the state parameter + PKCE handshake.

### GET /api/auth/google

- **Auth:** admin cookie
- **Response:** 302 redirect to Google's OAuth consent URL.
- **Sets cookie:** `mymcp_oauth` (state + PKCE verifier — HttpOnly, 10 min Max-Age). This cookie name is grandfathered per [tests/contract/no-stray-mymcp.test.ts](../tests/contract/no-stray-mymcp.test.ts).

### GET /api/auth/google/callback

- **Auth:** `mymcp_oauth` cookie + state param match
- **Query:** `?code=<auth_code>&state=<csrf>`
- **Behavior:** exchanges auth code → refresh_token + access_token; writes to EnvStore; redirects back to `/config?tab=connectors`.

---

## /api/storage/* — Storage backend operations

### GET /api/storage/status

- **Auth:** admin
- **Response:** backend detection + KV reachability.

### POST /api/storage/migrate

- **Auth:** admin
- **Body:** `{ from: string, to: string }`
- **Behavior:** data migration between backends (rarely run).

### POST /api/storage/import

- **Auth:** admin
- **Body:** multipart upload — backup JSON from `/api/admin/status?export=1`.

---

## /api/webhook/[name] — Inbound webhooks

### POST /api/webhook/:name

- **Auth:** per-webhook HMAC signature in `x-hub-signature-256` or equivalent header (verified in `src/connectors/webhook/manifest.ts`).
- **Rate limit:** Phase 41 added a gate (previously unprotected).
- **Body:** arbitrary JSON (the sender's shape).
- **Behavior:** forwards to the connector's `onReceive` handler, which may post to Slack or append to Vault.
- **Config:** `MYMCP_WEBHOOKS=name1,name2,...` (alias-resolved `KEBAB_WEBHOOKS` in Phase 50+).

---

## /api/cron/health — Scheduled probe

### GET /api/cron/health

- **Auth:** `CRON_SECRET` in `x-cron-secret` header (Vercel Cron / GitHub Actions convention).
- **Pipeline:** rate-limit gate (Phase 41 — prevents abuse even with the secret).
- **Behavior:** persists a health-history sample into KV; fires `MYMCP_ERROR_WEBHOOK_URL` alert on degraded state (alias-resolved `KEBAB_ERROR_WEBHOOK_URL`).

---

## See also

- [CONNECTORS.md](CONNECTORS.md) — the 14 connectors + 86 tools, plus the Pipeline conceptual model.
- [CONNECTOR-AUTHORING.md](CONNECTOR-AUTHORING.md) — zero-to-live walkthrough for adding your own.
- [HOSTING.md](HOSTING.md) — deployment modes + degraded-mode contract.
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — FAQ + the 17 catalogued bugs from v0.10 hardening.
- [SECURITY-ADVISORIES.md](SECURITY-ADVISORIES.md) — SEC-* findings timeline.
- [CONTRIBUTING.md](CONTRIBUTING.md) — coverage philosophy + dev loop.

---

*Last updated: Phase 50 (v0.12). This is a living document — rough edges are filed as issues rather than blocking releases.*
