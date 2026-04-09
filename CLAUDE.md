# MyMCP — Development Guide

## Project Overview

Open-source personal MCP server framework. Ships 38 pre-built tools across 4 packs (Google Workspace, Obsidian Vault, Browser Automation, Admin). Deployed on Vercel as a Next.js app. Config-driven: packs auto-activate based on env vars.

## Architecture

- **Runtime**: Next.js on Vercel (serverless, 60s timeout)
- **MCP SDK**: `mcp-handler` wraps `@modelcontextprotocol/sdk` for Streamable HTTP
- **Registry**: Static manifests in `src/packs/*/manifest.ts` — single source of truth
- **Config**: All via env vars (no config files). See `src/core/config.ts`
- **Auth**: MCP_AUTH_TOKEN (endpoint) + ADMIN_AUTH_TOKEN (dashboard, optional fallback)

## Key Directories

```
src/core/                        — Framework: types, registry, config, auth, logging
src/packs/google/manifest.ts     — Google Workspace pack (18 tools)
src/packs/vault/manifest.ts      — Obsidian Vault pack (15 tools)
src/packs/browser/manifest.ts    — Browser Automation pack (4 tools)
src/packs/admin/manifest.ts      — Admin pack (1 tool)
src/packs/*/tools/               — Individual tool handlers
src/packs/*/lib/                 — API wrappers and helpers
app/api/[transport]/route.ts     — MCP endpoint (~30 lines, reads from registry)
app/api/health/route.ts          — Public liveness: { ok, version }
app/api/admin/status/route.ts    — Private diagnostics (auth-gated)
app/page.tsx                     — Private status dashboard
app/setup/page.tsx               — Guided setup page
```

## How the Registry Works

1. `src/core/registry.ts` imports all 4 pack manifests
2. For each pack, checks if all `requiredEnvVars` are present
3. Returns `PackState[]` with enabled/disabled + reason
4. `route.ts` iterates enabled packs, registers tools via `server.tool()`
5. Dashboard, health, admin API all read from the same registry

## Adding a Tool

1. Create `src/packs/<pack>/tools/my-tool.ts` with `{ schema, handler }` exports
2. Add entry to pack's `manifest.ts` tools array
3. Done — registry picks it up automatically

## Adding a Pack

1. Create `src/packs/mypack/manifest.ts` exporting a `PackManifest`
2. Add import + entry in `src/core/registry.ts` `ALL_PACKS` array
3. Document required env vars in `.env.example`

## Framework vs Instance

**Framework-level** (code, shared by all users):
- Pack manifests, registry, types, auth, dashboard structure
- NO personal references, NO hardcoded locale/timezone/names

**Instance-level** (env vars, unique per deployment):
- Secrets (API keys, tokens)
- Settings (MYMCP_TIMEZONE, MYMCP_LOCALE, MYMCP_DISPLAY_NAME)
- Pack activation (presence of credentials)

## Conventions

- Tool handlers export `{ schema, handler }` pattern
- Every tool is wrapped in `withLogging()` via the registry
- Use `getInstanceConfig()` for timezone/locale — never hardcode
- Descriptions are generic (no personal names or pronouns)
- Google API responses use typed interfaces (not `any`)
- Commit messages: `feat:` / `fix:` / `refactor:` / `docs:` / `chore:`

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MCP_AUTH_TOKEN` | Yes | MCP endpoint auth |
| `ADMIN_AUTH_TOKEN` | No | Dashboard auth (fallback: MCP_AUTH_TOKEN) |
| `GOOGLE_CLIENT_ID` | Google pack | OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google pack | OAuth client secret |
| `GOOGLE_REFRESH_TOKEN` | Google pack | OAuth refresh token |
| `GITHUB_PAT` | Vault pack | GitHub PAT with `repo` scope |
| `GITHUB_REPO` | Vault pack | `owner/repo` format |
| `GITHUB_BRANCH` | No | Default branch (default: `main`) |
| `BROWSERBASE_API_KEY` | Browser pack | Browserbase API key |
| `BROWSERBASE_PROJECT_ID` | Browser pack | Browserbase project ID |
| `OPENROUTER_API_KEY` | Browser pack | OpenRouter API key for Stagehand |
| `MYMCP_TIMEZONE` | No | Default: `UTC` |
| `MYMCP_LOCALE` | No | Default: `en-US` |
| `MYMCP_DISPLAY_NAME` | No | Default: `User` |
| `MYMCP_CONTEXT_PATH` | No | Default: `System/context.md` |

## Security Notes

- `crypto.timingSafeEqual` for all auth comparisons
- SSRF protection in browser tools (blocks private IPs, cloud metadata)
- Error messages sanitized (API keys stripped)
- OAuth uses state parameter + PKCE
- Health endpoint is public but returns minimal info only
- Dashboard/setup are auth-gated via middleware
