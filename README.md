<p align="center">
  <h1 align="center">Kebab MCP</h1>
  <p align="center"><strong>Your personal AI backend. One endpoint. 86+ tools. Deploy in 5 minutes.</strong></p>
</p>

<p align="center">
  <a href="https://kebab-mcp.vercel.app/deploy"><strong>🚀 Deploy your Kebab</strong></a>
  &middot;
  <a href="https://mymcp-home.vercel.app"><strong>Live demo →</strong></a>
</p>

<p align="center">
  <img src="https://img.shields.io/github/license/Yassinello/kebab-mcp" alt="License: AGPL-3.0" />
  <img src="https://img.shields.io/github/v/release/Yassinello/kebab-mcp?label=version" alt="Version" />
  <img src="https://img.shields.io/github/stars/Yassinello/kebab-mcp?style=social" alt="GitHub stars" />
</p>

<p align="center">
  <a href="#in-30-seconds">In 30 seconds</a> &middot;
  <a href="#who-is-this-for">Who it's for</a> &middot;
  <a href="#quick-start">Quick Start</a> &middot;
  <a href="#features">Features</a> &middot;
  <a href="#use-cases">Use Cases</a> &middot;
  <a href="#configuration">Configuration</a> &middot;
  <a href="#community--roadmap">Community</a> &middot;
  <a href="docs/CONTRIBUTING.md">Contributing</a>
</p>

---

## In 30 seconds

```
   ┌────────────────────────────────────────────────────────────────────┐
   │                  Your AI clients (any of them)                     │
   │   Claude Desktop  ·  Cursor  ·  Windsurf  ·  ChatGPT  ·  …         │
   └─────────────────────────────┬──────────────────────────────────────┘
                                 │  one MCP endpoint, one auth token
                                 ▼
   ┌────────────────────────────────────────────────────────────────────┐
   │                Kebab MCP  (your Vercel deploy)                     │
   │                                                                    │
   │   /api/mcp  →  registry  →  86+ tools across 16 connectors         │
   │                                                                    │
   │   Dashboard at /config: enable connectors, write Skills,           │
   │   add custom HTTP API tools, watch live logs.                      │
   └─────────────────────────────┬──────────────────────────────────────┘
                                 │  your tokens, never ours
                                 ▼
   ┌────────────────────────────────────────────────────────────────────┐
   │   Google Workspace · Slack · Notion · Obsidian · GitHub · Linear   │
   │   Airtable · Browser (Browserbase) · Apify · Composio · …          │
   └────────────────────────────────────────────────────────────────────┘
```

**What it is.** A self-hosted MCP server framework that ships with 86+ pre-built tools across 16 connectors. Deploys to Vercel free tier. Open-source, AGPL-3.0.

**Why it exists.** Every AI client wants its own MCP server. Five clients × five tool sources = 25 half-broken integrations. Kebab is one backend that every client talks to.

**What you get:**

- ✅ **One deploy, one endpoint** — every AI client speaks to the same `https://your-fork.vercel.app/api/mcp`
- ✅ **86+ tools, no code** — Gmail, Calendar, Drive, Slack, Notion, Obsidian, GitHub, Linear, Airtable, Apify, Browser, paywalled articles, custom Skills, custom HTTP APIs
- ✅ **Your tokens, your KV** — credentials live in your Upstash; we have no servers, no telemetry, no lock-in
- ✅ **Dashboard included** — enable/disable connectors live, run any tool from the playground, write Skills in markdown, watch logs

**Who it's not for.** If you only need one MCP integration (e.g. just Gmail), grab the official one. Kebab earns its keep at ≥ 3 tool sources or ≥ 2 AI clients.

---

<p align="center">
  <img src="public/screenshots/dashboard.png" alt="Kebab MCP dashboard" width="720" />
</p>
<p align="center"><em>The unified dashboard — connectors, tools, skills, logs, settings.</em></p>

## Who is this for?

- **Solo builders** who use Claude / Cursor / ChatGPT side-by-side and want one tool set everywhere.
- **Small ops teams** that need an internal AI backend wired to Slack / Notion / Linear / Google Workspace without paying per seat.
- **Privacy-minded developers** who'd rather hand their OAuth refresh tokens to their own Vercel project than to a third party.

If you just want a single MCP integration, you don't need this — pick the official one. Kebab earns its keep when you have ≥ 3 tool sources or ≥ 2 AI clients.

## Why Kebab MCP?

|              | Kebab MCP                | Separate MCP servers | Hosted platforms           |
| ------------ | ------------------------ | -------------------- | -------------------------- |
| **Setup**    | Fork + env vars + deploy | 5 repos, 5 configs   | Sign up + monthly fee      |
| **Tools**    | 86+ pre-built            | Build your own       | 1000s (but vendor lock-in) |
| **Endpoint** | 1                        | 5+                   | 1 (their server)           |
| **Cost**     | Free (Vercel free tier)  | Free but complex     | $0–80/month                |
| **Data**     | Your Vercel, your keys   | Your machines        | Their servers              |

## Quick Start

Two paths cover ~95% of users — Fork + Vercel for the recommended path, Docker for full control. The CLI installer is tucked under the "more" toggle.

### Option A — Fork + Deploy on Vercel (recommended)

The deploy hub at **[/deploy](https://kebab-mcp.vercel.app/deploy)** walks through this visually. The flow:

1. **[Fork on GitHub](https://github.com/Yassinello/kebab-mcp/fork)** — keeps your deployment linked to upstream so updates land in one click.
2. **[Import to Vercel](https://vercel.com/new)** — pick your fork from the list, click *Import*, keep all defaults, click *Deploy*.
3. **Attach Upstash KV** — after the first deploy completes, open your project → *Storage* tab → *Connect Database* → *Upstash for Redis* (Free plan). Vercel injects the env vars and auto-redeploys. Without this, your auth token and credentials don't survive serverless cold starts.
4. **Open the deployed URL** → land on `/welcome`, mint your `MCP_AUTH_TOKEN`, paste it into your AI client.

> **Why not the one-click Deploy Button?** Vercel's `/new/clone` creates a standalone snapshot — not a real GitHub fork — so the dashboard's *Update now* flow can never sync upstream changes. We tried it and reverted (case study: [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)). The fork-first flow takes one extra click and stays maintainable forever.

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
cp .env.example .env    # Fill MCP_AUTH_TOKEN at minimum

# Docker
docker compose up

# Or local dev
npm install && npm run dev
```

Dashboard at `http://localhost:3000/config?token=<your-token>`, MCP endpoint at `http://localhost:3000/api/mcp`.

See [`.env.example`](.env.example) for every env var. Connectors auto-activate when their credentials are present — no toggling needed.

<details>
<summary><strong>Option C — npx installer (interactive CLI)</strong></summary>

```bash
npx @yassinello/create-kebab-mcp@latest
```

Five-step CLI: project setup → clone → pick connectors → paste credentials → install & deploy. Leaves you with a working `.env`, installed deps, and an `upstream` remote for future `npm run update`.

You can also ask Claude in a Claude Code conversation: *"Run `npx @yassinello/create-kebab-mcp@latest` and help me set up Kebab MCP."* Claude can then wire the resulting endpoint into your client config.

</details>

### Connect your AI client

<details>
<summary><strong>Claude Desktop, Claude Code, Cursor, Windsurf, ChatGPT — config snippets</strong></summary>

**Claude Desktop** — `~/Library/Application Support/Claude/claude_desktop_config.json` (Mac) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "kebab": {
      "url": "https://your-app.vercel.app/api/mcp",
      "headers": { "Authorization": "Bearer YOUR_MCP_AUTH_TOKEN" }
    }
  }
}
```

**Claude Code** — `~/.claude.json` (global) or `.mcp.json` (per-project):

```json
{
  "mcpServers": {
    "kebab": {
      "type": "http",
      "url": "https://your-app.vercel.app/api/mcp",
      "headers": { "Authorization": "Bearer YOUR_MCP_AUTH_TOKEN" }
    }
  }
}
```

**Cursor** — `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per-project): same shape as Claude Desktop.

**Windsurf** — `~/.codeium/windsurf/mcp_config.json`: same shape, but the URL field is named `serverUrl`.

**ChatGPT / Other MCP clients** — POST to `https://your-app.vercel.app/api/mcp` with `Authorization: Bearer YOUR_MCP_AUTH_TOKEN`.

</details>

## Features

Five families of capability. Each connector auto-activates when its credentials are in your env.

### 🔌 Connectors — 13 built-in integrations

Google Workspace, Obsidian Vault, Slack, Notion, GitHub, Linear, Airtable, Browser Automation, Apify (LinkedIn), Composio (1000+ apps via bridge), Paywall Readers, Webhooks. **86 production-ready tools** total. Setup is one env var per connector.

### 🛠️ Custom Tools — bring any HTTP API

**API Connections** turns any HTTP endpoint into an MCP tool — paste an OpenAPI spec or wire a REST endpoint, define the auth, ship. No code, no PR. Useful for internal APIs, niche SaaS, or quick experiments.

### ⚡ Skills — prompt-powered workflows

**Skills** are user-defined tools built from prompt templates. Compose existing tools in the dashboard's visual wizard, save, and the skill becomes `skill_<name>` in your MCP client. Versioned — every edit is a new revision, with one-click rollback.

### 📊 Dashboard & Ops

Unified `/config` page covers connector status, per-tool toggles, live logs, deep health checks, OAuth flows, Skill composer, API playground, and one-click upstream updates. The Welcome wizard handles first-run token minting and credential collection.

### 🔒 Security & Ownership

Self-hosted by design. Timing-safe token comparison, multi-tenant auth, per-token rate limits, SSRF protection on browser tools, HMAC validation on webhooks, env-only configuration (no config files, `git pull` never conflicts), HttpOnly OAuth cookies with PKCE.

<details>
<summary><strong>Full connector matrix — tool count, auth, setup time</strong></summary>

| Connector              | Tools | Auth                                | Setup |
| ---------------------- | ----- | ----------------------------------- | ----- |
| **Google Workspace**   | 18    | OAuth                               | 5 min |
| **Obsidian Vault**     | 14    | GitHub PAT                          | 2 min |
| **Browser Automation** | 7     | Browserbase + OpenRouter            | 3 min |
| **Slack**              | 6     | Bot token                           | 2 min |
| **Notion**             | 5     | Integration token                   | 2 min |
| **Apify (LinkedIn)**   | 10    | API token                           | 1 min |
| **GitHub Issues**      | 6     | PAT                                 | 1 min |
| **Linear**             | 6     | API key                             | 1 min |
| **Airtable**           | 7     | PAT                                 | 1 min |
| **Composio**           | 2     | API key (1000+ apps via the bridge) | 2 min |
| **Paywall Readers**    | 2     | —                                   | 0 min |
| **Webhook Receiver**   | 3     | Optional HMAC                       | 0 min |
| **Skills**             | dyn.  | —                                   | 0 min |
| **API Connections**    | dyn.  | per-API                             | 1 min |
| **Admin & Logs**       | 5     | Admin token                         | 0 min |

Per-tool details and env vars: [docs/CONNECTORS.md](docs/CONNECTORS.md).

</details>

## Use Cases

A few prompts to give you the shape of what's possible:

- **Daily ops dashboard** — *"Summarize this week's calendar conflicts, group my unread Slack threads by channel, and create a Linear issue for each unresolved thread."*
- **Inbox triage** — *"Find every email from this customer in the last 30 days, summarize the request, and draft a response — but don't send it."*
- **Research → notes** — *"Search LinkedIn for product managers in the seed-stage SaaS space, extract their last 3 posts, and append the digest to my Obsidian daily note."*

## Configuration

All configuration is via environment variables. Full reference: [`.env.example`](.env.example).

### Auth

| Variable           | Required | Description                                                      |
| ------------------ | -------- | ---------------------------------------------------------------- |
| `MCP_AUTH_TOKEN`   | Yes      | Bearer token(s) for MCP endpoint — supports comma-separated list |
| `ADMIN_AUTH_TOKEN` | No       | Separate token for dashboard (falls back to `MCP_AUTH_TOKEN`)    |

`MCP_AUTH_TOKEN` accepts a comma-separated list of tokens, one per MCP client. Each token must be ≥ 16 characters. An 8-character SHA-256 hash prefix is stored with every log entry so you can identify which client made each call — without logging the token itself.

### Instance settings

v0.12 renamed the env-var prefix from `MYMCP_*` to `KEBAB_*`. Both are accepted during the 2-release transition; the operator sees one boot-time deprecation warning per legacy variable. See [CHANGELOG § v0.12 migration guide](docs/CHANGELOG.md).

| Variable                  | Legacy                    | Default             | Description                       |
| ------------------------- | ------------------------- | ------------------- | --------------------------------- |
| `KEBAB_TIMEZONE`          | `MYMCP_TIMEZONE`          | `UTC`               | Timezone for date formatting      |
| `KEBAB_LOCALE`            | `MYMCP_LOCALE`            | `en-US`             | Locale for date/number formatting |
| `KEBAB_DISPLAY_NAME`      | `MYMCP_DISPLAY_NAME`      | `User`              | Display name in dashboard         |
| `KEBAB_CONTEXT_PATH`      | `MYMCP_CONTEXT_PATH`      | `System/context.md` | Path to context file in vault     |
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
    google/            ← Google Workspace (18 tools)
      manifest.ts      ← Connector definition (single source of truth)
      lib/             ← Gmail, Calendar, Contacts, Drive wrappers
      tools/           ← Individual tool handlers
    vault/             ← Obsidian Vault (14 tools)
    browser/ slack/ notion/ apify/ paywall/ composio/
    github/ linear/ airtable/ webhook/ skills/ admin/

app/
  api/mcp              ← MCP endpoint (~30 lines — reads from registry)
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

Kebab MCP is a [template repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-template-repository). Your copy is standalone — it won't auto-update. The right path depends on **where you run it**:

| Where you run it          | How updates work                                                       |
| ------------------------- | ---------------------------------------------------------------------- |
| **Vercel** (most users)   | One-click sync from the dashboard via GitHub's API — no terminal needed |
| **Local dev**             | Auto-pull on every dev server start (silent, fast-forward only)         |
| **Docker / self-hosted**  | `npm run update` (or `git fetch upstream && git merge upstream/main`)   |

The Vercel dashboard runs a daily cron at 8h UTC that pre-fetches upstream status, so the Overview banner loads instantly. **Your `.env`, `data/`, and saved credentials in Upstash KV are never touched** — all customization lives in env vars.

Disable the in-dashboard update feature with `KEBAB_DISABLE_UPDATE_API=1`. Smoke-test recipe: [docs/TROUBLESHOOTING.md § Phase 61 update flow](docs/TROUBLESHOOTING.md#phase-61-update-flow-smoke-test).

## Community & Roadmap

- **GitHub Discussions** — questions, ideas, feedback: [github.com/Yassinello/kebab-mcp/discussions](https://github.com/Yassinello/kebab-mcp/discussions)
- **GitHub Issues** — bugs and feature requests: [github.com/Yassinello/kebab-mcp/issues](https://github.com/Yassinello/kebab-mcp/issues)

**Roadmap (subject to change):**

- [ ] Cloudflare Workers deploy target
- [ ] Stripe + Plaid connectors
- [ ] Web UI for Skills authoring
- [ ] Multi-tenant mode (single deploy, multiple users)

Shipped releases: [docs/CHANGELOG.md](docs/CHANGELOG.md).

## Contributing

See [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) for how to add tools, connectors, and custom extensions. **Quick version:** create a file in `src/connectors/<connector>/tools/`, add it to the connector's `manifest.ts`. Done.

## Documentation

Ordered by reader journey — discover, deploy, use, author, contribute.

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
