# Unipile Connector

LinkedIn write actions (connect, DM, InMail, engage) + LinkedIn & WhatsApp inbox reading via the [Unipile](https://www.unipile.com) hosted-browser API. WhatsApp support is read-only (inbox listing + message reading); there is no WhatsApp send tool.

**Status:** Shipped v0.17 (2026-05-18).
**Decision:** Chosen over Browserbase/LinkedAPI per [ADR 0001](../adr/0001-unipile-as-linkedin-whatsapp-write-provider.md).
**Cost:** 49 €/mo (palier 1, up to 10 accounts, all channels).

## Quick Start (60 seconds)

```bash
# 1. Get your DSN + token from https://dashboard.unipile.com
export UNIPILE_DSN="https://api41.unipile.com:17153"
export UNIPILE_TOKEN="<your-token>"

# 2. Connect a LinkedIn account in the Unipile dashboard (hosted wizard)
#    https://dashboard.unipile.com/accounts → "Add account" → LinkedIn

# 3. Bootstrap webhook subscriptions (idempotent)
npx tsx scripts/setup-unipile-webhooks.ts

# 4. Send a test invite
npx tsx --env-file=.env scripts/smoke-unipile.ts \
  get "https://linkedin.com/in/<your-test-target>"
```

If `get_relationship_status` returns `{degree: 1, connection_status: "FIRST_DEGREE"}` you're live.

## Tools (10)

Write tools enforce: **kill-switch check → halt-flag check → dedup → rate-limit → SDK call → audit log**. Read tools have no quota or kill-switch gate.

| Tool | Type | Description |
|---|---|---|
| `linkedin_send_connection` | WRITE | Send a connection request. Verify-after-write via 3-poll @ 2s/5s/10s. Dedup on `{tool, profile_url, note}` SHA-256. Cap default 25/day, 100/week. |
| `linkedin_get_relationship_status` | READ | Returns `{degree: 1\|2\|3\|null, connection_status}` for a profile URL. No quota. |
| `linkedin_send_message` | WRITE | 1st-degree DM only (refuses with `error_not_connected` otherwise). Attachments up to 15MB. Cap default 50/day. |
| `linkedin_send_inmail` | WRITE | Explicit (`allow_inmail: true` required). Returns `credits_used + credits_remaining` via balance bracketing. Cap default 15/day. Refuses if no Premium/Sales Nav. |
| `linkedin_engage` | WRITE | Super-tool: routes to `send_message` (1st), `send_connection` (2nd/3rd), or `send_inmail` (OON + opt-in). `dry_run: true` previews without sending. |
| `linkedin_list_pending` | READ | Lists pending sent invitations with `{invitation_id, recipient_profile_url, sent_at, age_days, has_note}`. Cursor pagination. Default limit 100, max 500. |
| `linkedin_list_inbox` | READ | Lists LinkedIn conversations (chats) with last-message preview + unread state. Cursor pagination. No quota. |
| `linkedin_read_messages` | READ | Reads messages from a LinkedIn chat by `chat_id`. No quota. |
| `whatsapp_list_inbox` | READ | Lists WhatsApp conversations with `conversation_type` (single/group/channel) + last-message preview. Cursor pagination. No quota. |
| `whatsapp_read_messages` | READ | Reads messages from a WhatsApp chat by `chat_id`. No quota. |

Tool envelope (write tools):

```json
{
  "provider_ok": true,
  "verified": true,
  "crm_sync": "pending",
  "dedup_hit": false,
  "audit_id": "550e8400-e29b-41d4-a716-446655440000",
  "invitation_id": "7424027849352978432"
}
```

**`verified` is strictly boolean** (no `"pending"` literal — see [ADR 0001](../adr/0001-unipile-as-linkedin-whatsapp-write-provider.md) Antoine Vercken incident). A 3-poll timeout returns `verified: false` + `error: "unverified_timeout"`.

## Environment Variables

### Required

| Var | Description |
|---|---|
| `UNIPILE_DSN` | Tenant API URL (e.g. `https://api41.unipile.com:17153`). Accepts both protocol-included and bare host:port. |
| `UNIPILE_TOKEN` | X-API-KEY header for all SDK requests. Rotate via dashboard. |

### Webhook ingress

| Var | Description |
|---|---|
| `UNIPILE_WEBHOOK_SECRET` | Shared secret for the `Unipile-Auth` static header check on inbound webhooks. Single global secret (Unipile sends one signature per webhook URL). |

### Rate-limit caps (env-overridable, generous defaults)

| Var | Default | Tool |
|---|---|---|
| `KEBAB_UNIPILE_LINKEDIN_DAILY_CONNECT_CAP` | 25 | linkedin_send_connection (daily) |
| `KEBAB_UNIPILE_LINKEDIN_WEEKLY_CONNECT_CAP` | 100 | linkedin_send_connection (weekly) |
| `KEBAB_UNIPILE_LINKEDIN_DAILY_DM_CAP` | 50 | linkedin_send_message |
| `KEBAB_UNIPILE_LINKEDIN_DAILY_INMAIL_CAP` | 15 | linkedin_send_inmail |

### Kill switches

| Var | Description |
|---|---|
| `KEBAB_UNIPILE_LINKEDIN_WRITES_DISABLED=true` | Halts all 4 LinkedIn write tools globally. READS still allowed. Tools refuse with `error_writes_disabled`. |
| `LINKEDIN_TOOLS_DISABLED=true` | Legacy alias (same effect). |
| `KEBAB_UNIPILE_RATELIMIT_FAIL_MODE=open` | Optional. Flips rate-limiter from fail-closed (default, safer) to fail-open. Only use if you're OK with silent over-sending when KV is down. |

## Rate Limits

**Defaults are deliberately conservative** vs LinkedIn's published limits (80-100 connects/day on paid accounts). Stay below the LinkedIn red-flag threshold.

- Daily windows reset at UTC midnight
- Weekly windows reset Monday 00:00 UTC
- Counters are per-account, per-tool — independent across LinkedIn accounts in the same tenant
- **Fail-closed by default**: if KV is unreachable, writes are blocked. Override with `KEBAB_UNIPILE_RATELIMIT_FAIL_MODE=open` (NOT recommended).
- When blocked, the tool returns `{blocked_by_rate_limit: true, daily_used, daily_limit, retry_after: "<ISO>"}` (never throws).

## Halt Flag (auto-suspend on account issues)

When the inbound `account.status` webhook reports an error state (`credentials_expired`, `restricted`, `disconnected`), the connector sets a halt flag in KV. All subsequent write tool calls refuse immediately with `error_account_halted` until the issue is resolved (status returns to `OK` → flag cleared automatically).

This is **per-account** (one tenant can have multiple Unipile accounts, only the halted ones are blocked).

The halt flag is **separate from the global kill switch**. The kill switch is operator-controlled (env var); the halt flag is webhook-driven (Unipile-reported).

## Webhook Setup

Phase 70 ships:
- `/api/unipile/webhook` route with dual-mode auth (HMAC + static header fallback per [70-CONTEXT D-52](../../.planning/phases/70-webhooks-whatsapp/70-CONTEXT.md))
- 24h KV idempotency via `event_id` to drop duplicates
- 3 INGRESS handlers updating internal connector state only (account.status → halt flag; new_relation → audit enrichment; new_message → last_replied_at). **No outbound CRM push** — that's the caller's job.

To subscribe Unipile to your endpoint:

```bash
# Local dev (use ngrok or similar tunnel)
npx tsx scripts/setup-unipile-webhooks.ts \
  --webhook-url "https://your-tunnel.ngrok.io/api/unipile/webhook"

# Production
npx tsx scripts/setup-unipile-webhooks.ts \
  --webhook-url "https://your-domain.com/api/unipile/webhook"
```

The script is idempotent — running twice is safe.

## Admin REST API (operator dashboards)

All routes require admin auth (`readAdminCookie()`).

### Cache invalidation

```http
DELETE /api/admin/unipile/cache/urn?profile_url=<url>
```
Manually evicts a URN cache entry (e.g., after a profile slug rename).

### Quota metrics

```http
GET /api/admin/metrics/unipile-quotas?account_id=<id>&tool=<send_connection|send_message|send_inmail>
```
Returns `{daily_used, daily_limit, weekly_used?, weekly_limit?, reset_at, percent_used}`.

```http
GET /api/admin/metrics/unipile-quotas/summary
```
Returns the matrix `[{account_id, tool, daily_used, daily_limit, percent_used}]` for all accounts × tools.

### Audit query

```http
GET /api/admin/audit/unipile?account_id=&since=&tool=&result=&limit=&cursor=
```
Paginated audit log query. All filters optional, ANDed. Default limit 50, max 200. Cursor format: base64 of last `audit_id` from previous page.

Example: find all rate-limit-blocked sends in the last day:
```
GET /api/admin/audit/unipile?result=error_rate_limit_kebab&since=2026-05-18T00:00:00Z
```

## Troubleshooting

### `error_unipile_5xx`
Unipile API returned a 5xx error. Check [Unipile status page](https://status.unipile.com) and retry after a few minutes. If persistent, escalate to Unipile support with the `audit_id` from the response.

### `error_not_connected`
You tried `linkedin_send_message` on a 2nd/3rd-degree profile. LinkedIn DMs require 1st-degree. Send a connection request first via `linkedin_send_connection`, or use `linkedin_engage` which routes automatically based on degree.

### `error_rate_limit_kebab`
You hit the Kebab-side rate limit (configured via `KEBAB_UNIPILE_*_CAP` env vars). Wait until `retry_after` (ISO timestamp). To increase the cap, set the appropriate env var and redeploy.

### `error_account_halted`
The Unipile webhook reported your LinkedIn account is in error state. Check your account in the Unipile dashboard. Once you reconnect, the next `account.status: OK` webhook will clear the halt flag automatically. To manually verify: `GET /api/admin/audit/unipile?result=error_account_halted&limit=5`.

### `error_writes_disabled`
The global kill switch is set. Unset `KEBAB_UNIPILE_LINKEDIN_WRITES_DISABLED` env var to re-enable writes.

### `error_inmail_requires_premium`
The connected LinkedIn account doesn't have Premium / Sales Navigator. InMail requires one of those tiers.

### `error_account_id_required`
Multiple LinkedIn accounts are connected to your Unipile tenant. Pass `account_id` explicitly in the tool call.

### `error_no_linkedin_account`
No LinkedIn account is connected to your Unipile tenant. Add one in the Unipile dashboard.

### URL with query string returns `error_invalid_request` (UNI-25 fixed v0.17)
URLs like `linkedin.com/in/foo?originalSubdomain=fr` are now correctly normalized. If you see this error on a clean URL, file an issue.

### Dedup blocks a legitimate retry
The dedup hash is `SHA-256({tool, profile_url, note})`. Change 1 character in the note to bypass intentionally — there is no `dedup_key` override by design (D-06 — prevents silent re-spam).

### Webhook events not arriving
1. Verify the webhook is configured in Unipile: `GET https://api<n>.unipile.com:<port>/api/v1/webhooks` (with `X-API-KEY`)
2. Re-run `npx tsx scripts/setup-unipile-webhooks.ts`
3. Check route logs: `[CONNECTOR:unipile] webhook auth mode: static` should appear on each inbound POST
4. Note: `new_relation` events have **up to 8h delay** from accept (LinkedIn API quirk, not a bug)

## Multi-tenant Verification (Manual Smoke Test)

This procedure validates that 2 distinct tenants share the same Unipile account-key but maintain isolated counters, audit logs, and dedup state.

### Setup
- 2 admin sessions (`tenant_a`, `tenant_b`) authenticated against the same Kebab deployment
- 1 Unipile tenant key (`UNIPILE_DSN` + `UNIPILE_TOKEN`) shared
- 1 test target LinkedIn profile (someone you can spam-test, e.g. yourself or a sandbox account)

### Procedure
1. From `tenant_a`, call `linkedin_send_connection` on the test target. Expect `dedup_hit: false`, audit_id returned.
2. From `tenant_b`, call same target with same note. Expect `dedup_hit: false` (separate audit log per D-18).
3. From `tenant_a`: `GET /api/admin/metrics/unipile-quotas?account_id=<acc>&tool=send_connection`. Expect `daily_used: 1`.
4. From `tenant_b`: same request. Expect `daily_used: 1` (independent counter per D-18).
5. Set `KEBAB_UNIPILE_LINKEDIN_WRITES_DISABLED=true`. Both tenants get `error_writes_disabled` on next call (kill switch is global per D-86).
6. Unset the env var. Both tenants recover.

### Expected
- Counters: separate per tenant
- Audit logs: separate per tenant (tenant A cannot read tenant B's audit via `GET /api/admin/audit/unipile`)
- Kill switch: global (single env var affects all tenants)
- Halt flag: per-account (set by webhook for a specific Unipile `account_id`, not per-tenant)

## References

- [ADR 0001 — Unipile chosen over alternatives](../adr/0001-unipile-as-linkedin-whatsapp-write-provider.md)
- [Unipile pricing](https://www.unipile.com/pricing-api/)
- [Unipile API docs](https://developer.unipile.com/docs)
- [Unipile webhooks](https://developer.unipile.com/docs/webhooks-2)
- [Unipile provider limits](https://developer.unipile.com/docs/provider-limits-and-restrictions)
- [Unipile Node SDK source](https://github.com/unipile/unipile-node-sdk)
