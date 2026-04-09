# MyMCP — Personal MCP Framework

## What This Is

An open-source framework that lets technical users deploy a personal MCP server on Vercel in minutes. Users pick which tool packs to enable (Google Workspace, Obsidian vault, Browser automation), configure via a setup wizard, and get a single MCP endpoint that connects to Claude Desktop, Claude.ai, or any MCP client. Built with Next.js/TypeScript, deployed on Vercel free tier.

## Core Value

One deploy gives you a personal AI backend with all your tools — email, calendar, notes, browser — behind a single MCP endpoint.

## Requirements

### Validated

- [x] MCP server running on Vercel with Streamable HTTP transport
- [x] Bearer token auth with timing-safe comparison
- [x] Obsidian vault tools (15): read, write, search, list, delete, move, append, batch read, recent, stats, backlinks, due, save article, read paywalled, my context
- [x] Gmail tools (9): inbox, read, send, reply, trash, label, search, draft, attachment
- [x] Calendar tools (6): events, create, update, delete, find free, RSVP
- [x] Contacts tool (1): search
- [x] Drive tools (2): search, read
- [x] Browser tools (4): web browse, web extract, web act, linkedin feed
- [x] Admin tools (1): MCP logs
- [x] Tool call logging with withLogging decorator
- [x] Security: SSRF protection, context allowlist, error sanitization, rate limiting

### Active

- [ ] Dynamic tool registry — tools auto-discovered from filesystem, enabled/disabled via config
- [ ] Configuration file (`mcp.config.ts` or similar) — declare which tool packs are active
- [ ] Remove all hardcoded personal references (Yassine, Europe/Paris, etc.) — make configurable
- [ ] `.env.example` with clear documentation for every variable
- [ ] README with architecture overview, quickstart, and tool pack docs
- [ ] Setup dashboard UI at `/` — wizard that guides OAuth, vault config, browser config
- [ ] Google OAuth flow built into the app — user clicks "Connect Google" instead of manual token copy
- [ ] Status page showing which tools are active, health checks, recent usage
- [ ] Clean package.json with proper name, description, keywords for discoverability

### Out of Scope

- Multi-backend vault (Notion, S3, local filesystem) — Obsidian/GitHub only for v1, avoids scope explosion
- Multi-provider auth (Microsoft, Apple) — Google Workspace covers 80% use case
- Tool marketplace or plugin system — premature abstraction
- Mobile app — web-first
- Paid hosting/SaaS — this is a self-hosted framework
- Enterprise features (multi-user, teams, RBAC) — personal tool

## Context

**Origin:** YassMCP started as Yassine's personal MCP server. It grew organically to 38 tools covering Google Workspace, Obsidian vault, and browser automation via Stagehand/Browserbase. The code works well but is hardcoded for one user.

**Current state (April 2026):**
- 38 tools registered in a single `route.ts` file (all hardcoded imports)
- Auth: Bearer token + query string fallback
- Google auth: OAuth refresh token stored as env var (manual setup)
- Vault: GitHub Contents API pointing to a specific repo
- Browser: Stagehand + Browserbase with OpenRouter for LLM, context persistence for LinkedIn
- Deployed on Vercel (free tier, 60s function timeout)
- Security: SSRF protection, rate limiting on LinkedIn, error sanitization

**Target audience:** Technical hobbyists/makers ("bricoleurs") who use Claude and want to give it access to their personal tools. Comfortable with GitHub, Vercel, and env vars. OAuth setup complexity is acceptable.

**Motivation:** Personal branding (share on LinkedIn, with friends), continue using personally, progressive improvement. If adoption grows, invest more.

## Constraints

- **Stack**: Next.js on Vercel, TypeScript, MCP SDK via `mcp-handler` — no stack changes
- **Deployment**: Must work on Vercel free tier (60s timeout, serverless)
- **Backward compatibility**: Must not break existing tool functionality during refactor
- **Browser tools**: Browserbase dependency for now, but architecture should allow alternatives later
- **Naming**: Keep "Personal MCP" or "MyMCP" branding — open to rename later
- **Simplicity**: Clean, minimal code over feature-rich. Well-designed > feature-complete.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Obsidian/GitHub vault only | Avoid multi-backend abstraction complexity. GitHub is universal. | — Pending |
| Google Workspace only | 80% use case. Microsoft/Apple adds complexity without proportional value. | — Pending |
| Browserbase for browser tools | Only cloud browser provider with Stagehand integration. Architecture allows swap later. | — Pending |
| OpenRouter for LLM (Stagehand) | User already has OpenRouter account. Avoids vendor lock-in to OpenAI. | ✓ Good |
| disableAPI mode for Stagehand | Required to use custom LLM provider (OpenRouter). Browserbase API mode only supports OpenAI keys. | ✓ Good |
| Setup wizard UI | Dramatically lowers setup friction vs. manual env var configuration. Worth the effort. | — Pending |
| Config-driven tool registry | Tools should auto-register based on available env vars + config file. | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition:**
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone:**
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-04-09 after initialization*
