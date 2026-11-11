# Security Policy

## Supported Versions

Only the latest minor release of Kebab MCP receives security updates.

| Version | Supported          |
| ------- | ------------------ |
| 0.x (latest) | :white_check_mark: |
| < 0.x (older minor) | :x: |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Report security vulnerabilities by emailing the maintainer at the address listed on the [GitHub profile](https://github.com/Yassinello). You can also open a [GitHub Security Advisory](https://github.com/Yassinello/kebab-mcp/security/advisories/new) directly.

Please include as much of the following as possible:

- A description of the vulnerability and its potential impact
- Steps to reproduce the issue
- Affected versions
- Any suggested mitigation or fix

**Response timeline:**

- **48 hours** — acknowledgement of your report
- **7 days** — initial assessment and severity determination
- **30 days** — target resolution (complex issues may take longer; we will keep you informed)

We take all security reports seriously and will respond as promptly as possible.

## Scope

The following are considered in-scope vulnerabilities:

- Authentication bypass or privilege escalation (admin token, user token, per-tool access controls)
- Server-Side Request Forgery (SSRF) via tool handlers or proxy routes
- Injection vulnerabilities (command injection, prompt injection with data exfiltration)
- Token or credential leakage through logs, error messages, or API responses
- Insecure default configurations that expose sensitive data
- OAuth flow vulnerabilities (token theft, open redirect, PKCE bypass)
- Unauthorized access to another user's MCP tools or data

## Out of Scope

The following are **not** considered in-scope:

- Denial-of-service attacks against self-hosted instances (you control your own infrastructure)
- Social engineering attacks targeting users or maintainers
- Vulnerabilities in third-party dependencies — please report those to the respective upstream projects
- Issues that require physical access to the host machine
- Rate limiting on self-hosted deployments (configurable by operators)
- Theoretical attacks with no practical exploit path

## Disclosure Policy

We follow a **coordinated disclosure** model:

1. You report the vulnerability to us privately.
2. We investigate, confirm, and develop a fix.
3. We release the fix and publish a security advisory.
4. You may publicly disclose after **90 days** from the initial report date, or after the fix is released (whichever comes first).

We will credit you in the security advisory unless you prefer to remain anonymous.

## Security Best Practices

When self-hosting Kebab MCP, follow these guidelines:

### Token Management

- **Admin token** (`ADMIN_AUTH_TOKEN`): keep this secret and separate from user-facing tokens. Never expose it in client-side code or logs. Falls back to `MCP_AUTH_TOKEN` if unset.
- **User tokens**: rotate regularly, especially if you suspect exposure. Use the admin API to revoke compromised tokens.
- Store all secrets in environment variables — never hard-code them in source files.

### Environment Variable Hygiene

- Use `.env.local` for local development. This file is in `.gitignore` and must never be committed.
- On Vercel or other platforms, use the platform's secret management UI to set environment variables.
- Audit your deployment environment variables periodically to remove stale credentials.

### Admin Token Separation

- Use a strong, randomly generated admin token (e.g., `openssl rand -hex 32`).
- Do not reuse your admin token as a user token.
- Restrict admin endpoints (`/api/admin/*`) at the network level if possible (e.g., Vercel's IP allowlist).

### Hardening defaults (2026-11 audit)

These behaviours are on by default; each has an explicit opt-out documented in `.env.example`.

| Area | Default | Opt-out |
|---|---|---|
| MCP backup tools | `mcp_backup_export` / `mcp_backup_import` are not exposed over MCP; even when enabled they never export or import `cred:*`, first-run material, API connection auth or `devices:*` | `KEBAB_MCP_BACKUP_TOOLS=1` (still redacted) |
| Scoped tokens | `admin` is only reachable when listed in the token's scope; scopes apply whatever tenant header is sent; corrupt scope entries fail closed; rotated/revoked tokens are refused immediately (tombstone) | — |
| Custom Tools | Every step re-checks the caller's connector scope, the per-tool toggles and the target tool's schema | — |
| First run | Claims are persisted atomically in KV; claim cookies expire server-side and stop working once another claim owns the instance | `KEBAB_SETUP_TOKEN` adds a deploy-time secret |
| Outbound fetches | Redirects re-validated hop by hop (SSRF guard incl. IPv6 embeddings); credentials dropped on origin change; templated paths/bodies encoded | `KEBAB_API_CONN_ALLOW_LOCAL=1` (dev only) |
| Webhooks | Signature required | `KEBAB_WEBHOOK_ALLOW_UNSIGNED=1` |
| Dashboard | In production `MCP_AUTH_TOKEN` is not an admin credential | `KEBAB_ADMIN_TOKEN_FALLBACK=1` |
| Browser | `web_act` / `web_agent` refuse the logged-in `linkedin` context | `KEBAB_BROWSER_LINKEDIN_WRITE=1` |
| Vault | No writes under `.github/` or `.git*`; GitHub search qualifiers stripped | — |

Known accepted risks: DNS rebinding between the SSRF check and the socket connect (no IP pinning); tool output from external sources is returned to the LLM without an untrusted-content envelope. See `docs/audits/2026-11-cdc-remediation.md`.

### OAuth Credentials

- Register your OAuth app with the minimal required scopes.
- Keep `CLIENT_SECRET` values server-side only — they must never appear in client bundles.
- Review OAuth app permissions periodically and revoke unused grants.

## Token rotation

Rotate `MCP_AUTH_TOKEN` when:

- You suspect a leak (shared `.env`, logs leaked publicly, lost laptop)
- A team member with access leaves
- You can't remember the last time you rotated (≥6 months is a useful default)

The procedure depends on where Kebab MCP is hosted.

### Vercel

1. Generate a new token: `openssl rand -hex 32` (or use the dashboard's `/welcome` flow which mints one for you)
2. **Multi-token approach (zero-downtime)**: open Vercel → your project → Settings → Environment Variables → `MCP_AUTH_TOKEN`. **Append** the new token to the existing comma-separated list:

   ```
   MCP_AUTH_TOKEN=<old-token>,<new-token>
   ```

3. Trigger a redeploy (Vercel does this automatically on env-var change). Both tokens are now valid.
4. Update each MCP client (Claude Desktop, ChatGPT, Cursor, …) to use the new token. Hit the endpoint to confirm it works.
5. Once every client is on the new token, edit the env var again and **remove the old token**. Redeploy. The old token is now revoked.
6. Verify revocation: `curl -H "Authorization: Bearer <old-token>" https://your-app.vercel.app/api/mcp` should return `401 Unauthorized`.

### Docker

1. Generate a new token: `openssl rand -hex 32`
2. Edit your `.env` file: replace the `MCP_AUTH_TOKEN` value. (Multi-token works here too if you want zero-downtime.)
3. Restart the container: `docker compose restart` (or `docker restart <container>`)
4. Update MCP clients with the new token
5. Verify: `curl -H "Authorization: Bearer <old-token>" http://localhost:3000/api/mcp` → 401

### Local dev

1. Edit `.env.local`: set the new `MCP_AUTH_TOKEN`
2. `Ctrl-C` and re-run `npm run dev`
3. Update any local MCP client config that points at `http://localhost:3000`

### After rotation

- **Logs may still contain the first 8 chars of the old token's SHA-256** (the dashboard masks tokens to that prefix in the log column). This is by design and not sensitive — the prefix is a hash, not the token itself. If you opted into `MYMCP_DURABLE_LOGS=true`, the historical entries are preserved for the configured retention window. No action needed.
- The dashboard never displays the full token after the initial mint screen, so there's nothing in the UI to "scrub."
- If you committed `.env` accidentally before the pre-commit hook landed (v0.3.5), follow [GitHub's guide to remove sensitive data](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository) and rotate immediately. The hook now blocks recurrence.
