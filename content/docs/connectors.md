---
title: Connector setup
summary: How to wire each connector to its credentials
order: 20
---

## How activation works

Every connector ships with a list of required env vars. When all of them are set on the running server, the connector flips to **active** and its tools register. No restart needed in dev; on Vercel you redeploy after editing env vars (or use the dashboard hot-edit which writes to Vercel via the API).

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

Required: `APIFY_API_TOKEN`. Find it under [Apify Console → Account → Integrations](https://console.apify.com/account/integrations).

The Apify connector ships native wrappers for 6 LinkedIn actors (profile, company, posts, etc.) plus a generic actor runner protected by an allowlist. To allowlist additional actors, set `APIFY_ALLOWED_ACTORS` to a comma-separated list of `username/actor-name` strings.

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

Two MCP tools: `webhook_last` retrieves the most recent payload, `webhook_list` shows all active webhooks.

## Composio

Required: `COMPOSIO_API_KEY`. Get it from [composio.dev](https://composio.dev) → Settings.

Provides 2 meta-tools (`composio_action`, `composio_list`) that bridge to 1000+ app integrations. Connect your apps in the Composio dashboard first.
