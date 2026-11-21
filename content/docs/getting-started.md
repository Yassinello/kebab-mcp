---
title: Getting started
summary: Deploy your Kebab House in about 10 minutes
order: 10
---

## What Kebab House gives you

One deploy on your own Vercel account gives every AI client you use the same profile, the same skills and the same memory, behind one MCP endpoint. On top: the tools your clients don't ship (LinkedIn, WhatsApp, a real browser, paywalled articles, any HTTP API as a tool), and guardrails that keep outgoing messages and write access under your control.

You need a GitHub account and a free Vercel account; about 10 minutes, no code.

## Deploy

The recommended path is the **Deploy with Vercel** button on [/deploy](https://kebab-mcp.vercel.app/deploy).

1. **Deploy with Vercel.** One click creates a copy of the repo in your GitHub account, a Vercel project and a free Upstash Redis database, then deploys. No env vars required.
2. When the build is done, open the new Vercel URL. You'll land on `/welcome` (Upstash is already attached, so the storage step is skipped).
3. Click **Initialize this instance.** Kebab House mints your **admin key** (stored as `MCP_AUTH_TOKEN` in your database). It opens this dashboard — keep it somewhere safe, and do not paste it into AI clients.
4. Connect your clients. Claude, ChatGPT, Cursor and Claude Code: add the instance URL and sign in, then pick the access level (*read + my profile and notes* is the recommended one). Other clients: **Devices → Add device** gives each one its own device token.
5. In your AI client, say **“Set up my Kebab House”**: a short interview writes your profile and installs the rituals you pick.

> **Keep your repository private.** The copy the button creates is not a fork, so it can be private (GitHub → your repo → *Settings* → *Change visibility*). Your secrets live in Vercel and Upstash either way, never in the repo.
>
> **Contributing to Kebab House?** Fork [Yassinello/kebab-mcp](https://github.com/Yassinello/kebab-mcp) on GitHub, import the fork at [vercel.com/new](https://vercel.com/new), then attach *Upstash for Redis* from the project's *Storage* tab. Note that **a fork of a public repo is always public**: GitHub doesn't let you change its visibility. Use a fork for contributions, the button for a personal instance. Both paths get one-click updates (below).

## Adding connectors

By default, none of the heavyweight connectors (Google, Slack, Notion, etc.) are active — they need credentials. Open `/config → Connectors`, click any card to expand its credential form, paste the values, hit **Test connection** to verify, then **Save**. Credentials persist to KV instantly and the connector flips to **Active** without a page reload.

If you set up storage credentials directly in Vercel env vars instead, they take precedence over KV writes — useful for shared/team deploys where you want creds frozen at the deploy boundary.

## Configuring updates (Vercel)

If you deployed on Vercel, you can pull upstream Kebab House (`Yassinello/kebab-mcp`) releases directly from the dashboard — no terminal required.

Without any setup, the **Overview** tab tells you when a new release is out (it reads the public upstream repository, no token needed). Installing it in one click needs a token:

**One-time setup:**

1. Generate a GitHub Personal Access Token. Fine-grained PATs need *Contents: read/write* on the repo your instance deploys from. Classic PATs: `public_repo` for a public repo, `repo` for a private one.
2. Open `/config → Advanced → Settings → Advanced → Updates`.
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
# fill in MCP_AUTH_TOKEN at minimum (generate one: openssl rand -hex 32)
npm run dev
```

The dashboard is at `http://localhost:3000/config?token=<your-token>` and the MCP endpoint at `http://localhost:3000/api/mcp`.

**Docker** runs in production mode, where the dashboard refuses the MCP token: also set `ADMIN_AUTH_TOKEN` (a second `openssl rand -hex 32` value, your admin key), or `KEBAB_ADMIN_TOKEN_FALLBACK=1` to reuse `MCP_AUTH_TOKEN` for the dashboard.
