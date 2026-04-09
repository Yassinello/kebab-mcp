# MyMCP

**Deploy your personal AI backend to Vercel in 5 minutes.**

One endpoint. Your email, calendar, notes, and browser — all accessible to Claude, ChatGPT, or any MCP client. Open source. No Docker. No vendor lock-in.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FYassinello%2Fmymcp&env=MCP_AUTH_TOKEN&envDescription=Required%20env%20vars%20for%20MyMCP&envLink=https%3A%2F%2Fgithub.com%2FYassinello%2Fmymcp%23configuration)

## What is this?

MyMCP is a personal MCP server framework. It ships **38 pre-built tools** across 4 packs that you enable via env vars:

| Pack | Tools | What it does |
|------|-------|-------------|
| **Google Workspace** | 18 | Gmail, Calendar, Contacts, Drive |
| **Obsidian Vault** | 15 | Read, write, search notes via GitHub |
| **Browser Automation** | 4 | AI-powered browsing via Stagehand/Browserbase |
| **Admin** | 1 | Tool call logs |

You fork, set env vars, deploy to Vercel. Done.

## Quick Start

### 1. Deploy

Click the **Deploy with Vercel** button above, or:

```bash
git clone https://github.com/Yassinello/mymcp.git
cd mymcp
cp .env.example .env
# Fill in your values
npm install
npm run dev
```

### 2. Configure

Set env vars in Vercel (or `.env` locally). Packs auto-activate when their credentials are present:

```bash
# Required
MCP_AUTH_TOKEN=your-secret-token

# Google Workspace pack (set all 3 to enable)
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...

# Vault pack (set both to enable)
GITHUB_PAT=...
GITHUB_REPO=username/my-vault

# Browser pack (set all 3 to enable)
BROWSERBASE_API_KEY=...
BROWSERBASE_PROJECT_ID=...
OPENROUTER_API_KEY=...
```

See [`.env.example`](.env.example) for all options.

### 3. Connect to Claude Desktop

Add to your Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "mymcp": {
      "url": "https://your-app.vercel.app/api/mcp",
      "headers": {
        "Authorization": "Bearer your-secret-token"
      }
    }
  }
}
```

## Architecture

```
src/
  core/               ← Framework (types, registry, config, auth, logging)
  packs/
    google/           ← Google Workspace (18 tools)
      manifest.ts     ← Pack definition + tool list
      lib/            ← API wrappers (gmail, calendar, etc.)
      tools/          ← Individual tool handlers
    vault/            ← Obsidian Vault (15 tools)
    browser/          ← Browser Automation (4 tools)
    admin/            ← Admin (1 tool)
app/
  api/
    [transport]/      ← MCP endpoint (reads from registry)
    health/           ← Public liveness check
```

**How it works:**
1. Each pack has a `manifest.ts` declaring its tools and required env vars
2. The registry checks which packs have their env vars set
3. `route.ts` iterates enabled packs and registers their tools with the MCP server
4. ~30 lines of route.ts replaces what used to be ~350 lines of hardcoded imports

## Tool Packs

### Google Workspace

`gmail_inbox` `gmail_read` `gmail_send` `gmail_reply` `gmail_trash` `gmail_label` `gmail_search` `gmail_draft` `gmail_attachment` `calendar_events` `calendar_create` `calendar_update` `calendar_delete` `calendar_find_free` `calendar_rsvp` `contacts_search` `drive_search` `drive_read`

### Obsidian Vault

`vault_read` `vault_write` `vault_search` `vault_list` `vault_delete` `vault_move` `vault_append` `vault_batch_read` `vault_recent` `vault_stats` `vault_backlinks` `vault_due` `save_article` `read_paywalled` `my_context`

### Browser Automation

`web_browse` `web_extract` `web_act` `linkedin_feed`

### Admin

`mcp_logs`

## Configuration

All configuration is via environment variables. No config files to maintain.

| Variable | Required | Description |
|----------|----------|-------------|
| `MCP_AUTH_TOKEN` | Yes | Bearer token for MCP endpoint |
| `ADMIN_AUTH_TOKEN` | No | Separate token for dashboard (falls back to MCP_AUTH_TOKEN) |
| `MYMCP_TIMEZONE` | No | Timezone (default: UTC) |
| `MYMCP_LOCALE` | No | Locale (default: en-US) |
| `MYMCP_DISPLAY_NAME` | No | Display name (default: User) |
| `MYMCP_CONTEXT_PATH` | No | Vault context file path (default: System/context.md) |

### Pack Activation

Packs activate automatically when all their required env vars are present. To force-disable:

```bash
MYMCP_DISABLE_GOOGLE=true
```

To explicitly control which packs activate:

```bash
MYMCP_ENABLED_PACKS=vault,admin
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to add tools and packs.

## License

[MIT](LICENSE)
