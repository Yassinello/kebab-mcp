---
title: Troubleshooting
summary: Fix the things that break most often
order: 40
---

## My saved credentials disappeared after a few minutes

You're in **Filesystem (temporary)** mode — Vercel's `/tmp` got recycled on a cold start and took your saves with it. Open `/config → Storage` and look for the orange `Filesystem (temporary) ⚠` badge to confirm.

Fix: add the [Upstash integration](https://vercel.com/integrations/upstash) (free tier covers a personal instance), let Vercel auto-redeploy, then re-paste your credentials in `/config → Connectors`. They will persist this time. Full walkthrough in the [Storage doc](#storage).

## Storage badge shows "KV unreachable ✗"

The runtime sees `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` but the ping check failed. Kebab House refuses to save in this state by design — silent fallback to `/tmp` would re-introduce the disappearing-data bug. Common causes:

- Upstash database paused (free tier auto-pauses after long idle — open the [Upstash console](https://console.upstash.com) and resume)
- Token rotated in Upstash but not pushed to Vercel
- Outbound network blocked from your Docker host

Fix the connectivity, click **Recheck** on the Storage tab, badge flips back to `Upstash Redis ✓`. No restart needed.

## Welcome wizard shows an orange storage warning

The Welcome flow now detects the `/tmp` ephemeral trap before you finish setup. The orange step gives you three explicit choices:

1. **Set up Upstash now** (recommended) — link to the integration, ~2 min
2. **Use env-vars-only mode** — accept that every credential change requires a Vercel redeploy
3. **Continue anyway** — proceed with the warning, knowing saves are temporary

Pick option 1 unless you're explicitly building a static showcase. See the [Storage doc](#storage) for which mode fits which deploy.

## "Unauthorized" on /config or /api/mcp

Cause: the request didn't carry a valid token. Fix:

- Browser dashboard: visit `/config?token=YOUR_ADMIN_KEY` once. Kebab House sets a cookie and you can navigate normally afterward.
- MCP client: sign in again from the client (Claude, ChatGPT, Cursor, Claude Code), or check that it sends its device token as `Authorization: Bearer <token>` (or `?token=` for clients that only accept URLs). A revoked device stops working at once.

## "Admin auth misconfigured" on /config (Docker)

Cause: Docker runs in production mode, where `MCP_AUTH_TOKEN` alone does not open the dashboard. Fix: set `ADMIN_AUTH_TOKEN` to a second value (`openssl rand -hex 32`) and use it to sign in, or set `KEBAB_ADMIN_TOKEN_FALLBACK=1` to reuse `MCP_AUTH_TOKEN`. Restart the container.

## Welcome page reappears every time I deploy

Cause: `MCP_AUTH_TOKEN` is unset in your Vercel project. Each redeploy starts in first-run mode. Fix: set `MCP_AUTH_TOKEN` in Vercel → Settings → Environment Variables, then redeploy.

## Skills disappear after a Vercel redeploy

Same root cause as the disappearing-credentials entry above: you're in `Filesystem (temporary)` mode and Vercel wiped `/tmp`. Open `/config → Storage` to confirm the badge state, then follow the Upstash setup in that tab (or in the [Storage doc](#storage)). Once the badge shows `Upstash Redis ✓`, skills persist across cold starts and redeploys.

## Google connector "Test connection" fails

Open the **error details** panel under the failed test. Common causes:

- `invalid_grant`: the refresh token has expired or been revoked. Re-run the OAuth helper to mint a new one.
- `403 forbidden`: an API isn't enabled in your Google Cloud project. Enable Gmail API, Calendar API, Drive API, and People API in the Console.
- `429 rate limited`: you're sharing a default OAuth client with many other deployments. Use your own.

## Browserbase / Stagehand timeouts

Cause: complex pages exceed the 60s Vercel function timeout. Fix: bump `BROWSER_TIMEOUT_MS` in env vars to 50000 max (Vercel hard cap), or run Kebab House in Docker / a VPS where you control the timeout.

## Tool calls succeed but return empty content

Likely the connector's underlying API hit a transient error and the handler swallowed it. Check `/config → Logs` for the most recent invocation and look at the error message column. If logs aren't useful, increase `MYMCP_LOG_LEVEL=debug` and reproduce.

## "Test connection" fails right after I save (Missing X)

Symptom: you save a connector's credentials, the green Upstash toast appears, but clicking **Test connection** afterwards reports "Missing PAT/key/etc.".

Cause (fixed in v0.1.16+): the dashboard form serves the saved values masked (`••••`) for security, and the client filters those masks before posting. The server now falls back to the persisted snapshot when the form arrives empty, so this should "just work" — if you see this on a deploy older than v0.1.16, sync your fork and let Vercel redeploy.

If it still fails after that: re-paste the credentials and Test before Save. Genuine credential errors (wrong scope, expired PAT, wrong repo path) will still surface.

## Connector stays "missing env" right after I save it

Symptom: you save credentials in the dashboard, the toast confirms write to Upstash, but the connector card still shows "missing env: X, Y" after the page refreshes.

Cause (fixed in v0.1.16+): the registry was reading `process.env` directly, which doesn't see KV-saved credentials by design (SEC-02 forbids mutating `process.env` at request time to prevent tenant-cross-contamination). The fix merges the in-process credential snapshot with `process.env` at gate time. Sync your fork to v0.1.16+ if you hit this.

## Connectors page goes blank for ~1 second after Save

Same v0.1.16 release: the post-save reload was a hard `window.location.reload()` which unmounted the connector list and showed the loading placeholder. Now uses Next's RSC `router.refresh()` — the existing DOM stays mounted while the server segment re-renders.

## Where do I file bugs?

[github.com/Yassinello/kebab-mcp/issues](https://github.com/Yassinello/kebab-mcp/issues). Include:

- Kebab House version (visible in the sidebar footer)
- Connector affected
- Steps to reproduce
- The error from `/config → Logs` if applicable
