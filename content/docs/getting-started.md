---
title: Getting started
summary: Deploy your personal MCP server in 5 minutes
order: 10
---

## What Kebab MCP gives you

A single Vercel deploy that exposes 86+ tools across 16 connectors (Gmail, Calendar, Drive, GitHub Issues, Linear, Notion, Slack, Obsidian, Airtable, Apify, Composio, Webhook Receiver, paywalled article reader, browser automation, and bring-your-own HTTP APIs) behind one MCP endpoint. Plus user-defined Skills and Custom Tools that compose existing tools into new ones — no code, no deploy. Plug it into Claude Desktop, Claude Code, Cursor, ChatGPT, n8n, or any MCP-aware client and your AI assistant gets your tools.

## Five-minute deploy

The recommended path is **fork-first** — that way your instance can pull upstream updates from `Yassinello/kebab-mcp` on demand without recreating the deploy.

1. **Fork on GitHub.** Open [Yassinello/kebab-mcp](https://github.com/Yassinello/kebab-mcp) and click **Fork**. Use your own account — this becomes your permanent home for the instance.
2. **Import to Vercel.** Go to [vercel.com/new](https://vercel.com/new), pick your fork, and click **Deploy**. No env vars required at this stage.
3. After the first deploy, open the new Vercel URL. You'll land on `/welcome`.
4. Click **Initialize this instance.** Kebab MCP mints a permanent `MCP_AUTH_TOKEN`, writes it to Upstash KV (provisioned automatically via Vercel Marketplace if you don't have one), and the dashboard becomes live.
5. Copy the install snippet for your client — the welcome page has tabs for Claude Desktop, Claude Code, Cursor, and Other — and paste it into your client config.

That's it. Your AI assistant now has tools.

> **Why fork-first?** The previous one-click "Deploy with Vercel" button created standalone snapshots that couldn't pull upstream updates without re-deploying from scratch. The fork path is one extra step but means you keep getting fixes and new connectors over time. If you skip the fork, the dashboard surfaces a red "not-a-fork" banner with a one-click "switch to a fork" flow.

## Adding connectors

By default, none of the heavyweight connectors (Google, Slack, Notion, etc.) are active — they need credentials. Open `/config → Connectors`, click any card to expand its credential form, paste the values, hit **Test connection** to verify, then **Save**. Credentials persist to KV instantly and the connector flips to **Active** without a page reload.

If you set up storage credentials directly in Vercel env vars instead, they take precedence over KV writes — useful for shared/team deploys where you want creds frozen at the deploy boundary.

## Configuring updates (Vercel)

If you deployed on Vercel, you can sync your fork with upstream Kebab MCP (`Yassinello/kebab-mcp`) directly from the dashboard — no terminal required.

**One-time setup:**

1. Generate a GitHub Personal Access Token. Scope: `public_repo` for public forks, `repo` for private forks. Fine-grained PATs need *Contents: read/write* permission on your fork.
2. Open `/config → Settings → Advanced → Updates`.
3. Paste the PAT, click **Save token**, then **Test connection**.

**How it works after setup:**

- A daily cron at 8h UTC pre-fetches upstream status into your Upstash KV.
- The Overview tab banner shows the result instantly (no GitHub round-trip on each page load).
- When new commits land, click **Update now** in the banner — Kebab MCP calls GitHub's `merge-upstream` API and Vercel redeploys automatically (~2 min).
- Possible breaking changes (commits flagged `feat!:` or `BREAKING CHANGE:`) get a heuristic warning + link to the upstream release notes.
- If your fork has diverged (you committed locally on `main`), the button is disabled and a manual-resolution link is shown.

**Refresh icon (↻):** force a re-check between cron runs. 30s debounce to avoid API spam.

**Disable entirely:** set `KEBAB_DISABLE_UPDATE_API=1` in your Vercel env vars.

**Local dev / Docker:** updates work differently — `npm run dev` auto-pulls upstream on start, and `npm run update` is the manual equivalent. See the [README "Staying up to date"](https://github.com/Yassinello/kebab-mcp#staying-up-to-date) section for the full matrix.

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
