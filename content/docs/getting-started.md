---
title: Getting started
summary: Deploy your personal MCP server in 5 minutes
order: 10
---

## What Kebab MCP gives you

A single Vercel deploy that exposes 97+ tools across 19 connectors (Gmail, Calendar, Drive, GitHub Issues, Linear, Notion, Slack, Obsidian, Airtable, Apify, Composio, Webhook Receiver, paywalled article reader, browser automation, Unipile LinkedIn writes, and bring-your-own HTTP APIs) behind one MCP endpoint. Plus user-defined Skills and Custom Tools that compose existing tools into new ones — no code, no deploy. Plug it into Claude Desktop, Claude Code, Cursor, ChatGPT, n8n, or any MCP-aware client and your AI assistant gets your tools.

## Five-minute deploy

The recommended path is the **Deploy with Vercel** button on [/deploy](https://kebab-mcp.vercel.app/deploy).

1. **Deploy with Vercel.** One click creates a copy of the repo in your GitHub account, a Vercel project and a free Upstash Redis database, then deploys. No env vars required.
2. When the build is done, open the new Vercel URL. You'll land on `/welcome` (Upstash is already attached, so the storage step is skipped).
3. Click **Initialize this instance.** Kebab MCP mints a permanent `MCP_AUTH_TOKEN`, writes it to Upstash KV, and the dashboard becomes live.
4. Copy the install snippet for your client — the welcome page has tabs for Claude Desktop, Claude Code, Cursor, and Other — and paste it into your client config.

That's it. Your AI assistant now has tools.

> **Prefer a real fork?** Fork [Yassinello/kebab-mcp](https://github.com/Yassinello/kebab-mcp) on GitHub, import the fork at [vercel.com/new](https://vercel.com/new), then attach *Upstash for Redis* from the project's *Storage* tab. Both paths get one-click updates (below).

## Adding connectors

By default, none of the heavyweight connectors (Google, Slack, Notion, etc.) are active — they need credentials. Open `/config → Connectors`, click any card to expand its credential form, paste the values, hit **Test connection** to verify, then **Save**. Credentials persist to KV instantly and the connector flips to **Active** without a page reload.

If you set up storage credentials directly in Vercel env vars instead, they take precedence over KV writes — useful for shared/team deploys where you want creds frozen at the deploy boundary.

## Configuring updates (Vercel)

If you deployed on Vercel, you can pull upstream Kebab MCP (`Yassinello/kebab-mcp`) releases directly from the dashboard — no terminal required.

**One-time setup:**

1. Generate a GitHub Personal Access Token. Fine-grained PATs need *Contents: read/write* on the repo your instance deploys from. Classic PATs: `public_repo` for a public repo, `repo` for a private one.
2. Open `/config → Settings → Advanced → Updates`.
3. Paste the PAT, click **Save token**, then **Test connection**.

**How it works after setup:**

- A daily cron at 8h UTC pre-fetches upstream status into your Upstash KV.
- The Overview tab banner shows the result instantly (no GitHub round-trip on each page load).
- When an update is out, click **Update now** in the banner; Vercel redeploys automatically (~2 min). A fork is synced with GitHub's `merge-upstream` API. A Deploy Button copy (not a fork) uses **release sync**: the files changed by the latest release are copied into your repo as one commit, and the sync stops without writing anything if you edited one of those files (they are listed).
- Possible breaking changes (commits flagged `feat!:` or `BREAKING CHANGE:`) get a heuristic warning + link to the upstream release notes.
- If your fork has diverged (you committed locally on `main`), the button is disabled and a manual-resolution link is shown.

**Refresh icon (↻):** force a re-check between cron runs. 30s debounce to avoid API spam.

**Disable entirely:** set `KEBAB_DISABLE_UPDATE_API=1` in your Vercel env vars.

**Local dev / Docker:** updates work differently — `npm run dev` auto-pulls upstream on start, and `npm run update` is the manual equivalent. See the [README "Updates & durability"](https://github.com/Yassinello/kebab-mcp#updates--durability) section for the full matrix.

## Local development

```
git clone https://github.com/Yassinello/kebab-mcp
cd kebab-mcp
npm install
cp .env.example .env.local
# fill in MCP_AUTH_TOKEN at minimum
npm run dev
```

The dashboard is at `http://localhost:3000/config?token=<your-token>` and the MCP endpoint at `http://localhost:3000/api/mcp`.
