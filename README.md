<p align="center">
  <h1 align="center">MyMCP</h1>
  <p align="center"><strong>Your personal AI backend. One endpoint. 84+ tools. Deploy in 5 minutes.</strong></p>
</p>

<p align="center">
  <a href="https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FYassinello%2Fmymcp&project-name=mymcp-me&repository-name=mymcp-me"><img src="https://vercel.com/button" alt="Deploy with Vercel" /></a>
</p>

<p align="center">
  <img src="https://img.shields.io/github/license/Yassinello/mymcp" alt="License: MIT" />
  <img src="https://img.shields.io/github/v/release/Yassinello/mymcp?label=version" alt="Version" />
  <img src="https://img.shields.io/github/stars/Yassinello/mymcp?style=social" alt="GitHub stars" />
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &middot;
  <a href="#connectors">Connectors</a> &middot;
  <a href="#architecture">Architecture</a> &middot;
  <a href="#configuration">Configuration</a> &middot;
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

---

```
┌─────────────────────────────────────────────────────────────────────┐
│                       Claude / ChatGPT / AI                         │
│                      (any MCP-compatible client)                    │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ MCP (Streamable HTTP)
                               ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                              MyMCP on Vercel / Docker                                   │
│                                                                                         │
│  ┌──────────┐ ┌────────┐ ┌────────┐ ┌───────┐ ┌────────┐ ┌─────────┐ ┌──────┐         │
│  │  Google   │ │ Vault  │ │Browser │ │ Slack │ │ Notion │ │Composio │ │Apify │         │
│  │ Workspace │ │Obsidian│ │  Auto  │ │       │ │        │ │ 1000+   │ │ LI + │         │
│  │ 18 tools  │ │14 tools│ │4 tools │ │6 tools│ │5 tools │ │  apps   │ │actors│         │
│  └──────────┘ └────────┘ └────────┘ └───────┘ └────────┘ └─────────┘ └──────┘         │
│  ┌──────────┐ ┌────────┐ ┌────────┐ ┌───────┐ ┌────────┐ ┌─────────┐ ┌──────┐         │
│  │  GitHub   │ │ Linear │ │Airtable│ │Paywall│ │Webhook │ │ Skills  │ │Admin │         │
│  │  Issues   │ │ Issues │ │ Bases  │ │Reader │ │Receiver│ │Composer │ │ Logs │         │
│  │  6 tools  │ │6 tools │ │7 tools │ │2 tools│ │2 tools │ │ dynamic │ │4 tool│         │
│  └──────────┘ └────────┘ └────────┘ └───────┘ └────────┘ └─────────┘ └──────┘         │
│                                                                                         │
│  Registry ← Connector Manifests ← Env vars (auto-activation) ← Per-tool toggles        │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

## The Story

I built MyMCP because I wanted a single MCP server that works everywhere (Claude, ChatGPT, Cursor, Windsurf, OpenClaw, ..). It started as a simple bridge to my Obsidian vault with a few tools, and kept growing as I added Google Workspace, browser automation, Slack, Notion, and LinkedIn via Apify. At some point I realized: if it's useful to me, it might be useful to others, so I open-sourced it.

## Why MyMCP?

Most MCP setups require running 5 separate servers, each with their own config. Or paying for a hosted platform that controls your data.

MyMCP gives you **one server, one endpoint, 84+ tools** — deployed on Vercel's free tier (or Docker). You own everything.

| | MyMCP | Separate MCP servers | Hosted platforms |
|---|---|---|---|
| **Setup** | Fork + env vars + deploy | 5 repos, 5 configs | Sign up + monthly fee |
| **Tools** | 84+ pre-built | Build your own | 1000s (but vendor lock-in) |
| **Endpoint** | 1 | 5+ | 1 (their server) |
| **Cost** | Free (Vercel free tier) | Free but complex | $0-80/month |
| **Data** | Your Vercel, your keys | Your machines | Their servers |
| **Docker** | Yes | Usually yes | N/A |

## Quick Start

> **Which option should I pick?**
>
> | You are... | Best option |
> |---|---|
> | Using Claude Code (CLI or Desktop) | [Option 1](#option-1-from-claude-code-recommended) — ask Claude to do it for you |
> | Comfortable with the terminal | [Option 2](#option-2-interactive-installer) — `npx @yassinello/create-mymcp` |
> | Prefer clicking buttons | [Option 3](#option-3-deploy-to-vercel) — one-click Vercel deploy |
> | Want to self-host | [Option 4](#option-4-docker) |

---

### Option 1: From Claude Code (recommended)

If you're using Claude Code (Desktop, CLI, or Web), just run the installer from the conversation. No need to create a folder first — the installer will ask you where to set up.

```bash
npx @yassinello/create-mymcp@latest
```

Or ask Claude to run it for you:

> "Run `npx @yassinello/create-mymcp@latest` and help me set up MyMCP."

The installer will:
1. Clone the repo to your machine
2. Walk you through which connectors to enable (Google, Obsidian, Slack...)
3. Generate your `MCP_AUTH_TOKEN` securely
4. Collect your API credentials (with links to get them)
5. Create your `.env` file
6. Install dependencies
7. Optionally deploy to Vercel

Claude can then help you add the MCP server to your config and verify everything works.

---

### Option 2: Interactive installer

```bash
npx @yassinello/create-mymcp@latest
```

The CLI walks you through everything step by step:

```
[1/5] Project setup        → Pick a directory name
[2/5] Cloning MyMCP        → Downloads the code + sets up update tracking
[3/5] Choose your connectors    → Google Workspace? Obsidian? Slack? (Y/n for each)
[4/5] Configure credentials → Paste your API keys (with links to get them)
[5/5] Install & deploy     → npm install + optional Vercel deploy
```

At the end you get a working `.env`, installed dependencies, and an `upstream` remote for future updates.

---

### Option 3: Deploy to Vercel

1. Click the **Deploy with Vercel** button at the top of this page
2. Pick a name (default: `mymcp-me`) and click **Deploy** — no env vars to fill in
3. Once Vercel finishes (~60s), open the deployed URL — you'll land on `/welcome`
4. Click **Initialize this instance** to mint your permanent `MCP_AUTH_TOKEN`, copy it, then paste it into Vercel's env vars and trigger a redeploy
5. Add connector credentials at `/config/connectors` once the dashboard is reachable

---

### Option 4: Docker

```bash
git clone https://github.com/Yassinello/mymcp.git
cd mymcp
cp .env.example .env    # Fill in your API keys
docker compose up       # or: docker build -t mymcp . && docker run -p 3000:3000 --env-file .env mymcp
```

---

### Option 5: Run locally (development)

```bash
git clone https://github.com/Yassinello/mymcp.git
cd mymcp
cp .env.example .env    # Fill in your values
npm install
npm run dev             # http://localhost:3000
```

---

### Connect your AI client

Once deployed, add MyMCP to your AI client's config:

<details>
<summary><strong>Claude Desktop</strong></summary>

File: `~/Library/Application Support/Claude/claude_desktop_config.json` (Mac) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows)

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
</details>

<details>
<summary><strong>Claude Code</strong></summary>

File: `~/.claude.json` (global) or `.mcp.json` (per-project)

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
</details>

<details>
<summary><strong>Cursor</strong></summary>

File: `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per-project)

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
</details>

<details>
<summary><strong>Windsurf</strong></summary>

File: `~/.codeium/windsurf/mcp_config.json`

```json
{
  "mcpServers": {
    "mymcp": {
      "serverUrl": "https://your-app.vercel.app/api/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_AUTH_TOKEN"
      }
    }
  }
}
```
</details>

<details>
<summary><strong>ChatGPT / Other MCP clients</strong></summary>

Use the Streamable HTTP endpoint:
- **URL**: `https://your-app.vercel.app/api/mcp`
- **Auth**: Bearer token (your `MCP_AUTH_TOKEN`)
- **Method**: POST
</details>

---

### Staying up to date

MyMCP is a [template repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-template-repository). Your copy is standalone — it won't auto-update. Three ways to pull new tools and fixes, from zero-effort to fully manual:

#### 1. Automatic — updates on every `npm run dev` (default)

Every time you start the dev server, a `predev` hook checks for upstream changes and fast-forwards your working copy silently. You'll see one of these lines in the terminal before Next.js starts:

```
[mymcp update] up to date
[mymcp update] pulled 3 commits from upstream/main
[mymcp update] skipped (uncommitted changes — commit/stash first)
```

The check is safe by design: it **never** rewrites local work. If you have uncommitted changes, diverged commits, or no remote configured, it skips silently and lets `next dev` start normally.

To opt out permanently (e.g. on a CI/CD environment), set `MYMCP_SKIP_UPDATE_CHECK=1` in your `.env`. The check is also auto-skipped on Vercel and CI platforms.

#### 2. In-dashboard — "Update now" button in `/config → Overview`

The dashboard polls GitHub when you open it. When new commits land, you'll see an orange banner:

> **3 updates available**
> New commits on upstream/main (latest: `abc1234`) — fast-forward safe.
> **[Update now]**

Clicking **Update now** runs the same fast-forward merge as option 1 without touching the terminal. After the merge, Next.js hot-reloads most changes on the fly — only structural changes (dependency bumps, new connector manifests) require a dev server restart.

This is the recommended flow if you keep the dashboard open while working.

#### 3. Manual — `npm run update`

The classic CLI flow still works:

```bash
# One-time setup (skip if you used npx @yassinello/create-mymcp — already done)
git remote add upstream https://github.com/Yassinello/mymcp.git

# Pull updates anytime
npm run update
```

Equivalent to `git fetch upstream && git merge upstream/main`. Useful when you're already in the terminal and don't want to restart the dev server.

---

**Your `.env` and `data/` are never touched** — all customization lives in env vars and the gitignored `data/` directory, not in tracked code. Updates are always safe to merge.

**When the Vercel flow applies:** if you're running on Vercel instead of locally, the in-dashboard updater is disabled. Just `git push` your fork and Vercel redeploys automatically.

## Connectors

MyMCP ships **84+ production-ready tools** organized in 14 connectors. Each connector activates automatically when its credentials are present in env vars. Additionally, user-defined **Skills** create dynamic tools from prompt templates.

### Google Workspace — 18 tools

| Category | Tools |
|----------|-------|
| **Gmail** | `gmail_inbox` `gmail_read` `gmail_send` `gmail_reply` `gmail_trash` `gmail_label` `gmail_search` `gmail_draft` `gmail_attachment` |
| **Calendar** | `calendar_events` `calendar_create` `calendar_update` `calendar_delete` `calendar_find_free` `calendar_rsvp` |
| **Contacts** | `contacts_search` |
| **Drive** | `drive_search` `drive_read` |

**Requires:** `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` + `GOOGLE_REFRESH_TOKEN`

### Obsidian Vault — 14 tools

| Category | Tools |
|----------|-------|
| **CRUD** | `vault_read` `vault_write` `vault_delete` `vault_move` `vault_append` `vault_list` |
| **Batch & Search** | `vault_batch_read` `vault_search` `vault_recent` `vault_stats` |
| **Knowledge Graph** | `vault_backlinks` `vault_due` |
| **Web → Vault** | `save_article` |
| **Context** | `my_context` |

**Requires:** `GITHUB_PAT` + `GITHUB_REPO`

### Browser Automation — 4 tools

| Tool | What it does |
|------|-------------|
| `web_browse` | Open URL, return visible text (handles JS-rendered pages) |
| `web_extract` | Extract structured data with AI (e.g., "get all prices from this page") |
| `web_act` | Execute actions: click, type, fill forms (natural language) |
| `linkedin_feed` | Read LinkedIn feed (rate-limited, persistent session) |

**Requires:** `BROWSERBASE_API_KEY` + `BROWSERBASE_PROJECT_ID` + `OPENROUTER_API_KEY`

### Slack — 6 tools

| Tool | What it does |
|------|-------------|
| `slack_channels` | List channels with topic, member count |
| `slack_read` | Read recent messages from a channel |
| `slack_send` | Send a message or threaded reply |
| `slack_search` | Search messages (supports Slack operators: from:, in:, has:) |
| `slack_thread` | Read all replies in a thread |
| `slack_profile` | Get user profile: name, title, email, timezone, status |

**Requires:** `SLACK_BOT_TOKEN`

### Notion — 5 tools

| Tool | What it does |
|------|-------------|
| `notion_search` | Search pages by title or content |
| `notion_read` | Read full page content as markdown |
| `notion_create` | Create a page in a database |
| `notion_update` | Update page properties and/or append content |
| `notion_query` | Query a database with filters and sorting |

**Requires:** `NOTION_API_KEY`

### Apify — 8 tools

LinkedIn scraping and general actor execution via the Apify platform.

| Tool | What it does |
|------|-------------|
| `apify_linkedin_profile` | Fetch a LinkedIn person profile |
| `apify_linkedin_company` | Fetch a LinkedIn company profile |
| `apify_linkedin_profile_posts` | Get recent posts from a LinkedIn profile |
| `apify_linkedin_company_posts` | Get recent posts from a LinkedIn company page |
| `apify_linkedin_post` | Fetch a specific LinkedIn post |
| `apify_linkedin_company_insights` | Get company follower/employee insights |
| `apify_search_actors` | Search Apify's actor marketplace |
| `apify_run_actor` | Run any Apify actor with custom input |

**Requires:** `APIFY_TOKEN`

### Paywall — 2 tools

| Tool | What it does |
|------|-------------|
| `read_paywalled` | Read paywalled articles via a reader service |
| `read_paywalled_hard` | Hard-bypass fallback for stubborn paywalls |

No credentials required — always active.

### Linear — 6 tools

| Tool | What it does |
|------|-------------|
| `linear_list_issues` | List issues with team, project, state, and assignee filters |
| `linear_get_issue` | Get full issue details by identifier (e.g. ENG-123), including comments |
| `linear_search_issues` | Full-text search across all issues |
| `linear_list_projects` | List projects with team filter, progress, and dates |
| `linear_create_issue` | Create an issue with name resolution for team, state, assignee, and labels |
| `linear_update_issue` | Update an issue with same name resolution layer |

**Requires:** `LINEAR_API_KEY` (Settings → API → Personal API keys in Linear)

### Airtable — 7 tools

| Tool | What it does |
|------|-------------|
| `airtable_list_bases` | List all accessible Airtable bases with IDs and permission levels |
| `airtable_list_tables` | List tables in a base with fields and views |
| `airtable_list_records` | List records with optional view, filter formula, sort, and limit |
| `airtable_get_record` | Get a single record by ID with all field values |
| `airtable_create_record` | Create a new record with specified field values |
| `airtable_update_record` | Partially update a record (untouched fields are preserved) |
| `airtable_search_records` | Case-insensitive text search on a specified field |

**Requires:** `AIRTABLE_API_KEY` (Personal access token from https://airtable.com/create/tokens)

### Composio — 2 tools + 1000s of integrations

| Tool | What it does |
|------|-------------|
| `composio_action` | Execute any action on a connected app (GitHub, Jira, HubSpot, Salesforce, Airtable, Linear, Figma...) |
| `composio_list` | Discover available actions for a specific app |

Connect your apps in the [Composio dashboard](https://composio.dev), then use `composio_list` to discover actions and `composio_action` to execute them.

**Requires:** `COMPOSIO_API_KEY`

### Webhook Receiver — 2 tools

| Tool | What it does |
|------|-------------|
| `webhook_last` | Retrieve the most recent payload for a named webhook |
| `webhook_list` | List all webhooks that have received at least one payload |

**Requires:** `MYMCP_WEBHOOKS` (comma-separated list of webhook names, e.g. `stripe,github`)

Optional per-webhook HMAC-SHA256 validation via `MYMCP_WEBHOOK_SECRET_<NAME>`.

### Skills — dynamic tools

User-defined prompt templates exposed as MCP tools and prompts. Create skills via the dashboard's **Skill Composer** (visual tool-wrapping wizard) or manually. Each skill becomes `skill_<name>` in your MCP client. Always active, no credentials needed.

### Admin — 4 tools

| Tool | What it does |
|------|-------------|
| `mcp_logs` | View recent tool calls, errors, latency |
| `mcp_cache_evict` | Clear internal caches (KV, API response, etc.) |
| `mcp_backup_export` | Export skills and settings as a JSON backup |
| `mcp_backup_import` | Restore skills and settings from a backup |

Always active, no credentials needed.

## Architecture

```
src/
  core/                 ← Framework: types, registry, config, auth, logging, events, metrics
  connectors/
    google/             ← Google Workspace (18 tools)
      manifest.ts       ← Connector definition (single source of truth)
      lib/              ← Gmail, Calendar, Contacts, Drive wrappers
      tools/            ← Individual tool handlers
    vault/              ← Obsidian Vault (14 tools)
    browser/            ← Browser Automation (4 tools)
    slack/              ← Slack (6 tools)
    notion/             ← Notion (5 tools)
    apify/              ← Apify — LinkedIn + actors (8 tools)
    paywall/            ← Paywall readers (2 tools)
    composio/           ← Composio bridge (2 tools → 1000+ integrations)
    github/             ← GitHub Issues (6 tools)
    linear/             ← Linear Issues (6 tools)
    airtable/           ← Airtable Bases (7 tools)
    webhook/            ← Webhook Receiver (2 tools)
    skills/             ← Skills — dynamic user-defined tools
    admin/              ← Admin & Observability (4 tools)

app/
  api/mcp               ← MCP endpoint (~30 lines — reads from registry)
  api/health            ← Public liveness + deep health checks
  api/admin/*           ← Private: status, stats, verify, call, health-history (auth-gated)
  api/webhook/*         ← Inbound webhook receiver
  api/auth/google       ← OAuth consent flow
  /                     ← Private status dashboard (redirects to /config)
  /welcome              ← Guided onboarding with progress bar
  /config               ← Unified dashboard (connectors, tools, skills, logs, docs, settings)
```

### How it works

1. Each connector has a `manifest.ts` declaring its tools and required env vars
2. The **registry** checks env vars → determines which connectors are active
3. `route.ts` iterates enabled connectors, registers tools via the MCP SDK
4. **Everything derives from manifests** — dashboard, health, admin API, playground all read from the same source

### Design principles

- **Env vars only** — no config files to maintain, `git pull` never conflicts
- **Single source of truth** — connector manifests drive MCP registration, dashboard, health, docs
- **Framework vs instance** — framework code has zero personal references; all customization is via env vars
- **Contract-level compatibility** — same tool names, same schemas, same behavior across versions

## Configuration

All configuration is via environment variables. See [`.env.example`](.env.example) for the full list.

### Auth

| Variable | Required | Description |
|----------|----------|-------------|
| `MCP_AUTH_TOKEN` | Yes | Bearer token(s) for MCP endpoint — supports comma-separated list |
| `ADMIN_AUTH_TOKEN` | No | Separate token for dashboard (falls back to MCP_AUTH_TOKEN) |

#### Multi-token authentication

`MCP_AUTH_TOKEN` accepts a comma-separated list of tokens, one per MCP client:

```env
MCP_AUTH_TOKEN=token-for-claude-desktop,token-for-chatgpt,token-for-cursor
```

Each token must be at least 16 characters. An 8-character SHA-256 hash prefix of the matched token is stored with every log entry so you can identify which client made each call — without logging the token itself. `ADMIN_AUTH_TOKEN` remains single-token.

### Instance Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `MYMCP_TIMEZONE` | `UTC` | Timezone for date formatting |
| `MYMCP_LOCALE` | `en-US` | Locale for date/number formatting |
| `MYMCP_DISPLAY_NAME` | `User` | Display name in dashboard |
| `MYMCP_CONTEXT_PATH` | `System/context.md` | Path to context file in vault |
| `GITHUB_BRANCH` | `main` | Default branch for vault repo |
| `MYMCP_TOOL_TIMEOUT` | `30000` | Tool timeout in ms |
| `MYMCP_ERROR_WEBHOOK_URL` | — | Webhook for error alerts (Slack-compatible) |

### Connector Control

Connectors activate automatically when their credentials are present. Override with:

```bash
MYMCP_DISABLE_GOOGLE=true          # Force-disable even with credentials
MYMCP_ENABLED_PACKS=vault,admin    # Only listed connectors are considered
```

## What's New

### v0.7

- **Webhook connector** — receive and query external webhook payloads (Stripe, GitHub, etc.) via MCP tools
- **Multi-tenant auth** — per-tenant `MCP_AUTH_TOKEN_<TENANTID>` with `x-mymcp-tenant` header routing
- **Per-tool toggle** — disable individual tools from the dashboard without removing connectors
- **Skill Composer** — visual wizard to create skills by wrapping existing tools (pick tool, configure args, preview, save)
- **Backup/restore** — export and import skills + settings as JSON via `mcp_backup_export` / `mcp_backup_import`
- **Deep health checks** — `GET /api/health?deep=1` runs connector `diagnose()`, with history tracked over time
- **Health dashboard** — connector SLA sparklines, instance health widget, version display in Overview tab
- **Durable observability** — opt-in persistent tool logs via KV store, with configurable retention and rotation
- **Per-token rate limiting** — configurable RPM cap per auth token
- **Event bus** — internal pub/sub for cache invalidation and connector state changes
- **KV cache layer** — shared key-value store (filesystem locally, Upstash on Vercel)
- **GitHub Issues connector** — 6 tools for listing, creating, updating, commenting, and searching issues
- **Linear connector** — 6 tools for issue management with name resolution
- **Airtable connector** — 7 tools for bases, tables, records, and search

## Dashboard & Tools

| Page | Auth | Description |
|------|------|-------------|
| `/` | Admin | Redirects to `/config` |
| `/welcome` | Public* | Guided onboarding — first-run token minting, OAuth, credential checks |
| `/config` | Admin | Unified dashboard — connectors, tools, skills, logs, docs, settings |

\* `/welcome` is only accessible during first-run mode before a token is minted.

## API Endpoints

| Endpoint | Auth | Description |
|----------|------|-------------|
| `POST /api/mcp` | MCP_AUTH_TOKEN | MCP Streamable HTTP |
| `GET /api/health` | Public | `{ ok, version }` — add `?deep=1` for connector diagnostics |
| `GET /api/admin/status` | Admin | Connector diagnostics + diagnose() results |
| `GET /api/admin/stats` | Admin | Tool usage analytics (ephemeral) |
| `GET /api/admin/verify` | Admin | Live credential verification |
| `POST /api/admin/call` | Admin | Invoke any tool (playground API) |
| `GET /api/admin/health-history` | Admin | Historical deep health check results |
| `POST /api/webhook/:name` | Webhook secret | Inbound webhook receiver |
| `GET /api/auth/google` | Admin | Google OAuth redirect |
| `GET /api/cron/health` | Cron | Scheduled health check + webhook alert |

## Security

| Layer | Protection |
|-------|-----------|
| **Auth** | Timing-safe token comparison (MCP + Admin), multi-tenant support |
| **SSRF** | Browser tools block localhost, private IPs (v4+v6), cloud metadata |
| **Errors** | API keys stripped from error messages |
| **Rate limiting** | Per-token RPM cap (configurable), LinkedIn feed: 3 calls/day |
| **OAuth** | State parameter validation, PKCE, HttpOnly cookies |
| **Dashboard** | Private by default — all admin routes require auth |
| **Webhooks** | HMAC-SHA256 signature validation (opt-in per webhook) |
| **CI** | ESLint (no-any enforced), Prettier, Vitest, contract tests, build checks |

## Development

```bash
npm run dev             # Start dev server
npm run build           # Production build
npm run lint            # ESLint
npm run format          # Prettier
npm run test:contract   # Verify tool contracts
npm run test:e2e        # E2E smoke test (starts server, checks tools/list)
```

Pre-commit hook (via Husky): `lint-staged` + `contract test`

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to add tools, connectors, and custom extensions.

**Quick version:** Create a file in `src/connectors/<connector>/tools/`, add it to the connector's `manifest.ts`. Done.

## Tech Stack

Next.js 16 · TypeScript 6 · Zod 4 · MCP SDK · Vercel Serverless · Arctic (OAuth) · Stagehand + Browserbase · Apify SDK

## License

[MIT](LICENSE)
