<p align="center">
  <h1 align="center">Kebab House</h1>
  <p align="center"><strong>Create your personal AI brain with all the ingredients, and eat it everywhere.</strong></p>
</p>

<p align="center">
  <a href="https://kebab-mcp.vercel.app/deploy"><strong>🚀 Deploy Kebab House</strong></a>
  &middot;
  <a href="https://kebab-mcp.vercel.app"><strong>Website →</strong></a>
</p>

<p align="center">
  Your skills, profile and memory in every AI client.<br />
  For people who use more than one AI client — say Claude, Cursor and ChatGPT.<br />
  You need a GitHub account and a free Vercel account: about 10 minutes, no code. Free and open source.
</p>

<p align="center">
  <strong>Set it up from Claude:</strong> deploy, connect Claude, then say “Set up my Kebab House”. Claude does the rest with you.<br />
  <a href="docs/CONNECT-CLAUDE.md">Step-by-step guide →</a>
</p>

<p align="center">
  <img src="https://img.shields.io/github/license/Yassinello/kebab-mcp" alt="License: AGPL-3.0" />
  <img src="https://img.shields.io/github/v/release/Yassinello/kebab-mcp?label=version" alt="Version" />
  <a href="https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FYassinello%2Fkebab-mcp&project-name=kebab-house&repository-name=kebab-house&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22upstash%22%2C%22productSlug%22%3A%22upstash-kv%22%7D%5D"><img src="https://img.shields.io/badge/deploy-vercel-%23000?logo=vercel" alt="Deploy on Vercel" /></a>
  <img src="https://img.shields.io/github/stars/Yassinello/kebab-mcp?style=social" alt="GitHub stars" />
</p>

<p align="center">
  <strong>Works with:</strong>&nbsp;
  <img src="https://img.shields.io/badge/Claude-full-blue?logo=anthropic" alt="Claude: full support" />
  <img src="https://img.shields.io/badge/Claude_Code-full-blue?logo=anthropic" alt="Claude Code: full support" />
  <img src="https://img.shields.io/badge/Cursor-full-blue?logo=cursor" alt="Cursor: full support" />
  <img src="https://img.shields.io/badge/Codex-full-blue?logo=openai" alt="Codex: full support" />
  <img src="https://img.shields.io/badge/ChatGPT-partial-lightgrey?logo=openai" alt="ChatGPT: partial support" />
</p>

<p align="center">
  <a href="#in-30-seconds">In 30 seconds</a> &middot;
  <a href="#which-ai-clients">Clients</a> &middot;
  <a href="#whats-in-the-house">What's inside</a> &middot;
  <a href="#quick-start">Quick Start</a> &middot;
  <a href="#configuration">Configuration</a> &middot;
  <a href="#community--roadmap">Community</a> &middot;
  <a href="docs/CONTRIBUTING.md">Contributing</a>
</p>

---

## In 30 seconds

```
   ┌────────────────────────────────────────────────────────────────────┐
   │                The AI clients you already use                      │
   │      Claude  ·  Claude Code  ·  Cursor  ·  Codex  ·  ChatGPT       │
   └─────────────────────────────┬──────────────────────────────────────┘
                                 │  one MCP endpoint: sign-in or a device token
                                 ▼
   ┌────────────────────────────────────────────────────────────────────┐
   │               Kebab House  (your Vercel deploy)                    │
   │                                                                    │
   │   Skills library  ·  personal profile  ·  memory vault  ·  tools   │
   │                                                                    │
   │   Dashboard at /config: edit your profile, skills and notes,       │
   │   connect clients, choose what each may do, see what they did.     │
   └─────────────────────────────┬──────────────────────────────────────┘
                                 │  your tokens, never ours
                                 ▼
   ┌────────────────────────────────────────────────────────────────────┐
   │   GitHub vault (Obsidian) · LinkedIn · WhatsApp · Browser          │
   │   Paywalled articles · Apify · webhooks · any HTTP API · …         │
   └────────────────────────────────────────────────────────────────────┘
```

**What it is.** A self-hosted hub that equips the AI clients you already use. You keep one library of skills, one profile of who you are and one memory vault, and every client you connect gets the same ingredients over MCP. Deploys to the Vercel free tier. Open source, AGPL-3.0.

**What it isn't.** Not an autonomous agent: Kebab House never acts on its own, schedules work or starts a conversation. Claude, Cursor, Codex or ChatGPT does the thinking; Kebab House serves them your skills, your context and your tools when they ask. Not a hosted product either: it runs on your own Vercel account (or Docker), with your keys.

**Why it exists.** Skills are siloed per client. A skill you write in Claude doesn't exist in Cursor or Codex, and there is no API to sync them. Kebab House is the one place you keep them, and every client reads from it.

**Who it's for.** People who use two or more AI clients and want them to share the same skills and context. If you use a single AI client and its native skills and memory are enough, you don't need this.

**What you need.** A GitHub account and a free Vercel account; about 10 minutes, no code. The one-click deploy also creates a free Upstash database. It runs on your Vercel and Upstash free plans.

---

<p align="center">
  <img src="public/screenshots/dashboard.png" alt="Kebab House dashboard" width="720" />
</p>
<p align="center"><em>The dashboard — overview, profile, skills, memory, connectors, devices, logs.</em></p>

## Which AI clients?

An honest matrix. **Full** means the client connects to your endpoint and can use everything: skills, profile, notes and write actions. Claude, ChatGPT, Cursor and Claude Code **sign in** (OAuth): you paste the URL, approve on your instance and choose the client's access level. Other clients use a **device token** (*Devices → Add device*).

| Client                       | Support    | How it connects                                                      | How it gets your skills                                      |
| ---------------------------- | ---------- | -------------------------------------------------------------------- | ------------------------------------------------------------ |
| **Claude** (web and desktop) | Full       | *Settings → Connectors → Add custom connector*, URL only, then sign in | On demand over MCP, plus an optional *relay skill* upload    |
| **Claude Code**              | Full       | `claude mcp add --transport http …`, sign in on first use            | On demand over MCP, or a native copy into `~/.claude/skills` |
| **Cursor**                   | Full       | `~/.cursor/mcp.json` with the URL, sign in                           | On demand over MCP                                           |
| **Codex**                    | Full       | `~/.codex/config.toml` with a device token                           | On demand over MCP, or a native copy into `~/.codex/skills`  |
| **ChatGPT**                  | Partial    | Custom MCP connector, ChatGPT on the web only, sign in               | On demand over MCP, plus an optional *relay skill* upload    |
| Windsurf, VS Code, n8n, …    | Compatible | Any client that speaks MCP Streamable HTTP: sign-in or device token (not tested on every release) | On demand over MCP |

**Why ChatGPT is partial.** Custom MCP connectors only work in ChatGPT on the web, not in the desktop or mobile apps, and write actions through a custom connector are limited to Business and Enterprise plans. On other plans, expect read-only use (list and load skills, read your profile and vault).

**A note on claude.ai and Claude Desktop.** They don't pass MCP server instructions to the model, so the model reaches for your skills only when the conversation obviously calls for one. Uploading a skill's *relay .zip* once (Claude → *Skills → Upload*) makes it trigger natively; it always loads the live version from your Kebab House.

## What's in the house

Skills come first. The profile, the vault and the tools are the ingredients that make them useful.

### ⚡ Skills: one library for every client

**Skills** use the open Agent Skills format (`SKILL.md` + bundled files), the same format Claude, ChatGPT, Codex and Claude Code use. Kebab House serves one library to every connected client:

- **On demand over MCP**: `skills_list`, `skill_load` and `skill_read_file`, in every client. Skills also show up as MCP prompts (slash commands in Claude Desktop and Claude Code).
- **Relay skill** for claude.ai and ChatGPT: upload a small zip once; it triggers natively and fetches the live skill, so you never re-upload after an edit.
- **Native copy** for Claude Code and Codex: a one-liner from the dashboard pulls the whole library into `~/.claude/skills` or `~/.codex/skills`.
- **Scoped per token (one "hat" per client)**: tag skills (`perso`, `work`, …) and choose which tags each client token sees. Your work laptop gets your work skills; your personal Claude gets the rest.
- Import and export zips (from Claude, ChatGPT or a Git repo), versioning with one-click rollback, and a composer that turns any tool into a skill.

Details: [content/docs/skills.md](content/docs/skills.md).

### 🧑 Personal profile

`my_context` gives every client the same "about me": who you are, your projects, your preferences. It works on every instance, with or without a vault:

- **Stored in the dashboard** (Settings → Profile), or as a Markdown file in your vault if you prefer.
- **One profile per hat**: create `perso`, `work`… and bind each client token to one in Devices. Your work laptop gets your work profile.
- **Updated on request**: `my_context_update` lets a client add to your profile when you ask it to remember something about you.

### 🗄️ Memory vault

Long-term memory that every client can read and write: search, read, write, append, move, backlinks, and `save_article` to clip a web page into your notes. It works from the first deploy, with nothing to set up: notes are stored in your instance's KV (Upstash, or the local file in Docker). Prefer Obsidian? Point it at a GitHub repo (`GITHUB_PAT` + `GITHUB_REPO`) and every note is plain Markdown in a Git repo you own; a dashboard button imports a GitHub vault into the KV.

### 🧰 Long-tail tools

The things native connectors don't cover, or cover in only one client: **LinkedIn and WhatsApp** (read and send through Unipile, LinkedIn reads through Apify), **browser automation** (Browserbase + Stagehand) and paywalled-article reading. Also available: Google Workspace, Slack, Notion, GitHub Issues, Linear, Airtable, Composio (1000+ apps via the bridge) and inbound webhooks — but when your AI client has its own connector for one of these, use that. Each connector turns on when its credentials are present.

**Bring your own sauce:** *API Connections* turns any HTTP API into an MCP tool (a URL, a method and a schema, no code), and *Custom Tools* compose existing tools into new ones.

### 📊 Dashboard

`/config` is the hub's home: **Overview, Profile, Skills, Memory, Connectors, Devices, Logs**. Under *Advanced*: Tools (per-tool toggles), Playground, Health, Storage, Documentation and Settings (including export / import and one-click updates). The welcome wizard mints your admin key on first run.

### 🔒 Security and ownership

**Guardrails.** Content from outside (web pages, e-mails, messages, scraped data) reaches the model labelled as data, not instructions. Messages sent through Kebab House (e-mail via Gmail, Slack, Google Chat, LinkedIn, WhatsApp) wait for your approval on a signed page outside the chat. A client that signs in picks an access level: read only, read + my profile and notes, or everything. Every tool call is counted per client each week, and recent calls are kept with duration and status. Details: [docs/SECURITY.md](docs/SECURITY.md).

Self-hosted by design: your credentials live in your own Upstash KV, with no telemetry and no server of ours in the loop. Timing-safe token comparison, multi-tenant auth, per-token rate limits, SSRF protection on browser tools, HMAC validation on webhooks, env-only configuration (no config files, `git pull` never conflicts), HttpOnly OAuth cookies with PKCE.

<details>
<summary><strong>Full connector matrix — tool count, auth, setup time</strong></summary>

| Connector                         | Tools             | Auth                                | Setup |
| --------------------------------- | ----------------- | ----------------------------------- | ----- |
| **Skills**                        | 3 (+ dyn.)        | —                                   | 0 min |
| **Memory Vault**                  | 13                | — (GitHub PAT optional)             | 0 min |
| **Unipile (LinkedIn + WhatsApp)** | 23                | DSN + token                         | 3 min |
| **Apify (LinkedIn)**              | 10                | API token                           | 1 min |
| **Browser Automation**            | 7                 | Browserbase + OpenRouter            | 3 min |
| **Paywall Readers**               | 1 (+1 w/ Browser) | —                                   | 0 min |
| **Google Workspace**              | 21                | OAuth                               | 5 min |
| **Slack**                         | 7                 | Bot token                           | 2 min |
| **Notion**                        | 6                 | Integration token                   | 2 min |
| **GitHub Issues**                 | 6                 | PAT                                 | 1 min |
| **Linear**                        | 6                 | API key                             | 1 min |
| **Airtable**                      | 7                 | PAT                                 | 1 min |
| **Composio**                      | 2                 | API key (1000+ apps via the bridge) | 2 min |
| **Webhook Receiver**              | 3                 | Optional HMAC                       | 0 min |
| **API Connections**               | dyn.              | per-API                             | 1 min |
| **Custom Tools**                  | dyn.              | —                                   | 1 min |
| **Admin & Logs**                  | 5                 | Admin token                         | 0 min |

Per-tool details and env vars: [docs/CONNECTORS.md](docs/CONNECTORS.md).

</details>

## Use cases

A few prompts to give you the shape of it:

- **Same ritual, any client** — *"Run my meeting-prep skill for my 3pm."* In Claude on your phone or in Cursor at your desk: same skill, same profile, same notes.
- **Remember this** — *"Save this article to my vault and add it to my read-later list."*
- **Long-tail reach** — *"Find Sam's last WhatsApp message and draft a reply to his LinkedIn post, but don't send anything."*

## Quick Start

Two paths cover ~95% of users — the Vercel Deploy Button for the recommended path, Docker for full control. The CLI installer is tucked under the "more" toggle.

### Option A — Deploy on Vercel (recommended)

**[Deploy with Vercel](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FYassinello%2Fkebab-mcp&project-name=kebab-house&repository-name=kebab-house&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22upstash%22%2C%22productSlug%22%3A%22upstash-kv%22%7D%5D)** — one click creates a copy of the repo in your GitHub account, a Vercel project and a free Upstash Redis database, then deploys. Open the deployed URL → `/welcome` mints your `MCP_AUTH_TOKEN` and connects your AI client. The deploy hub at **[/deploy](https://kebab-mcp.vercel.app/deploy)** shows what gets created.

The copy is not a GitHub fork, so it **can stay private** (your secrets live in Vercel and Upstash either way, never in the repo).

Updates: the dashboard tells you when a new release is out, with no setup. To install it in one click, add a GitHub token with *Contents: read & write* on your new repo as `KEBAB_UPDATE_PAT` (Settings → Advanced), then click *Update now*. The dashboard uses **release sync**: it copies the latest release's files into your repo as one commit, and stops without writing if you edited one of them.

**For contributors — Fork + Import** (a real GitHub fork, *Sync fork* works; **a fork of a public repo is always public**, so use it to send pull requests, not for a personal instance): **[Fork on GitHub](https://github.com/Yassinello/kebab-mcp/fork)** → **[Import to Vercel](https://vercel.com/new)** → in the project, *Storage* → *Connect Database* → *Upstash for Redis* (Free) → open `/welcome`. Without Upstash, your auth token and credentials don't survive serverless cold starts.

<details>
<summary><strong>Vercel deploy — troubleshooting FAQ</strong></summary>

**"I see 'Admin auth not configured' after deploy"** — You're on a cold lambda that hasn't rehydrated `MCP_AUTH_TOKEN` from Upstash. Confirm the KV integration is attached (or paste the token into the project's env vars) and reload. See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) (BUG-07, BUG-10, BUG-11).

**"Which Upstash env vars should I set?"** — Either `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` (manual setup) or `KV_REST_API_URL` + `KV_REST_API_TOKEN` (Vercel Marketplace integration, auto-injected). If both, `UPSTASH_REDIS_REST_*` wins.

**"What does `MYMCP_RECOVERY_RESET=1` do?"** — Wipes persisted bootstrap state and forces a fresh welcome. **Do NOT set it permanently** — every cold lambda wipes state, so any token minted while the var is set vanishes. See [BUG-05](docs/TROUBLESHOOTING.md#bug-05--mymcp_recovery_reset1-silently-wiped-tokens-on-every-cold-lambda).

**"Welcome flow loops me back to `/welcome`"** — Usually KV not configured + `MYMCP_ALLOW_EPHEMERAL_SECRET=1` unset, cold-lambda rehydrate failing silently, or `INSTANCE_MODE=showcase` accidentally set. Full index: [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

</details>

### Option B — Self-hosted (Docker or local dev)

```bash
git clone https://github.com/Yassinello/kebab-mcp.git
cd kebab-mcp
cp .env.example .env    # Fill MCP_AUTH_TOKEN and ADMIN_AUTH_TOKEN at minimum
                        # (generate each with: openssl rand -hex 32)

# Docker
docker compose up

# Or local dev
npm install && npm run dev
```

Docker runs in production mode, where the dashboard refuses the MCP token: set `ADMIN_AUTH_TOKEN` to a second value (your admin key), or set `KEBAB_ADMIN_TOKEN_FALLBACK=1` to reuse `MCP_AUTH_TOKEN` for the dashboard. Without either, `/config` answers "Admin auth misconfigured".

Dashboard at `http://localhost:3000/config?token=<your-admin-key>`, MCP endpoint at `http://localhost:3000/api/mcp`.

See [`.env.example`](.env.example) for every env var. Connectors auto-activate when their credentials are present — no toggling needed.

<details>
<summary><strong>Option C — npx installer (interactive CLI)</strong></summary>

```bash
npx @yassinello/create-kebab-mcp@latest
```

Five-step CLI: project setup → clone → pick connectors → paste credentials → install & deploy. Leaves you with a working `.env`, installed deps, and an `upstream` remote for future `npm run update`.

You can also ask Claude in a Claude Code conversation: *"Run `npx @yassinello/create-kebab-mcp@latest` and help me set up Kebab House."* Claude can then wire the resulting endpoint into your client config.

</details>

### Connect your AI client

**Claude first.** The last welcome step (and the dashboard Overview, until a client connects) has a **Connect Claude** button: add the connector, approve it, then say “Set up my Kebab House”. Walkthrough: [docs/CONNECT-CLAUDE.md](docs/CONNECT-CLAUDE.md).

**Sign-in first.** Claude, ChatGPT, Cursor and Claude Code connect with OAuth: give them the URL only (`https://your-app.vercel.app/api/mcp`). They open your instance's consent page, where you sign in with your admin key and choose the access level: *read only*, *read + my profile and notes* (recommended) or *everything*. The client then appears in *Devices*, where you can bind a profile or revoke it.

**Device token for the others.** Codex, Windsurf, n8n and any client without sign-in get their own token: *Devices → Add device*. Never paste your admin key into an AI client: it opens your dashboard. Details: [docs/CLIENTS.md](docs/CLIENTS.md).

The dashboard (the last welcome step and *Devices*) generates these snippets with your URL filled in.

<details>
<summary><strong>Claude, Claude Code, Cursor, Codex, ChatGPT, Windsurf — config snippets</strong></summary>

**Claude (claude.ai and Claude Desktop)** — *Settings → Connectors → Add custom connector*. Name it `Kebab House` and paste `https://your-app.vercel.app/api/mcp` as the remote MCP server URL. Leave the advanced OAuth Client ID and Secret empty: Claude registers itself and opens your sign-in page.

**Claude Code** — `claude mcp add --transport http kebab-house https://your-app.vercel.app/api/mcp`. Claude Code opens the sign-in page the first time it connects (or run `/mcp` to authenticate).

**Cursor** — `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per-project), or the dashboard's *Add to Cursor* button. Cursor opens the sign-in page:

```json
{
  "mcpServers": {
    "kebab": { "url": "https://your-app.vercel.app/api/mcp" }
  }
}
```

**ChatGPT (web)** — add a custom MCP connector (developer mode) with `https://your-app.vercel.app/api/mcp` and OAuth authentication. See [Which AI clients?](#which-ai-clients) for the plan limits.

**Codex** — create a device token (*Devices → Add device*), put it in an environment variable, then in `~/.codex/config.toml`:

```toml
[mcp_servers.kebab]
url = "https://your-app.vercel.app/api/mcp"
bearer_token_env_var = "KEBAB_TOKEN"
```

**Fallback: a device token instead of sign-in** — for a client that cannot sign in (or a Claude Desktop config file), use a device token from *Devices → Add device*:

```json
{
  "mcpServers": {
    "kebab": {
      "url": "https://your-app.vercel.app/api/mcp",
      "headers": { "Authorization": "Bearer YOUR_DEVICE_TOKEN" }
    }
  }
}
```

**Windsurf** — `~/.codeium/windsurf/mcp_config.json`: same shape as the fallback above, but the URL field is named `serverUrl`.

**Other MCP clients** — POST to `https://your-app.vercel.app/api/mcp` with `Authorization: Bearer YOUR_DEVICE_TOKEN`, or use `?token=YOUR_DEVICE_TOKEN` in the URL when the client can't set headers.

</details>

## Configuration

All configuration is via environment variables. Full reference: [`.env.example`](.env.example).

### Auth

| Variable           | Required | Description                                                      |
| ------------------ | -------- | ---------------------------------------------------------------- |
| `MCP_AUTH_TOKEN`   | Yes      | Bearer token(s) for MCP endpoint — supports comma-separated list |
| `ADMIN_AUTH_TOKEN` | Yes in production (Docker) when `MCP_AUTH_TOKEN` is set | Your admin key: opens the dashboard. Falls back to `MCP_AUTH_TOKEN` only with `KEBAB_ADMIN_TOKEN_FALLBACK=1` |

`MCP_AUTH_TOKEN` accepts a comma-separated list of tokens, one per MCP client. Each token must be ≥ 16 characters. An 8-character SHA-256 hash prefix is stored with every log entry so you can identify which client made each call — without logging the token itself.

### Instance settings

v0.12 renamed the env-var prefix from `MYMCP_*` to `KEBAB_*`. Both are accepted during the 2-release transition; the operator sees one boot-time deprecation warning per legacy variable. See [CHANGELOG § v0.12 migration guide](docs/CHANGELOG.md). The Kebab House name doesn't change any variable, KV key or repository name.

| Variable                  | Legacy                    | Default             | Description                       |
| ------------------------- | ------------------------- | ------------------- | --------------------------------- |
| `KEBAB_TIMEZONE`          | `MYMCP_TIMEZONE`          | `UTC`               | Timezone for date formatting      |
| `KEBAB_LOCALE`            | `MYMCP_LOCALE`            | `en-US`             | Locale for date/number formatting |
| `KEBAB_DISPLAY_NAME`      | `MYMCP_DISPLAY_NAME`      | `User`              | Display name in dashboard         |
| `KEBAB_CONTEXT_PATH`      | `MYMCP_CONTEXT_PATH`      | `System/context.md` | Path to context file in vault     |
| `KEBAB_VAULT_BACKEND`     | `MYMCP_VAULT_BACKEND`     | auto                | Vault storage: `kv` or `github`   |
| `KEBAB_TOOL_TIMEOUT`      | `MYMCP_TOOL_TIMEOUT`      | `30000`             | Tool timeout in ms                |
| `KEBAB_ERROR_WEBHOOK_URL` | `MYMCP_ERROR_WEBHOOK_URL` | —                   | Webhook for error alerts          |

### Connector control

Connectors activate automatically when their credentials are present. Override with:

```bash
KEBAB_DISABLE_GOOGLE=true          # Force-disable even with credentials
KEBAB_ENABLED_PACKS=vault,admin    # Only listed connectors are considered
```

## Architecture

```
src/
  core/                ← Framework: types, registry, config, auth, logging, events
  connectors/
    google/            ← Google Workspace (21+ tools)
      manifest.ts      ← Connector definition (single source of truth)
      lib/             ← Gmail, Calendar, Contacts, Drive, Chat wrappers
      tools/           ← Individual tool handlers
    vault/             ← Memory Vault (13 tools; KV or GitHub backend)
    skills/            ← Skills library (skills_list, skill_load, skill_read_file)
    browser/ slack/ notion/ apify/ unipile/ paywall/ composio/
    github/ linear/ airtable/ webhook/ admin/

app/
  api/mcp              ← MCP endpoint (reads from the registry)
  api/health           ← Public liveness + deep health checks
  api/admin/*          ← Private: status, stats, verify, call (auth-gated)
  api/webhook/*        ← Inbound webhook receiver
  /welcome             ← Guided onboarding
  /config              ← Unified dashboard
```

**How it works:** each connector has a `manifest.ts` declaring its tools and required env vars. The **registry** checks env vars and determines which connectors are active. `route.ts` iterates enabled connectors and registers tools via the MCP SDK. Everything — dashboard, health, admin API — derives from the same manifests.

**Design principles:** env vars only (no config files, `git pull` never conflicts) · single source of truth (manifests drive registration, dashboard, docs) · framework vs instance separation (zero personal references in code) · contract-level compatibility (same tool names and schemas across versions).

## Development

```bash
npm run dev             # Start dev server
npm run build           # Production build
npm run lint            # ESLint
npm run format          # Prettier
npm run test:contract   # Verify tool contracts
npm run test:e2e        # Playwright welcome-flow E2E
```

Pre-commit hook (Husky): `lint-staged` + contract test. Tooling configs (`size-limit.json`, `knip.ts`) live under [`config/`](config).

### API endpoints

| Endpoint                        | Auth           | Description                                                 |
| ------------------------------- | -------------- | ----------------------------------------------------------- |
| `POST /api/mcp`                 | MCP_AUTH_TOKEN | MCP Streamable HTTP                                         |
| `GET /api/health`               | Public         | `{ ok, version }` — add `?deep=1` for connector diagnostics |
| `GET /api/admin/status`         | Admin          | Connector diagnostics + diagnose() results                  |
| `GET /api/admin/stats`          | Admin          | Tool usage analytics                                        |
| `POST /api/admin/call`          | Admin          | Invoke any tool (playground API)                            |
| `POST /api/webhook/:name`       | Webhook secret | Inbound webhook receiver                                    |
| `GET /api/cron/health`          | Cron           | Scheduled health check + webhook alert                      |

Full reference: [docs/API.md](docs/API.md).

### Security

| Layer             | Protection                                                               |
| ----------------- | ------------------------------------------------------------------------ |
| **Auth**          | Timing-safe token comparison (MCP + Admin), multi-tenant support         |
| **SSRF**          | Browser tools block localhost, private IPs (v4+v6), cloud metadata       |
| **Errors**        | API keys stripped from error messages                                    |
| **Rate limiting** | Per-token RPM cap (configurable), LinkedIn feed: 3 calls/day             |
| **OAuth**         | State parameter validation, PKCE, HttpOnly cookies                       |
| **Dashboard**     | Private by default — all admin routes require auth                       |
| **Webhooks**      | HMAC-SHA256 signature validation (opt-in per webhook)                    |
| **CI**            | ESLint (no-any enforced), Prettier, Vitest, contract tests, build checks |

## Updates & durability

Kebab House (repository `kebab-mcp`) is a [template repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-template-repository). Your copy is standalone — it won't auto-update. The right path depends on **where you run it**:

| Where you run it          | How updates work                                                       |
| ------------------------- | ---------------------------------------------------------------------- |
| **Vercel** (most users)   | One-click sync from the dashboard via GitHub's API — no terminal needed |
| **Local dev**             | Auto-pull on every dev server start (silent, fast-forward only)         |
| **Docker / self-hosted**  | `npm run update` (or `git fetch upstream && git merge upstream/main`)   |

The Vercel dashboard runs a daily cron at 8h UTC that pre-fetches upstream status, so the Overview banner loads instantly. **Your `.env`, `data/`, and saved credentials in Upstash KV are never touched** — all customization lives in env vars.

Disable the in-dashboard update feature with `KEBAB_DISABLE_UPDATE_API=1`. Smoke-test recipe: [docs/TROUBLESHOOTING.md § Phase 61 update flow](docs/TROUBLESHOOTING.md#phase-61-update-flow-smoke-test).

## Community & Roadmap

Kebab House is an open-source side project: a showcase you deploy and own, not a hosted product. See [ADR 0004](docs/adr/0004-kebab-house-showcase.md) for the positioning.

- **GitHub Discussions** — questions, ideas, feedback: [github.com/Yassinello/kebab-mcp/discussions](https://github.com/Yassinello/kebab-mcp/discussions)
- **GitHub Issues** — bugs and feature requests: [github.com/Yassinello/kebab-mcp/issues](https://github.com/Yassinello/kebab-mcp/issues)

**Roadmap (subject to change):**

- [x] Phase 0 — the hub every day: a vault-free profile and one profile per hat, ritual skill templates, a single relay skill for claude.ai and ChatGPT, weekly usage counters ([spec](docs/specs/kebab-house-phase-0.md))
- [ ] Phase 1 — trust: OAuth and conversational onboarding
- [ ] Phase 2 — easier install and a memory vault without GitHub
- [ ] Phase 3 — MCP Apps and a weekly recap

Shipped releases: [docs/CHANGELOG.md](docs/CHANGELOG.md).

## Contributing

See [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) for how to add tools, connectors, and custom extensions. **Quick version:** create a file in `src/connectors/<connector>/tools/`, add it to the connector's `manifest.ts`. Done.

## Documentation

Ordered by reader journey — discover, deploy, use, author, contribute.

- [docs/CONNECT-CLAUDE.md](docs/CONNECT-CLAUDE.md) — set it up from Claude: connect Claude, say one sentence, confirm changes in your browser
- [content/docs/skills.md](content/docs/skills.md) — the skills library: channels per client, tags, import and export
- [docs/API.md](docs/API.md) — route-by-route API reference (all 42 endpoints)
- [docs/CONNECTORS.md](docs/CONNECTORS.md) — per-connector setup and env var reference
- [docs/CONNECTOR-AUTHORING.md](docs/CONNECTOR-AUTHORING.md) — zero-to-live authoring walkthrough
- [docs/HOSTING.md](docs/HOSTING.md) — host compatibility matrix (Vercel, Docker, Fly, Render, Cloud Run, bare-metal) + degraded-mode contract
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — symptom → fix index for every shipped bug + security finding
- [docs/SECURITY-ADVISORIES.md](docs/SECURITY-ADVISORIES.md) — published advisory index
- [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) — contribution guide + coverage philosophy
- [docs/CHANGELOG.md](docs/CHANGELOG.md) — version history
- [docs/SECURITY.md](docs/SECURITY.md) — vulnerability reporting
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — developer / fork-maintainer guide (durable bootstrap pattern, conventions, env-var reference)

## Tech Stack

Next.js 16 · TypeScript 6 · Zod 4 · MCP SDK · Vercel Serverless · Arctic (OAuth) · Stagehand + Browserbase · Apify SDK

## License

[AGPL-3.0-only](LICENSE)
