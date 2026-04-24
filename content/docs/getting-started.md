---
title: Getting started
summary: Deploy your personal MCP server in 5 minutes
order: 10
---

## What Kebab MCP gives you

A single Vercel deploy that exposes 86+ tools across 15 connectors (Gmail, Calendar, Drive, GitHub Issues, Linear, Notion, Slack, Obsidian, Airtable, Apify, Composio, Webhook Receiver, paywalled article reader, browser automation, and bring-your-own HTTP APIs) behind one MCP endpoint. Plus user-defined Skills that create dynamic tools from prompt templates. Plug it into Claude Desktop, Claude Code, Cursor, ChatGPT, n8n, or any MCP-aware client and your AI assistant gets your tools.

## Five-minute deploy

1. Click **Deploy to Vercel** on the [GitHub readme](https://github.com/Yassinello/kebab-mcp). Vercel forks the repo into your account and walks you through env vars.
2. Skip the env vars at deploy time — you can paste them later.
3. After the first deploy, open the new Vercel app URL. You will land on `/welcome`.
4. Click **Initialize this instance**. Kebab MCP mints a permanent `MCP_AUTH_TOKEN`, writes it to your Vercel project, and triggers a redeploy automatically.
5. When the redeploy lands, copy the install snippet for your client (the welcome page has tabs for Claude Desktop, Claude Code, Cursor, and Other) and paste it into your client config.

That's it. Your AI assistant now has tools.

## Adding connectors

By default, none of the heavyweight connectors (Google, Slack, Notion, etc.) are active — they need credentials. Open `/config → Connectors` and follow the per-connector credential guide. Each connector activates automatically when its required env vars are set.

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
