# Roadmap: Kebab MCP

## Current Milestone: v0.19 — Multi-account Google Workspace

**Started:** 2026-06-30
**Goal:** Extend the v0.18 multi-account credential store to the Google connector so operators can connect multiple named Google Workspace accounts (work + personal), with an optional per-call `account` parameter + pinned default, email-auto-derived names — backward-compatible with single-token deployments. Realizes FUT-01.

### Phase Overview (v0.19)

| # | Phase | Goal | Requirements | Effort |
|---|-------|------|--------------|--------|
| 73 | Google store + auth refactor | Register Google in the multi-account store; refactor `getGoogleAccessToken` to a per-slug, ctx-threaded access-token cache; add `resolveGoogleTokens` + `evictGoogleTokenCache` | GMA-01..05 | 1.5d |
| 74 | Tool threading | Thread `GoogleAuthContext` through `googleFetch` + 7 libs + 21 tool handlers; add `account` param; manifest `isActive` + `testConnection` account_name | GMATL-01..04 | 1.5d |
| 75 | Config UI + routes + docs | Add `google` to accounts routes + `MultiAccountSelector`; update callback copy; docs | GMAUI-01..03 | 1d |

## Active Phase

### Phase 73: Google store + auth refactor

**Goal:** Make the Google connector multi-account-aware at the credential + auth layer, without yet touching tool signatures. Registering Google in `ACCOUNT_DESCRIPTORS` immediately gives backward-compatible `default`-account synthesis; refactoring `getGoogleAccessToken` to take a `GoogleAuthContext` and key its L1/L2 caches per slug is the load-bearing change (Google mints a distinct access token per refresh token, so a global cache would cross-contaminate accounts).

**Requirements:** GMA-01, GMA-02, GMA-03, GMA-04, GMA-05

**Success criteria:**
1. `resolveConnectorAccount("google", …)` resolves a legacy flat-env deployment to a single `default` account with no operator action.
2. `getGoogleAccessToken(ctx)` reads the 3-tuple from `ctx.tokens` and caches its minted access token under a slug-scoped L1 Map entry + L2 KV key `google:oauth:access-token:<slug>`.
3. Two different token sets resolve to two distinct cache buckets (no cross-contamination), verified by unit test.
4. `evictGoogleTokenCache(slug)` drops only that account's L1 + L2 cache entries.
5. `resolveGoogleTokens(account?)` returns `{ok:true, ctx}` or a structured error envelope listing available account names.

### Phase 74: Tool threading

**Goal:** Thread the resolved `GoogleAuthContext` from each tool handler down through `googleFetch`/`googleFetchJSON` and all 7 libs, add the optional `account` parameter to all 21 tools, and flip the manifest to the multi-account gate.

**Requirements:** GMATL-01, GMATL-02, GMATL-03, GMATL-04

**Success criteria:**
1. All 21 Google tools accept an optional `account` parameter; omitting it falls back to the pinned default / single account.
2. A call with `account:"<name>"` hits that account's Google APIs using its own cache bucket.
3. With ≥2 accounts and no pin and no `account` arg, a tool returns a clear error listing available account names.
4. `manifest.isActive` gates via `hasConfiguredAccountSync("google", env)`; `testConnection` returns `account_name` from the Gmail profile email.

### Phase 75: Config UI + routes + docs

**Goal:** Surface Google in the multi-account config UI and accounts API, and update the OAuth callback guidance.

**Requirements:** GMAUI-01, GMAUI-02, GMAUI-03

**Success criteria:**
1. `app/api/config/accounts` GET/POST/DELETE + default route accept `connector=google`; POST tests creds before saving and evicts the token cache on change.
2. The `/config` connectors page lets the operator connect / list / pin multiple Google accounts via `MultiAccountSelector`, names auto-derived from email.
3. The OAuth callback "Next steps" copy directs the user to paste into `/config → Connectors → Google → Add account`.

---
*Milestone v0.19 — realizes FUT-01 from v0.18. Full design: `~/.claude/plans/cryptic-greeting-island.md`.*
