# MyMCP

**Deploy your personal AI backend to Vercel in 5 minutes.**

One MCP endpoint. Your email, calendar, notes, and browser — all accessible to Claude, ChatGPT, or any AI assistant. Open source. No Docker. No vendor lock-in.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FYassinello%2Fmymcp&env=MCP_AUTH_TOKEN&envDescription=Required%20env%20vars%20for%20MyMCP&envLink=https%3A%2F%2Fgithub.com%2FYassinello%2Fmymcp%23configuration)

---

## Why MyMCP?

Most MCP setups require running 5 separate servers, each with their own config. Or paying for a hosted platform that controls your data.

MyMCP gives you **one server, one endpoint, 38 tools** — deployed on Vercel's free tier. You own everything.

| | MyMCP | Separate MCP servers | Hosted platforms |
|---|---|---|---|
| **Setup** | Fork + env vars + deploy | 5 repos, 5 configs | Sign up + monthly fee |
| **Tools** | 38 pre-built | Build your own | 1000s (but vendor lock-in) |
| **Endpoint** | 1 | 5+ | 1 (their server) |
| **Cost** | Free (Vercel free tier) | Free but complex | $0-80/month |
| **Data** | Your Vercel, your keys | Your machines | Their servers |
| **Docker** | No | Usually yes | N/A |

## Tool Packs

MyMCP ships **38 production-ready tools** organized in 4 packs. Each pack activates automatically when its credentials are present.

### Google Workspace (18 tools)
`gmail_inbox` `gmail_read` `gmail_send` `gmail_reply` `gmail_trash` `gmail_label` `gmail_search` `gmail_draft` `gmail_attachment` `calendar_events` `calendar_create` `calendar_update` `calendar_delete` `calendar_find_free` `calendar_rsvp` `contacts_search` `drive_search` `drive_read`

**Requires:** `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` + `GOOGLE_REFRESH_TOKEN`

### Obsidian Vault (15 tools)
`vault_read` `vault_write` `vault_search` `vault_list` `vault_delete` `vault_move` `vault_append` `vault_batch_read` `vault_recent` `vault_stats` `vault_backlinks` `vault_due` `save_article` `read_paywalled` `my_context`

**Requires:** `GITHUB_PAT` + `GITHUB_REPO`

### Browser Automation (4 tools)
`web_browse` `web_extract` `web_act` `linkedin_feed`

AI-powered cloud browser via Stagehand/Browserbase. Browse JS-rendered pages, extract structured data, execute actions.

**Requires:** `BROWSERBASE_API_KEY` + `BROWSERBASE_PROJECT_ID` + `OPENROUTER_API_KEY`

### Admin (1 tool)
`mcp_logs` — always active, no credentials needed.

## Quick Start

### Option 1: Deploy to Vercel (recommended)

1. Click the **Deploy with Vercel** button above
2. Set `MCP_AUTH_TOKEN` (generate: `openssl rand -hex 32`)
3. Add credentials for the packs you want (see [Configuration](#configuration))
4. Deploy — your MCP endpoint is live

### Option 2: Run locally

```bash
git clone https://github.com/Yassinello/mymcp.git
cd mymcp
cp .env.example .env    # Fill in your values
npm install
npm run dev             # http://localhost:3000
```

### Connect to Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mymcp": {
      "url": "https://your-app.vercel.app/api/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_AUTH_TOKEN"
      }
    }
  }
}
```

### Connect to Claude Code

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "mymcp": {
      "type": "http",
      "url": "https://your-app.vercel.app/api/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_AUTH_TOKEN"
      }
    }
  }
}
```

## Architecture

```
src/
  core/                 ← Framework (types, registry, config, auth, logging)
    types.ts            ← PackManifest, ToolDefinition, InstanceConfig
    registry.ts         ← Resolves which packs are active from env vars
    config.ts           ← Reads MYMCP_* instance settings
    auth.ts             ← MCP + admin auth (timing-safe)
    logging.ts          ← withLogging decorator + ephemeral log buffer

  packs/
    google/             ← Google Workspace (18 tools)
      manifest.ts       ← Pack definition — single source of truth
      lib/              ← Gmail, Calendar, Contacts, Drive API wrappers
      tools/            ← Individual tool handlers
    vault/              ← Obsidian Vault (15 tools)
    browser/            ← Browser Automation (4 tools)
    admin/              ← Admin & Observability (1 tool)

app/
  api/
    [transport]/        ← MCP endpoint (~30 lines — reads from registry)
    health/             ← Public liveness: { ok, version }
    admin/status/       ← Private diagnostics (auth-gated)
    auth/google/        ← OAuth consent flow
  /                     ← Private status dashboard
  /setup                ← Guided setup page
```

**How it works:**
1. Each pack has a `manifest.ts` declaring its tools and required env vars
2. The registry checks env vars to determine which packs are active
3. `route.ts` iterates enabled packs and registers tools via the MCP SDK
4. Dashboard, health, and admin endpoints all derive from the same registry

**Single source of truth:** Pack manifests are the only place tool definitions live. Everything else (MCP registration, dashboard UI, admin API, health status) reads from them.

## Configuration

All configuration is via environment variables. No config files to maintain. `git pull` never conflicts.

### Auth

| Variable | Required | Description |
|----------|----------|-------------|
| `MCP_AUTH_TOKEN` | Yes | Bearer token for MCP endpoint |
| `ADMIN_AUTH_TOKEN` | No | Separate token for dashboard (falls back to MCP_AUTH_TOKEN) |

### Instance Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `MYMCP_TIMEZONE` | `UTC` | Timezone for date formatting |
| `MYMCP_LOCALE` | `en-US` | Locale for date/number formatting |
| `MYMCP_DISPLAY_NAME` | `User` | Display name in dashboard |
| `MYMCP_CONTEXT_PATH` | `System/context.md` | Path to personal context file in vault |
| `GITHUB_BRANCH` | `main` | Default branch for vault repo |

### Pack Control

Packs activate automatically when credentials are present. Override with:

```bash
MYMCP_DISABLE_GOOGLE=true          # Force-disable even with credentials
MYMCP_ENABLED_PACKS=vault,admin    # Only these packs are considered
```

See [`.env.example`](.env.example) for all variables with descriptions and source URLs.

## Security

- **Auth:** Timing-safe token comparison for both MCP and admin endpoints
- **SSRF protection:** Browser tools block localhost, private IPs, and cloud metadata endpoints
- **Error sanitization:** API keys are stripped from error messages
- **Rate limiting:** LinkedIn feed limited to 3 calls/day (vault-persisted counter)
- **OAuth:** State parameter validation, PKCE, HttpOnly cookies
- **Private by default:** Dashboard and setup require admin auth. Health endpoint returns only `{ok, version}`.

**Note:** The `?token=` query string auth (for browser access to dashboard) exposes the token in browser history and referrer headers. For sensitive deployments, use the `Authorization` header exclusively.

## Endpoints

| Endpoint | Auth | Description |
|----------|------|-------------|
| `POST /api/mcp` | MCP_AUTH_TOKEN | MCP Streamable HTTP endpoint |
| `GET /api/health` | None (public) | Liveness check: `{ok, version}` |
| `GET /api/admin/status` | ADMIN_AUTH_TOKEN | Pack diagnostics, tool list, config, logs |
| `GET /` | ADMIN_AUTH_TOKEN | Status dashboard |
| `GET /setup` | ADMIN_AUTH_TOKEN | Guided setup page |
| `GET /api/auth/google` | ADMIN_AUTH_TOKEN | Google OAuth consent redirect |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to add tools and packs.

**Quick version:** Add a file to `src/packs/<pack>/tools/`, register it in the pack's `manifest.ts`. That's it.

## Tech Stack

- **Runtime:** Next.js on Vercel (serverless)
- **Language:** TypeScript (strict)
- **MCP:** `@modelcontextprotocol/sdk` via `mcp-handler`
- **Validation:** Zod
- **Browser:** Stagehand + Browserbase
- **OAuth:** Arctic
- **License:** MIT

## License

[MIT](LICENSE)
