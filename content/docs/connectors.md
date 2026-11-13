---
title: Connector setup
summary: How to wire each connector to its credentials
order: 20
---

## How activation works

Every connector ships with a list of required env vars. When all of them are present, the connector flips to **active** and its tools register at the MCP endpoint immediately — no redeploy required.

There are two places those env vars can live:

- **Vercel project env vars** (or `.env.local` for local dev) — frozen at the deploy boundary, take precedence on conflict.
- **Upstash KV** (via the dashboard "Save" button) — persists instantly across cold starts, no redeploy. This is the default for credentials saved through `/config → Connectors`.

The dashboard always reflects the merged view: a connector configured via either path shows as **Active**. If you save in the dashboard but the badge doesn't flip, check **Settings → Storage** — if you're in `Filesystem (temporary)` mode, the credential vanishes on the next cold start. The fix is to provision Upstash (Vercel Marketplace one-clicks the integration).

## Google Workspace

Required env vars:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REFRESH_TOKEN`

Setup:

1. Create an OAuth client in [Google Cloud Console](https://console.cloud.google.com/apis/credentials) of type **Desktop app**. Save the client ID and secret.
2. Use the included helper `npx tsx scripts/google-oauth.ts` to mint a refresh token from the command line. It runs a local OAuth flow and prints the refresh token to paste into your env.
3. Required scopes: Gmail full, Calendar full, Drive read, Contacts read.

## GitHub Issues

Required: `GITHUB_PAT` (with `repo` scope) and optionally `GITHUB_REPO` to pin a default repo.

Generate a fine-grained PAT at [github.com/settings/tokens](https://github.com/settings/tokens?type=beta) — limit it to the repos you want the assistant to touch.

## Notion

Required: `NOTION_API_KEY`. Create an Internal Integration at [notion.so/profile/integrations](https://www.notion.so/profile/integrations), then share the pages/databases you want to expose with the integration from inside Notion.

### Multiple accounts

You can connect more than one Notion integration (e.g. a personal workspace and a team workspace) and switch between them per tool call.

- **Connect a 2nd account**: `/config → Connectors → Notion → Connected accounts → Add another Notion account`. Paste the second integration token and click **Add account**. The token is tested before saving, and the account is named automatically from the integration's name in Notion.
- **Pin a default**: each connected account shows a radio button — pick the one tools should use when no account is specified. Marked with a **Default** badge.
- **Use per call**: every Notion tool accepts an optional `account` parameter (the account **name** or its slug). Omit it to use the pinned default — or your only account.
- **Single-token deployments keep working**: if you just set `NOTION_API_KEY` (env var or one saved token and nothing else), it's the implicit "default" account — no migration, the `account` parameter is optional.

Tokens for each account are stored separately in tenant-scoped KV (never an env var) and never leave the server — the dashboard only ever sees account names.

## Slack

Required: `SLACK_BOT_TOKEN` (`xoxb-...`). Create a Slack app, add scopes (`channels:read`, `chat:write`, `groups:read`, `im:read`, `mpim:read`, `search:read`, `users:read`), install to your workspace, copy the Bot User OAuth Token.

### Multiple accounts

You can connect more than one Slack workspace and switch between them per tool call.

- **Connect a 2nd account**: `/config → Connectors → Slack → Connected accounts → Add another Slack account`. Paste the second workspace's Bot User OAuth Token (and optionally a User OAuth Token) and click **Add account**. The token is tested before saving, and the account is named automatically from the Slack workspace name.
- **Pin a default**: each connected account shows a radio button — pick the workspace tools should act in when no account is specified. Marked with a **Default** badge.
- **Use per call**: every Slack tool accepts an optional `account` parameter (the workspace **name** or its slug). Omit it to use the pinned default — or your only account. With ≥2 accounts and no default pinned, tools refuse and list the available account names so you can re-run with `account` set.
- **Single-token deployments keep working**: if you just set `SLACK_BOT_TOKEN` (env var or one saved token and nothing else), it's the implicit "default" account — no migration, the `account` parameter is optional.

Tokens for each account are stored separately in tenant-scoped KV (never an env var) and never leave the server — the dashboard only ever sees account names.

## Obsidian Vault (via GitHub)

Required: `GITHUB_PAT`, `GITHUB_REPO` (in `owner/repo` format), and optionally `GITHUB_BRANCH` (default `main`).

The vault connector treats a GitHub repo as the storage backend for your Obsidian vault. Create a private repo, push your vault to it, and the connector reads/writes files via the GitHub Contents API.

Notes carry a `provenance` in their frontmatter: `save_article` writes `provenance: external` (plus `source: <url>`), `vault_write` / `vault_append` add `provenance: assistant` when the note has none, and notes without the field count as `user`. An existing value is never overwritten. `vault_search` shows the provenance of each result; `vault_list` does not.

## Apify

Required: `APIFY_TOKEN`. Find it under [Apify Console → Account → Integrations](https://console.apify.com/account/integrations).

The Apify connector ships native wrappers for 6 LinkedIn actors (profile, company, posts, etc.) plus a generic actor runner protected by an allowlist. To allowlist additional actors, set `APIFY_ACTORS` to a comma-separated list of `username/actor-name` strings.

## Unipile (LinkedIn + WhatsApp)

Required: `UNIPILE_DSN` (e.g. `api41.unipile.com:17153`) and `UNIPILE_TOKEN`.

Sign up at [unipile.com](https://www.unipile.com), grab DSN + API token from **Settings → API**, then connect a LinkedIn account (Sales Navigator-tier recommended for higher daily quotas) and/or a WhatsApp account (scan the QR code from WhatsApp → Linked devices) via **Accounts → Add account**.

Provides 23 tools — LinkedIn prospection, messaging, networking and content, plus personal WhatsApp:

- `linkedin_send_connection` — send a connection request and verify it actually went through (3-poll verify-after-write at 2s/5s/10s). Returns `verified: true|false` — never silent ambiguity. Same `(profile_url, note)` combination is deduped for 90 days; change the note to retry. Per-account daily/weekly caps enforced (25/day, 100/week by default).
- `linkedin_get_relationship_status` — read the network distance (1/2/3/null) of a profile relative to your connected account.
- `linkedin_send_message` — send a LinkedIn DM to a 1st-degree connection. Attachments supported (PDF / PNG / JPEG / GIF, ≤15MB per file, ≤5 files). Verified-after-write (polls at 5s + 10s).
- `linkedin_send_inmail` — send a paid LinkedIn InMail. REQUIRES `allow_inmail: true` to confirm credit usage. Tracks `credits_used` / `credits_remaining` via inmail_balance bracketing. Requires Premium / Sales Navigator / Recruiter.
- `linkedin_engage` — super-tool: routes to `send_message` (1st-degree), `send_connection` (2nd/3rd), `send_inmail` (out-of-network with `allow_inmail: true` + `inmail_subject`), or skip. Supports `dry_run: true` to preview the action without executing.
- `linkedin_list_pending` — list pending LinkedIn invitations sent from the account, with `age_days` and `has_note`. Optional `older_than_days` filter for cleanup loops ("withdraw invitations sent >30 days ago without a note").
- `linkedin_list_inbox` — list LinkedIn conversations (read-only). Filter by `unread_only` and `since_days`. Returns chat_id, attendee, unread state, and last-message timestamp.
- `linkedin_read_messages` — read one LinkedIn conversation by `chat_id` or `profile_url`. Returns inbound + outbound messages, sorted oldest-first.
- `whatsapp_list_inbox` — list WhatsApp conversations (read-only). Filter by `unread_only` and `since_days`. Returns chat_id, name, `conversation_type` (single/group/channel), and unread state.
- `whatsapp_read_messages` — read one WhatsApp conversation by `chat_id`. Returns inbound + outbound messages, sorted oldest-first.
- `whatsapp_find_chat` — find a WhatsApp group or 1:1 chat (and contacts) by name fragment or phone number to get its `chat_id`.
- `whatsapp_search_messages` / `linkedin_search_messages` — keyword search over recent messages (one chat or the whole inbox, last 30 days by default).
- `whatsapp_send_message` — send to a chat (person or group) or to a phone number. Preview first; sends only once you approve it (see below).
- `linkedin_reply` — reply in any existing LinkedIn conversation by `chat_id`. Preview first; sends once approved.
- `linkedin_get_profile` — person or company profile from a URL.
- `linkedin_list_connections` — your 1st-degree connections, optionally filtered by name/headline words.
- `linkedin_search` — search people / companies by keywords or replay a LinkedIn / Sales Navigator search URL.
- `linkedin_list_posts` — recent posts of a person or company.
- `linkedin_react_post`, `linkedin_comment_post`, `linkedin_create_post` — engage and publish (preview first; acts once approved).
- `linkedin_cancel_invitation` — withdraw a stale pending invitation.

Every outgoing action (the spec-v2 tools above and `linkedin_send_connection`, `linkedin_send_message`, `linkedin_send_inmail`, `linkedin_engage`) first returns exactly what it would do and sends nothing. Daily caps, a 10-minute duplicate guard, and the kill switches `KEBAB_UNIPILE_WRITES_DISABLED` / `KEBAB_UNIPILE_WHATSAPP_WRITES_DISABLED` / `KEBAB_UNIPILE_LINKEDIN_WRITES_DISABLED` apply when it runs.

**Approving sends — `KEBAB_APPROVAL_MODE`.**

- `link` (default): the preview comes with an approval link. Open it (you sign in like on `/config`), check the account, recipient and exact text, then click **Approve** or **Reject**. Tell the assistant it is approved: it calls the tool again with the `preview_id` and Kebab sends the approved payload, once — whatever the assistant passes on that call. Links expire after 15 minutes. `confirm: true` on its own is refused. Attachments must be resent identical (they are checked by hash, not stored). On Docker / self-hosted instances set `KEBAB_PUBLIC_URL` (e.g. `https://mcp.example.com`) so the link points to your host; on Vercel it is derived automatically.
- `confirm`: the previous behaviour — the assistant sends after `confirm: true` (spec-v2 tools) or directly (historical LinkedIn tools). The assistant can then approve on its own; use it only if you accept that.

See `docs/SECURITY.md` → *Trust model* for what is and is not protected.

All read tools are strictly read-only — no audit log, no rate-limit, no message sending.

## Browser automation

Required: `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`, `OPENROUTER_API_KEY` (for Stagehand's LLM-driven actions).

Sign up at [browserbase.com](https://www.browserbase.com), create a project, and grab the keys.

## Linear

Required: `LINEAR_API_KEY`. Generate a Personal API Key from Linear → Settings → API → Personal API keys.

Provides 6 tools: list issues, get issue, search issues, list projects, create issue, update issue. All tools support name resolution (team names, state names, etc.).

## Airtable

Required: `AIRTABLE_API_KEY`. Create a Personal Access Token at [airtable.com/create/tokens](https://airtable.com/create/tokens) with read/write scopes for the bases you want to expose.

Provides 7 tools: list bases, list tables, list records, get record, create record, update record, search records.

## Webhook Receiver

Set `MYMCP_WEBHOOKS` to a comma-separated list of webhook names (e.g. `stripe,github`). Inbound payloads are POSTed to `/api/webhook/<name>`.

Optional HMAC-SHA256 validation: set `MYMCP_WEBHOOK_SECRET_<NAME>` per webhook (e.g. `MYMCP_WEBHOOK_SECRET_STRIPE=whsec_...`). The receiver validates the `x-webhook-signature` header against the payload.

Three MCP tools: `webhook_last` retrieves the most recent payload, `webhook_list` shows all active webhooks, and `webhook_history` returns the recent payload history for a named webhook.

## Composio

Required: `COMPOSIO_API_KEY`. Get it from [composio.dev](https://composio.dev) → Settings.

Provides 2 meta-tools (`composio_action`, `composio_list`) that bridge to 1000+ app integrations. Connect your apps in the Composio dashboard first.
