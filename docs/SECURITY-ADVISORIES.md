# Kebab MCP — Security Advisories

Index of security advisories and disclosures for Kebab MCP. For
responsible-disclosure guidance see `SECURITY.md`.

Format: most recent first. Advisory IDs follow the GHSA pattern
(`GHSA-XXXX-XXXX-XXXX`); internal references use `SEC-NN` per the
`.planning/milestones/v0.10-durability-ROADMAP.md` phase requirements.

---

## [GHSA-pv2m-p7q3-v45c](https://github.com/Yassinello/kebab-mcp/security/advisories/GHSA-pv2m-p7q3-v45c) (SEC-04) — v0.1.10 / internal v0.10.0

**Draft filed 2026-04-21. Publish from the GitHub Security tab once the operator confirms the CVSS vector and ecosystem version range.**

**Title:** Claim-cookie HMAC signing secret derived from public commit SHA

**Severity:** HIGH (CVSS v3.1: AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N ≈ 7.5)

**Affected versions:** `< 0.10.0` — all pre-v0.10 releases of
Kebab MCP (and the pre-rename MyMCP releases of the same code base).

**Patched version:** `0.10.0`

**Summary.** On pre-v0.10 deploys, the HMAC signing secret used to
validate the first-run claim cookie (`mymcp_firstrun_claim`) was
derived from `VERCEL_GIT_COMMIT_SHA` via
`mymcp-firstrun-v1:${process.env.VERCEL_GIT_COMMIT_SHA}`. The commit
SHA is a public value: it is exposed in every Vercel preview URL
footer, in `.git` metadata of any clone, in GitHub's commit list, and
via some Vercel insight endpoints. An unauthenticated attacker with
read access to the target repository's commit SHA (trivial on public
GitHub projects and on any Vercel preview deployment) could:

1. Compute `sign(claimId)` for any `claimId` of their choosing.
2. Construct a valid `mymcp_firstrun_claim` cookie.
3. POST `/api/welcome/claim` and `/api/welcome/init` to mint a
   permanent `MCP_AUTH_TOKEN` on the target deploy.

The vulnerability is exploitable on any fresh deploy that has not
yet completed welcome bootstrap, and is re-opened whenever
`MYMCP_RECOVERY_RESET=1` is set (pre-v0.10 the reset did not rotate
the signing key, by design documented in code).

**Impact.** Full takeover of a Kebab MCP deployment prior to
legitimate operator bootstrap. Once `MCP_AUTH_TOKEN` is minted, the
attacker controls the MCP endpoint and has downstream access to
whichever connector credentials the operator later configures.

**Reproduction (high-level).**
1. Observe `VERCEL_GIT_COMMIT_SHA` from the target's Vercel preview
   URL footer or the GitHub commit page.
2. HMAC-SHA256 a random 64-hex claim ID with key
   `mymcp-firstrun-v1:${SHA}`.
3. POST to `/api/welcome/init` with
   `Cookie: mymcp_firstrun_claim=<claimId>.<hmac>`.

**Fix (v0.10.0).** The signing secret is now 32 bytes from
`randomBytes`, persisted to KV at `mymcp:firstrun:signing-secret` on
first use (set-if-absent), and rotated on `MYMCP_RECOVERY_RESET=1`.
A fallback to `/tmp` is gated behind
`MYMCP_ALLOW_EPHEMERAL_SECRET=1` for local/dev only. On Vercel
production deploys without durable KV, both welcome routes now
return HTTP 503 `signing_secret_unavailable` with an operator-
actionable error instead of minting. Implemented in
`src/core/signing-secret.ts` and wired through
`src/core/first-run.ts`.

**Mitigation for operators of pre-v0.10 deploys.**
1. Upgrade to v0.10.0 immediately.
2. Rotate any `MCP_AUTH_TOKEN` minted on the affected deploy.
3. Rotate any connector credentials (Slack bot token, GitHub PAT,
   Google refresh token, etc.) saved via the pre-v0.10 dashboard —
   a successful takeover would have exposed them.

**Disclosure timeline.**
- 2026-04-20 — Internal audit identifies the issue.
- 2026-04-20 — Phase 37b opened; work begins on `src/core/signing-secret.ts`.
- 2026-04-20 — Patch lands on `main` as commit `3bd4bd9` + follow-ups.
- v0.10.0 — Tag + release. GHSA private draft to be filed before the
  tag is published; advisory ID will be substituted into this
  document at publish time.

**Credit.** Internal security review, 2026-04-20.

---

## SEC-05 — v0.10.0 (no CVE — companion fix to SEC-04)

**Title:** Welcome routes did not refuse to mint on insecure deploys

**Severity:** MEDIUM (defense-in-depth companion to SEC-04)

**Affected versions:** `< 0.10.0`

**Patched version:** `0.10.0`

**Summary.** Orthogonal to SEC-04: on any Vercel production deploy
with no durable KV configured, claim cookie minting fell back to
`/tmp`-resident state that did not survive cold lambda reaps and
that was effectively unauthenticated (any attacker could mint a
fresh claim after any cold restart). v0.10.0 `/api/welcome/claim`
and `/api/welcome/init` now raise `SigningSecretUnavailableError`
and return HTTP 503 with an operator-actionable JSON body in this
configuration.

**Fix.** `src/core/signing-secret.ts#SigningSecretUnavailableError`
thrown from `getSigningSecret()` when `VERCEL=1` +
`NODE_ENV=production` + no Upstash + no `MYMCP_ALLOW_EPHEMERAL_SECRET=1`.

---

## SEC-01 — v0.10.0 (no CVE — architectural hardening)

**Title:** Cross-tenant KV data leak in skills, credentials, webhooks,
health samples

**Severity:** HIGH (in multi-tenant deployments)

**Affected versions:** `< 0.10.0`

**Patched version:** `0.10.0`

**Summary.** Tenant isolation was enforced at the auth layer
(`getTenantId` in `src/core/auth.ts`) and at the KV layer for tool
handlers that correctly called `getContextKVStore()`. Several
connector code paths bypassed this and called the untenanted
`getKVStore()` directly:

- `src/connectors/skills/store.ts` (7 callsites) — any tenant could
  read/overwrite every other tenant's skills + version history.
- `src/core/credential-store.ts` — `cred:*` keys were global; a
  credential saved by tenant A's session became the in-process
  credential for any tenant on the same warm lambda.
- `app/api/webhook/[name]/route.ts` — webhook payloads were shared
  across tenants.
- `app/api/health/route.ts` + `app/api/admin/health-history/route.ts`
  — health samples leaked latency + up/down signals across tenants,
  and keys grew unbounded (no TTL).

**Fix.** All tenant-scoped callsites migrated to
`getContextKVStore()`. Health samples gained a 7-day TTL. A new
`tests/contract/kv-allowlist.test.ts` grep-style contract test
enforces the allowlist going forward.

**Mitigation for operators running multi-tenant pre-v0.10 deploys.**
On upgrade, rotate all connector credentials that were saved via the
dashboard — pre-v0.10 they were in shared process state visible to
any tenant on the same warm lambda.

---

## SEC-02 — v0.10.0 (no CVE — concurrency hardening)

**Title:** `process.env` mutation at request time was not
concurrency-safe

**Severity:** MEDIUM (data integrity under concurrent load)

**Affected versions:** `< 0.10.0`

**Patched version:** `0.10.0`

**Summary.** Multiple hot paths mutated `process.env` at request
time (`saveCredentialsToKV`, `hydrateCredentialsFromKV`,
`bootstrapToken`, `rehydrateBootstrapAsync`). On warm lambdas
handling interleaved Streamable HTTP requests, this caused torn
reads of credentials and `MCP_AUTH_TOKEN`. v0.10 replaces
`process.env` mutation with a request-scoped credentials map via
`AsyncLocalStorage`, consumed by a new `getCredential(envKey)`
helper. An ESLint rule plus a grep-style contract test enforce
`process.env` read-only going forward.

**Fix.** `src/core/request-context.ts` extended; credentials flow
through `runWithCredentials()` at the MCP transport entry.

---

## SEC-03 — v0.10.0 (no CVE — companion to SEC-01)

**Title:** `/api/admin/call` playground bypassed tenant context

**Severity:** MEDIUM (in multi-tenant deployments)

**Affected versions:** `< 0.10.0`

**Patched version:** `0.10.0`

**Summary.** `/api/admin/call` invoked tool handlers directly
without wrapping in `requestContext.run({ tenantId })`. Tools
called from the dashboard playground saw
`getCurrentTenantId() === null` regardless of the `x-mymcp-tenant`
header and operated on the untenanted KV namespace.

**Fix.** The admin call route now resolves `tenantId` from the
header and wraps `handler()` in `requestContext.run` matching the
MCP transport pattern.

---

## Reporting a vulnerability

See `SECURITY.md`. TL;DR:

- Use GitHub Security Advisories → "Report a vulnerability" on the
  Kebab MCP repository.
- Do not file public GitHub issues for security-sensitive reports.
- Patches target the next minor release by default; critical
  findings ship as a patch release.
