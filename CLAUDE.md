# YassMCP — Development Guide

## Project Overview

Personal MCP (Model Context Protocol) server that connects Claude to an Obsidian vault stored on GitHub. Deployed on Vercel as a Next.js app.

## Architecture

- **Runtime**: Next.js on Vercel (Edge-compatible, no Node-only APIs in middleware)
- **MCP SDK**: `mcp-handler` wraps `@modelcontextprotocol/sdk` for Streamable HTTP
- **Storage**: GitHub repo as Obsidian vault (all vault ops go through GitHub Contents API)
- **Auth**: Bearer token + query string fallback (timing-safe comparison)

## Key Directories

```
app/api/[transport]/route.ts   — MCP endpoint (tool registration + auth)
app/api/health/route.ts        — Health check endpoint
src/lib/github.ts              — GitHub API wrapper (all vault I/O)
src/lib/logging.ts             — Tool call logging decorator
src/tools/                     — One file per tool (schema + handler)
```

## Tools (15 total)

| Tool | Description |
|------|-------------|
| `vault_read` | Read a note (returns frontmatter + body + SHA) |
| `vault_write` | Create/update a note (with optional frontmatter) |
| `vault_append` | Append content to existing note (1 op instead of 3) |
| `vault_batch_read` | Read up to 20 notes in parallel |
| `vault_search` | Full-text search (GitHub Search → tree grep fallback) |
| `vault_list` | List directory contents |
| `vault_delete` | Delete a note |
| `vault_move` | Move/rename a note (atomic read→write→delete) |
| `vault_recent` | Recently modified notes (via commits API, supports `since` filter) |
| `vault_stats` | Vault metrics (note counts, folder breakdown) |
| `vault_backlinks` | Find all notes linking to a given note via `[[wikilinks]]` + forward links |
| `vault_due` | Notes with `resurface:` frontmatter date that has passed |
| `save_article` | Fetch URL via Jina Reader → save with frontmatter |
| `read_paywalled` | Read paywalled articles (Medium cookie support) |
| `my_context` | Load personal context from System/context.md |

## Development

```bash
npm run dev      # Local dev server (http://localhost:3000)
npm run build    # Production build
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MCP_AUTH_TOKEN` | Yes | Bearer token for MCP + admin auth |
| `GITHUB_PAT` | Yes | GitHub PAT with `repo` scope |
| `GITHUB_REPO` | Yes | Vault repo in `owner/repo` format |
| `MEDIUM_SID` | No | Medium session cookie for paywall bypass |

## Conventions

- All tool handlers export `{ schema, handler }` pattern
- Every tool is wrapped in `withLogging()` for observability
- GitHub API calls use `fetchWithTimeout()` (default 10s)
- Path validation: no `..`, no leading `/`, no null bytes
- SHA passthrough: pass SHA from `vault_read` to `vault_write` to skip extra GET
- Frontmatter: parsed/generated with `js-yaml`
- Commit messages: always end with `via YassMCP`

## Deployment

Push to `main` → auto-deployed on Vercel. No CI/CD config needed beyond `vercel.json`.

## Important Notes

- `crypto.timingSafeEqual` is NOT available in Edge Runtime — auth runs in Node runtime only
- GitHub Code Search may not index very small/new repos → `vault_search` has tree grep fallback
- `save_article` max size: 5MB
- `vault_batch_read` max: 20 files per call
- `vault_recent` uses commits API (may require multiple API calls for file details)
- `vault_backlinks` reads all .md files in batches of 10 — can be slow on large vaults
- `vault_due` scans frontmatter for `resurface: YYYY-MM-DD` or `resurface: when_relevant`
- Resurfacing convention: add `resurface:` to any note's frontmatter to make it discoverable by `vault_due`

<!-- GSD:project-start source:PROJECT.md -->
## Project

**MyMCP — Personal MCP Framework**

An open-source framework that lets technical users deploy a personal MCP server on Vercel in minutes. Users configure tool packs (Google Workspace, Obsidian vault, Browser automation) via env vars, and get a single MCP endpoint that connects to Claude Desktop, Claude.ai, or any MCP client. Built with Next.js/TypeScript, deployed on Vercel free tier.

**Core Value:** One deploy gives you a personal AI backend with all your tools — email, calendar, notes, browser — behind a single MCP endpoint.

### Constraints

- **Stack**: Next.js on Vercel, TypeScript, MCP SDK via `mcp-handler` — no stack changes
- **Deployment**: Must work on Vercel free tier (60s timeout, serverless) AND local dev
- **Backward compatibility**: Contract-level — same tool names, schemas, behavior
- **Browser tools**: Browserbase for now, clean module boundaries allow swap later
- **Simplicity**: Clean, minimal code over feature-rich. Boring architecture > smart architecture.
- **Upgradability**: `git pull upstream main` must never conflict (no user-modified tracked files)
<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->
## Technology Stack

## Current Stack (Keep As-Is)
| Technology | Version | Purpose | Status |
|------------|---------|---------|--------|
| Next.js | ^16.2.1 | App framework + API routes | Keep |
| TypeScript | ^6.0.2 | Type safety | Keep |
| React | ^19.2.4 | UI (needed for setup wizard) | Keep |
| Zod | ^4.3.6 | Schema validation | Keep |
| @modelcontextprotocol/sdk | ^1.26.0 | MCP protocol implementation | Upgrade to ^1.29.0 |
| mcp-handler | ^1.1.0 | Vercel MCP adapter | Keep, leverage withMcpAuth |
| js-yaml | ^4.1.1 | Frontmatter parsing | Keep |
| @browserbasehq/stagehand | ^3.2.0 | Browser automation | Keep |
| @browserbasehq/sdk | ^2.10.0 | Browserbase client | Keep |
## Recommended Additions
### 1. Setup Wizard UI: shadcn/ui + Tailwind CSS v4
| Technology | Version | Purpose | Confidence |
|------------|---------|---------|------------|
| tailwindcss | ^4.x | Utility CSS for setup wizard UI | HIGH |
| @tailwindcss/postcss | ^4.x | PostCSS integration | HIGH |
| shadcn/ui | latest (CLI) | Component library for wizard/dashboard | HIGH |
| tw-animate-css | latest | Animation support (replaces tailwindcss-animate) | HIGH |
| lucide-react | latest | Icon library (shadcn default) | HIGH |
### 2. Dynamic Tool Registry: Filesystem Convention (No New Dependency)
| Technology | Version | Purpose | Confidence |
|------------|---------|---------|------------|
| Node.js `fs` + `path` | built-in | Tool auto-discovery at build time | HIGH |
| glob (via fast-glob) | ^3.3.x | File pattern matching for tool discovery | MEDIUM |
### 3. Configuration System: TypeScript Config File
| Technology | Version | Purpose | Confidence |
|------------|---------|---------|------------|
| (no new dependency) | - | `mcp.config.ts` at project root | HIGH |
### 4. Google OAuth Flow: Arctic (Lightweight OAuth Client)
| Technology | Version | Purpose | Confidence |
|------------|---------|---------|------------|
| arctic | ^3.7.0 | OAuth 2.0 client for Google | MEDIUM |
- Authorization URL generation with PKCE
- Token exchange (code -> access_token + refresh_token)
- Token refresh
### 5. Token/Secret Storage: Environment Variables + Vercel API
| Technology | Version | Purpose | Confidence |
|------------|---------|---------|------------|
| (no new dependency) | - | Env vars via Vercel dashboard or API | HIGH |
| @vercel/sdk | latest | Programmatic env var management (optional) | LOW |
### 6. Form Validation: React Hook Form + Zod
| Technology | Version | Purpose | Confidence |
|------------|---------|---------|------------|
| react-hook-form | ^7.54.x | Form state management for setup wizard | HIGH |
| @hookform/resolvers | ^5.x | Zod integration for react-hook-form | HIGH |
### 7. Notifications/Toasts: sonner
| Technology | Version | Purpose | Confidence |
|------------|---------|---------|------------|
| sonner | ^2.x | Toast notifications for setup wizard | HIGH |
## Full Installation Command
# Upgrade existing
# Setup wizard UI
# OAuth flow
# Dev dependencies (if not already present via shadcn init)
# shadcn components (after init)
## Alternatives Considered
| Category | Recommended | Alternative | Why Not Alternative |
|----------|-------------|-------------|---------------------|
| UI Components | shadcn/ui | Material UI | Heavy, opinionated, npm dependency lock-in |
| UI Components | shadcn/ui | Ant Design | Even heavier, enterprise-focused, not Next.js-native |
| CSS | Tailwind v4 | CSS Modules | Less productive for rapid UI development |
| OAuth | Arctic | Auth.js v5 | Over-engineered for single-user OAuth consent flow |
| OAuth | Arctic | Raw fetch | Security-sensitive PKCE flow shouldn't be hand-rolled |
| Config | mcp.config.ts | cosmiconfig | Overkill — single known config file location |
| Config | mcp.config.ts | JSON/YAML | No type safety, no IDE autocomplete |
| Config storage | Env vars | Vercel Edge Config | Vendor lock-in, free tier limits, wrong abstraction |
| Config storage | Env vars | Database (KV/Redis) | Secrets don't belong in databases, adds cost |
| Tool registry | Filesystem glob | Database | Static config, not runtime-dynamic |
| Forms | React Hook Form | Formik | Legacy, more re-renders, less Next.js integration |
| Toasts | sonner | react-hot-toast | sonner is shadcn's official recommendation |
## What NOT to Add
| Technology | Why Not |
|------------|---------|
| Prisma / Drizzle / any ORM | No database needed. Config is in files + env vars. |
| Redis / KV store | No session state to manage. Serverless = stateless. |
| tRPC | Only 3-4 API routes for the wizard. Plain route handlers suffice. |
| Zustand / Jotai / Redux | Setup wizard state is form-local. No global state needed. |
| next-intl / i18next | English-only for v1. Internationalization is premature. |
| Playwright / Puppeteer | Browser tools already use Stagehand/Browserbase. |
| Stripe / payments | Out of scope — this is a free self-hosted framework. |
| Docker | Target is Vercel deployment. Docker adds complexity for the audience. |
## Architecture Notes for Tool Registry
- Adding a tool = adding one file to `src/tools/`
- Enabling a tool pack = setting `enabled: true` in config + providing env vars
- No manual registration in `route.ts` ever again
## Confidence Assessment
| Technology | Confidence | Reason |
|------------|------------|--------|
| shadcn/ui + Tailwind v4 | HIGH | Dominant pattern, verified via official docs and ecosystem |
| Filesystem tool registry | HIGH | Natural extension of existing `src/tools/` convention |
| mcp.config.ts | HIGH | Standard TypeScript config pattern used by Next.js, Tailwind, Vite |
| Arctic for OAuth | MEDIUM | Well-maintained but less widely adopted than Auth.js. Correct fit for the use case but needs validation during implementation. |
| Env var storage | HIGH | Already the pattern in the project, correct for Vercel serverless |
| React Hook Form | HIGH | Standard for Next.js forms, Zod integration is native |
| @modelcontextprotocol/sdk ^1.29.0 | HIGH | Verified latest stable, widely adopted (40K+ dependents) |
| Vercel API for env vars | LOW | Nice-to-have, adds complexity, needs validation |
## Sources
- [mcp-handler GitHub](https://github.com/vercel/mcp-handler) — Vercel MCP adapter, withMcpAuth OAuth support
- [@modelcontextprotocol/sdk npm](https://www.npmjs.com/package/@modelcontextprotocol/sdk) — Latest version 1.29.0
- [MCP Spec: Dynamic Tool Updates](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) — Protocol support for dynamic tool lists
- [shadcn/ui Tailwind v4 docs](https://ui.shadcn.com/docs/tailwind-v4) — Full v4 support confirmed
- [shadcn/ui Next.js installation](https://ui.shadcn.com/docs/installation/next) — Official setup guide
- [Arctic OAuth library](https://github.com/pilcrowonpaper/arctic) — v3.7.0, 50+ providers including Google
- [Auth.js v5 with Next.js 16](https://dev.to/huangyongshan46a11y/authjs-v5-with-nextjs-16-the-complete-authentication-guide-2026-2lg) — Auth.js capabilities (considered and rejected)
- [Zod v4 release notes](https://zod.dev/v4) — Stable since July 2025, 14x faster parsing
- [Vercel Storage docs](https://vercel.com/docs/storage) — KV sunset, Edge Config limits
- [c12 config loader](https://unjs.io/packages/c12/) — Considered and rejected (overkill)
- [Cosmiconfig](https://github.com/cosmiconfig/cosmiconfig) — Considered and rejected (overkill)
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd:quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd:debug` for investigation and bug fixing
- `/gsd:execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->

<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd:profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
