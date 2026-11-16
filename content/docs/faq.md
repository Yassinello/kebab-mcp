---
title: FAQ
summary: Common questions about Kebab House
order: 50
---

## Is this multi-user?

No. Kebab House is intentionally a personal tool. One deployment, one user, one set of credentials. Multi-user / RBAC is explicitly out of scope — see PROJECT.md.

## Can I run multiple Kebab House instances against the same Vercel account?

Yes. Each instance is a separate Vercel project with its own URL, env vars, and `MCP_AUTH_TOKEN`. Use one per persona (work, side projects, family) if you want hard separation.

## Does Kebab House store my credentials?

Two valid storage paths:

- **Vercel project env vars** (or `.env.local` for local dev) — frozen at the deploy boundary, take precedence on conflict, recommended for shared/team deploys where you want creds locked at deploy time.
- **Upstash KV** (via the dashboard "Save" button) — persists across cold starts without a redeploy, recommended for personal instances where you want to add connectors on the fly. Stored under `cred:<KEY>` keys, surfaced to handlers through an in-process snapshot (SEC-02 prevents tenant-cross-contamination by never mutating `process.env` at request time).

Skill content and personal context always live in KV (Upstash if configured, filesystem otherwise).

## What happens to my data on Vercel cold starts?

In-memory state (recent logs, runtime caches) is wiped. Persistent state (skills, context, KV-saved credentials, env vars) survives because it lives in Upstash KV and the Vercel env var system. The instance bootstrap token is rehydrated from KV on every cold start so the dashboard never asks you to log in again.

## Can I run Kebab House without Vercel?

Yes — Docker is supported. `docker build -t kebab-house .` and run with env vars passed via `-e` or `--env-file`. Set both `MCP_AUTH_TOKEN` and `ADMIN_AUTH_TOKEN` (each `openssl rand -hex 32`), or `KEBAB_ADMIN_TOKEN_FALLBACK=1`: Docker runs in production mode, where the dashboard refuses the MCP token on its own. Local dev (`npm run dev`) works the same.

## Is Kebab House open source?

Yes — AGPL-3.0 licensed, see [github.com/Yassinello/kebab-mcp](https://github.com/Yassinello/kebab-mcp). Forks and PRs welcome.

## How do I add a new connector?

Create `src/connectors/<name>/manifest.ts` exporting a `ConnectorManifest`, register it in `src/core/registry.ts`, document required env vars in `.env.example`. The framework picks it up automatically.

## How do I revoke access for a single AI client?

Open **Devices**. Every client has its own entry: the ones that signed in (OAuth) and the ones you gave a device token (**Add device**). **Revoke** cuts that client off at once; the others keep working. You can also change a client's access level there: *read only*, *read + my profile and notes*, or *everything*.

Never give an AI client your admin key: it opens the dashboard. If one uses it, Overview shows a warning.

## What's the difference between `prompts` and `tools` in skills?

MCP defines two primitives a server can expose: **prompts** (named templates the user explicitly invokes) and **tools** (functions the LLM calls autonomously). Skills appear as both. Use the prompt primitive in clients that support it (Claude Desktop, Claude Code) and rely on the tool primitive in clients that don't.
