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

## Slack

Required: `SLACK_BOT_TOKEN` (`xoxb-...`). Create a Slack app, add scopes (`channels:read`, `chat:write`, `groups:read`, `im:read`, `mpim:read`, `search:read`, `users:read`), install to your workspace, copy the Bot User OAuth Token.

## Obsidian Vault (via GitHub)

Required: `GITHUB_PAT`, `GITHUB_REPO` (in `owner/repo` format), and optionally `GITHUB_BRANCH` (default `main`).

The vault connector treats a GitHub repo as the storage backend for your Obsidian vault. Create a private repo, push your vault to it, and the connector reads/writes files via the GitHub Contents API.

## Apify

Required: `APIFY_TOKEN`. Find it under [Apify Console → Account → Integrations](https://console.apify.com/account/integrations).

The Apify connector ships native wrappers for 6 LinkedIn actors (profile, company, posts, etc.) plus a generic actor runner protected by an allowlist. To allowlist additional actors, set `APIFY_ACTORS` to a comma-separated list of `username/actor-name` strings.

## Unipile (LinkedIn + WhatsApp)

Required: `UNIPILE_DSN` (e.g. `api41.unipile.com:17153`) and `UNIPILE_TOKEN`.

Sign up at [unipile.com](https://www.unipile.com), grab DSN + API token from **Settings → API**, then connect a LinkedIn account (Sales Navigator-tier recommended for higher daily quotas) and/or a WhatsApp account via **Accounts → Add account**.

Provides 10 tools — 6 LinkedIn write/read, 2 LinkedIn inbox readers, 2 WhatsApp inbox readers:

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

All four inbox tools are strictly read-only — no audit log, no rate-limit, no message sending.

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
