# Troubleshooting — Kebab MCP

Case studies from the 2026-04-20 durability session (17 bugs) and the
2026-04-21 security hotfix (Phase 37b, 4 exploitable findings +
2 related follow-ups). Use this page as a symptom-first index — find
your symptom, read the root cause, jump to the fix commit and the
regression test that keeps the fix pinned.

- Roadmap: [`.planning/milestones/v0.10-durability-ROADMAP.md`](../.planning/milestones/v0.10-durability-ROADMAP.md)
- CHANGELOG: [`CHANGELOG.md`](../CHANGELOG.md)
- Regression tests: [`tests/regression/`](../tests/regression/)
- Integration tests: [`tests/integration/welcome-durability.test.ts`](../tests/integration/welcome-durability.test.ts)

Note on the count — the v0.10 roadmap estimated "19 session bugs" from
memory. Walking `git log cdd3979..4e6fa0c` yielded 16 session commits
= **17 distinct bugs** (one commit bundled two). The inventory in
[`.planning/phases/40-test-coverage-docs/BUG-INVENTORY.md`](../.planning/phases/40-test-coverage-docs/BUG-INVENTORY.md)
is the authoritative source.

---

## Durability bugs (2026-04-20 session)

### BUG-01 — Paste-token form rejected full MCP URL

- **Symptom**: You pasted the full MCP URL from your password manager
  (`https://…/api/mcp?token=…`) into the "paste your token" form.
  The dashboard returned 401 Unauthorized.
- **Root cause**: The form crammed the whole URL into `?token=`,
  URL-encoded it, and middleware compared the encoded URL against
  `MCP_AUTH_TOKEN` — mismatch, 401.
- **Fix commit**: [`4e6fa0c`](https://github.com/Yassinello/kebab-mcp/commit/4e6fa0c)
- **Regression test**: [`tests/regression/welcome-flow.test.ts` — BUG-01](../tests/regression/welcome-flow.test.ts)

### BUG-02 — "Already initialized" screen had no paste-token form

- **Symptom**: Return visitor to `/welcome` on a fully-initialized
  instance saw a friendly "Head to the dashboard" link that led to
  `/config` → 401. End-of-session cliff.
- **Root cause**: The branch rendered a bare link to `/config` with
  no way to pass a token. Middleware had no cookie/bearer to check
  against.
- **Fix commit**: [`bc31b69`](https://github.com/Yassinello/kebab-mcp/commit/bc31b69)
- **Regression test**: [`tests/regression/welcome-flow.test.ts` — BUG-02](../tests/regression/welcome-flow.test.ts) plus E2E visual cover in [`tests/e2e/welcome.spec.ts`](../tests/e2e/welcome.spec.ts)

### BUG-03 — Welcome handoff landed on 401

- **Symptom**: You finished the welcome wizard, clicked "Open
  dashboard", and landed on a 401 "Unauthorized — use Authorization
  header or ?token=" page.
- **Root cause**: The CTA linked to bare `/config`; middleware
  passed `?token=` through, leaving it in the URL, Referer header,
  and browser history.
- **Fix commit**: [`83b5a8e`](https://github.com/Yassinello/kebab-mcp/commit/83b5a8e)
- **Regression test**: [`tests/regression/welcome-flow.test.ts` — BUG-03](../tests/regression/welcome-flow.test.ts)

### BUG-04 — Step-3 Test MCP stuck on durable-no-auto-magic deploys

- **Symptom**: Welcome step 3 stuck on "⏳ Waiting for Vercel
  redeploy…" with the Test-MCP button disabled — even though your KV
  had durably persisted the token. No redeploy was ever going to
  happen.
- **Root cause**: The step-3 gate checked `permanent` (=
  `initialized && !isBootstrap`). Freshly-minted bootstrap stays
  `isBootstrap` for ~15 min, so `permanent=false` even on a durable
  KV backend.
- **Fix commit**: [`f818e01`](https://github.com/Yassinello/kebab-mcp/commit/f818e01)
- **Regression test**: [`tests/regression/welcome-flow.test.ts` — BUG-04](../tests/regression/welcome-flow.test.ts)

### BUG-05 — `MYMCP_RECOVERY_RESET=1` silently wiped tokens on every cold lambda

- **Symptom**: Warm welcome lambda showed "permanent token active";
  moments later a different cold lambda's `/api/mcp` returned 503 /
  401. Claude Desktop's Test-MCP probe failed because the bootstrap
  genuinely vanished mid-session.
- **Root cause**: `rehydrateBootstrapFromTmp()` calls `forceReset()`
  when `MYMCP_RECOVERY_RESET=1` — every cold lambda deleted `/tmp`
  and the KV bootstrap on boot. Init minted a token that the next
  cold lambda erased.
- **Fix commit**: [`5273add`](https://github.com/Yassinello/kebab-mcp/commit/5273add)
- **Regression test**: [`tests/regression/welcome-flow.test.ts` — BUG-05](../tests/regression/welcome-flow.test.ts) plus a middleware cross-check in [`tests/regression/env-handling.test.ts`](../tests/regression/env-handling.test.ts)

### BUG-06 — Init silently succeeded while KV persist failed

- **Symptom**: UI said "✅ Token minted!"; the dashboard returned
  503 forever on subsequent cold lambdas.
- **Root cause**: `flushBootstrapToKv()` wrapped the Upstash SET in
  `try/catch` that only logged. The init handler awaited a promise
  that never rejected, returned `{ ok: true, token }`, and you saved
  a doomed credential.
- **Fix commit**: [`1460841`](https://github.com/Yassinello/kebab-mcp/commit/1460841)
- **Regression test**: [`tests/regression/welcome-flow.test.ts` — BUG-06](../tests/regression/welcome-flow.test.ts)

### BUG-07 — Fire-and-forget KV SET lost to Vercel reap

- **Symptom**: Welcome wizard completed successfully; the next cold
  lambda treated the instance as first-run and redirected `/config`
  → `/welcome`. KV `mymcp:firstrun:bootstrap` was empty.
- **Root cause**: `bootstrapToken()` did `void
  persistBootstrapToKv(activeBootstrap)` and returned synchronously.
  Vercel reaped the lambda after the response; the in-flight Upstash
  SET was cancelled mid-write.
- **Fix commit**: [`95f0df7`](https://github.com/Yassinello/kebab-mcp/commit/95f0df7) (part 1/2)
- **Regression test**: [`tests/regression/kv-durability.test.ts` — BUG-07](../tests/regression/kv-durability.test.ts) plus integration scenario A+B in [`tests/integration/welcome-durability.test.ts`](../tests/integration/welcome-durability.test.ts)
- **Related**: Phase 37 (DUR-04) deleted the fire-and-forget helper entirely; awaited `flushBootstrapToKv()` is the authoritative path.

### BUG-08 — Edge rehydrate spoke wrong REST dialect

- **Symptom**: KV had the bootstrap written correctly, but
  middleware rehydrate silently skipped it. `/config` redirected to
  `/welcome` on cold lambdas.
- **Root cause**: `first-run-edge.ts` used `GET /get/{key}` (URL
  path). Writer used `POST /` with `["GET", key]` JSON body. Some
  Upstash gateway revisions URL-encoded the literal colons in the
  key differently, yielding 404.
- **Fix commit**: [`95f0df7`](https://github.com/Yassinello/kebab-mcp/commit/95f0df7) (part 2/2)
- **Regression test**: [`tests/regression/kv-durability.test.ts` — BUG-08](../tests/regression/kv-durability.test.ts)

### BUG-09 — Middleware didn't read `KV_REST_API_URL`

- **Symptom**: You deployed via "Deploy to Vercel" with the Upstash
  Marketplace integration. Instance had `KV_REST_API_*` set but NOT
  `UPSTASH_REDIS_REST_*`. Middleware rehydrate silently skipped;
  cold lambdas redirected `/config` → `/welcome`.
- **Root cause**: `ensureBootstrapRehydratedFromUpstash()` only read
  the `UPSTASH_REDIS_REST_*` names. The Marketplace integration
  injects `KV_REST_API_*`.
- **Fix commit**: [`7f6ec80`](https://github.com/Yassinello/kebab-mcp/commit/7f6ec80)
- **Regression test**: [`tests/regression/env-handling.test.ts` — BUG-09](../tests/regression/env-handling.test.ts)
- **Related**: Phase 37 (DUR-06) unified the read behind `getUpstashCreds()` so no other callsite can repeat the divergence.

### BUG-10 — Middleware blind to KV bootstrap on cold lambdas

- **Symptom**: Cold lambda's middleware saw `MCP_AUTH_TOKEN`
  undefined, redirected `/config` → `/welcome`. `/welcome`'s
  "Generate my token" button 409'd with "Already initialized".
- **Root cause**: `proxy.ts` read `process.env.MCP_AUTH_TOKEN`
  directly. No rehydrate path in middleware.
- **Fix commit**: [`7325aa8`](https://github.com/Yassinello/kebab-mcp/commit/7325aa8)
- **Regression test**: [`tests/regression/bootstrap-rehydrate.test.ts` — BUG-10](../tests/regression/bootstrap-rehydrate.test.ts) plus behavioral assertions in [`tests/core/proxy-async-rehydrate.test.ts`](../tests/core/proxy-async-rehydrate.test.ts) (TEST-04).

### BUG-11 — MCP transport handler never rehydrated

- **Symptom**: Claude Desktop / Cursor / any MCP client hit
  `/api/[transport]` on a cold lambda and got 503 "Instance not yet
  initialized" — even after welcome completed.
- **Root cause**: Transport handler checked `isFirstRunMode()` but
  never called `rehydrateBootstrapAsync`.
- **Fix commit**: [`100e0b9`](https://github.com/Yassinello/kebab-mcp/commit/100e0b9)
- **Regression test**: [`tests/regression/bootstrap-rehydrate.test.ts` — BUG-11](../tests/regression/bootstrap-rehydrate.test.ts)
- **Related**: Phase 37 (DUR-01) replaced the inline call with `withBootstrapRehydrate` HOC on all auth-gated routes.

### BUG-12 — Token minted BEFORE storage configured

- **Symptom**: Welcome wizard minted a token first, asked about
  storage second. On Vercel without Upstash, the token lived only on
  `/tmp` and silently vanished on container recycle.
- **Root cause**: Wizard step order was "token → storage". The
  15-30 min window between mint and storage setup was a
  lock-out-your-own-instance trap.
- **Fix commit**: [`ccdaa3d`](https://github.com/Yassinello/kebab-mcp/commit/ccdaa3d)
- **Regression test**: [`tests/regression/storage-ux.test.ts` — BUG-12](../tests/regression/storage-ux.test.ts)

### BUG-13 — Storage step gave three equal-weight options

- **Symptom**: Three-card grid (Upstash / Local file / Env vars
  only) with the DETECTED card highlighted — even when that card was
  ⚠ temporary. Users clicked the highlighted temporary option
  despite the warning banner.
- **Root cause**: Detection and choice rendered at the same visual
  weight with no dominant signal.
- **Fix commit**: [`c339fc7`](https://github.com/Yassinello/kebab-mcp/commit/c339fc7)
- **Regression test**: [`tests/regression/storage-ux.test.ts` — BUG-13](../tests/regression/storage-ux.test.ts)

### BUG-14 — `/api/storage/status` 401'd during bootstrap

- **Symptom**: After init minted the token, the next
  `/api/storage/status` poll on the same warm lambda 401'd → UI
  stuck on "Detecting your storage…".
- **Root cause**: The route gated on `process.env.MCP_AUTH_TOKEN` —
  once the token was minted it demanded admin auth, but the welcome
  client only had the claim cookie.
- **Fix commit**: [`ab47f8d`](https://github.com/Yassinello/kebab-mcp/commit/ab47f8d)
- **Regression test**: [`tests/regression/kv-durability.test.ts` — BUG-14](../tests/regression/kv-durability.test.ts)

### BUG-15 — `isClaimer` required in-memory match across cold lambdas

- **Symptom**: Every "Initialize this instance" click returned 403
  "Forbidden — not the claimer" on Vercel without Upstash.
- **Root cause**: `isClaimer` required the cookie's claim ID to
  match an in-memory `claims` Map entry. Both the Map and `/tmp`
  are lambda-local; claim and init routinely landed on different
  lambdas.
- **Fix commit**: [`748161d`](https://github.com/Yassinello/kebab-mcp/commit/748161d)
- **Regression test**: [`tests/regression/kv-durability.test.ts` — BUG-15](../tests/regression/kv-durability.test.ts) plus integration scenario C in [`tests/integration/welcome-durability.test.ts`](../tests/integration/welcome-durability.test.ts)

### BUG-16 — Welcome step 2 stuck on "Detecting your storage…"

- **Symptom**: Welcome step 2 could hang indefinitely on "Detecting
  your storage…" on Vercel without Upstash. The escape hatch was
  unreachable because the client only fetched `/api/storage/status`
  once on mount.
- **Root cause**: (a) `/api/storage/status` didn't call
  `rehydrateBootstrapAsync` before auth, so cold lambdas 401'd. (b)
  Client didn't retry.
- **Fix commit**: [`0b5c737`](https://github.com/Yassinello/kebab-mcp/commit/0b5c737)
- **Regression test**: [`tests/regression/storage-ux.test.ts` — BUG-16](../tests/regression/storage-ux.test.ts)

### BUG-17 — Showcase mode locked behind first-run gate

- **Symptom**: Public showcase deploy (`kebab-mcp.vercel.app`) had
  `INSTANCE_MODE=showcase` set but no `MCP_AUTH_TOKEN`. Middleware
  treated it as a fresh install and force-redirected `/` →
  `/welcome`. Landing page was unreachable.
- **Root cause**: `proxy.ts` checked `!MCP_AUTH_TOKEN → first-run`
  before checking `INSTANCE_MODE === "showcase"`.
- **Fix commit**: [`d747a1f`](https://github.com/Yassinello/kebab-mcp/commit/d747a1f)
- **Regression test**: [`tests/regression/env-handling.test.ts` — BUG-17](../tests/regression/env-handling.test.ts)

---

## Security findings (Phase 37b)

### SEC-01 — Cross-tenant KV data leak

- **Symptom**: Tenant A could read or overwrite tenant B's skills,
  credentials, and webhook payloads on multi-tenant deploys.
- **Root cause**: Connector code paths (`skills/store.ts`,
  `credential-store.ts`, `webhook/[name]/route.ts`,
  `health/route.ts`) bypassed `TenantKVStore` and called the
  untenanted `getKVStore()` directly.
- **Fix commit**: Phase 37b allowlist sweep; see CHANGELOG v0.10
  Phase 37b subsection.
- **Regression test**: [`tests/contract/kv-allowlist.test.ts`](../tests/contract/kv-allowlist.test.ts)

### SEC-02 — `process.env` mutation at request time

- **Symptom**: Concurrent tool calls on a warm lambda saw torn
  writes of credentials — tenant A's Google token briefly readable
  by a tenant B connector on the same instance.
- **Root cause**: `hydrateCredentialsFromKV()` mutated
  `process.env` at request time. Node's `process.env` is a global
  shared map; under concurrent hydration, one request's write was
  visible to another mid-request.
- **Fix commit**: Phase 37b SEC-02 (`getCredential()` +
  `AsyncLocalStorage` request-scoped map).
- **Regression test**: [`tests/contract/process-env-readonly.test.ts`](../tests/contract/process-env-readonly.test.ts) + [`tests/core/request-context.test.ts`](../tests/core/request-context.test.ts)

### SEC-03 — `/api/admin/call` missing tenant context

- **Symptom**: Dashboard playground tool invocations didn't honor
  `x-mymcp-tenant` header. Tenant A's admin could invoke a tool
  that returned tenant-default-scope data.
- **Root cause**: The admin playground route bypassed the
  `requestContext.run({ tenantId })` wrapper that the MCP transport
  uses for the same tools.
- **Fix commit**: Phase 37b SEC-03.
- **Regression test**: [`tests/core/tenant-auth.test.ts`](../tests/core/tenant-auth.test.ts)

### SEC-04 — HMAC signing secret from public commit SHA (GHSA pending)

- **Symptom**: A remote attacker who knew a fresh Vercel deploy's
  `VERCEL_GIT_COMMIT_SHA` (trivial on public repos / preview URLs)
  could forge a claim cookie and hijack the welcome mint, gaining
  full admin on the deploy.
- **Root cause**: The claim-cookie HMAC secret was derived from
  `VERCEL_GIT_COMMIT_SHA` — a public value.
- **Fix commit**: Phase 37b SEC-04 (`randomBytes(32)` + KV-persisted
  signing secret + rotation on recovery reset).
- **Regression test**: [`tests/api/welcome-claim-forgery.test.ts`](../tests/api/welcome-claim-forgery.test.ts) + [`tests/core/signing-secret.test.ts`](../tests/core/signing-secret.test.ts)
- **Advisory**: GHSA draft filed; advisory ID will appear in the
  CHANGELOG v0.10.0 release entry on publication.

---

## Frequently asked questions

### "My `/config` redirects me to `/welcome` after deploy"

Cold lambda hasn't rehydrated `MCP_AUTH_TOKEN`. Usually one of:

- Upstash KV isn't attached (the instance has no durable store).
- KV env vars use a naming variant the code didn't recognize — see
  [BUG-09](#bug-09--middleware-didnt-read-kv_rest_api_url) below.
- The bootstrap KV write raced Vercel's lambda reap — see
  [BUG-07](#bug-07--fire-and-forget-kv-set-lost-to-vercel-reap).

All three are fixed as of v0.10. First, confirm KV is reachable:
open `/api/health` and look for `kv.reachable: true`. If it's false,
add the Upstash integration (Vercel Marketplace or manual) and
redeploy.

### "I set `UPSTASH_REDIS_REST_URL` but Kebab MCP still complains about KV"

Your Vercel Marketplace integration probably injected
`KV_REST_API_URL` / `KV_REST_API_TOKEN` instead. Both variants are
recognized since `7f6ec80` (see
[BUG-09](#bug-09--middleware-didnt-read-kv_rest_api_url)).

Check `process.env` in the Vercel UI; either pair unblocks the
rehydrate path. If both are set, `UPSTASH_REDIS_REST_*` wins.

### "I set `MYMCP_RECOVERY_RESET=1` and it wiped everything"

Working as intended. `MYMCP_RECOVERY_RESET=1` is an emergency-reset
escape hatch — it deletes the bootstrap and rotates the signing
secret so old claim cookies no longer verify (SEC-04).

DO NOT leave the env var set — every cold lambda wipes state on
boot, so any newly-minted token vanishes within minutes. See
[BUG-05](#bug-05--mymcp_recovery_reset1-silently-wiped-tokens-on-every-cold-lambda).

As of `5273add`, `/api/welcome/init` now returns 409 while the var
is set, so you can't accidentally mint a doomed token.

### "Welcome flow says 'already initialized' but I can't paste my token"

Fixed in `bc31b69` + `4e6fa0c`. Upgrade to v0.10.0. The
already-initialized screen now accepts either:

- Your bare `MCP_AUTH_TOKEN` value.
- The full MCP URL you saved (`https://…/api/mcp?token=…`) — the
  form extracts the `?token=` value automatically.

### "Welcome flow loops me back to `/welcome`"

Usually one of:

- KV not configured AND `MYMCP_ALLOW_EPHEMERAL_SECRET` not set — the
  welcome routes refuse to mint claims on production-like deploys
  without a durable signing secret (SEC-05).
- Cold-lambda rehydrate failing silently — check
  `/api/admin/status` for `bootstrap.state`.
- `INSTANCE_MODE=showcase` accidentally set — that mode treats the
  deploy as a read-only template and bypasses the welcome wizard.

### "Claude Desktop / Cursor says 503 'Instance not yet initialized'"

Cold-lambda MCP transport hasn't rehydrated
`MCP_AUTH_TOKEN`. As of `100e0b9` / Phase 37 DUR-01 the transport
wraps in `withBootstrapRehydrate`, so this class of bug should be
closed.

Verify KV is reachable (`/api/health`) and that your MCP client
sends the `Authorization: Bearer <token>` header. If the issue
persists, `/api/admin/status` exposes `firstRun.rehydrateCount` —
a non-zero value proves rehydrate is happening; a zero count with
a persistent 503 means KV isn't serving the bootstrap back.

---

## Reference

- [`CHANGELOG.md`](../CHANGELOG.md) — v0.10.0 release notes and
  per-phase subsections.
- [`CLAUDE.md`](../CLAUDE.md) — developer guide, durable bootstrap
  pattern.
- [`docs/SECURITY-ADVISORIES.md`](SECURITY-ADVISORIES.md) — advisory
  index and disclosure timeline.
- [`docs/HOSTING.md`](HOSTING.md) — host compatibility matrix.
