---
title: Storage modes & data persistence
summary: Where Kebab MCP keeps your credentials and skills, and how to pick the right backend
order: 25
---

## What is storage in Kebab MCP?

Kebab MCP keeps three kinds of data alive between requests: **connector credentials** (the API keys you paste into `/config → Connectors`), **skills** (the prompt templates you write or compose), and **runtime settings** (timezone, display name, per-tool toggles). Everything else — logs, caches, MCP session state — is in-memory and disposable.

That data has to live somewhere. Kebab MCP picks one of three backends at boot, based on what's available in your environment. The pick is not a setting — it's a detection. If Upstash Redis is reachable, it uses Upstash. Otherwise it falls back to the local filesystem. Otherwise it runs read-only from env vars only. The current mode is shown in the **Storage** tab as a coloured badge: `Upstash Redis ✓`, `Filesystem ✓`, `Filesystem (temporary) ⚠`, `Static ⚠`, or `KV unreachable ✗`.

Knowing which mode you're in matters because each one has a different durability story. The wrong mode for your deploy means saved credentials silently vanish, skills disappear after a redeploy, or every change requires editing Vercel env vars by hand.

## The three modes

### KV (Upstash Redis)

**When picked**: `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are set and the ping check succeeds.

**What works**: every save is instant and survives cold starts, redeploys, and multi-instance scaling. Migration from file mode is one click in the dashboard. Backups via `npm run backup:export` (operator CLI). Free Upstash tier is plenty for a personal instance.

**What breaks**: nothing inherent. If Upstash is misconfigured (wrong token, deleted database, network blocked), Kebab MCP flips to a `kv-degraded` state instead of silently writing to the wrong place — you'll see `KV unreachable ✗` and the dashboard refuses to save.

**When to upgrade**: this is the upgrade target. You don't go beyond KV for a personal instance.

### File (filesystem)

**When picked**: no Upstash, but the OS gives Kebab MCP a writable directory (`./data` locally, `/tmp` on Vercel, the volume you mounted in Docker).

**What works**: instant local saves, no network round-trip, no extra signup. Perfect for `npm run dev` and single-instance Docker with a mounted volume.

**What breaks**:

- **On Vercel**: `/tmp` is wiped on every cold start (typically every 15–30 minutes of inactivity, and on every redeploy). Saves look like they worked, then silently disappear. Kebab MCP detects this case and shows the badge as `Filesystem (temporary) ⚠` — see "The Vercel /tmp trap" below.
- **Multi-instance**: each replica has its own filesystem, so saves on one don't propagate. Use KV for multi-instance.

**When to upgrade**: moving to Vercel, or scaling Docker beyond one container. Migration is one click from `/config → Storage`.

### Static (env-vars only)

**When picked**: no Upstash, no writable filesystem (e.g. Vercel deploys where `/tmp` has been removed, or read-only containers).

**What works**: connectors still activate from env vars. The MCP endpoint serves tools normally.

**What breaks**: the dashboard cannot save anything. Every credential, every skill, every setting must go through Vercel's env var UI followed by a redeploy. No `/config` quality of life.

**When to upgrade**: as soon as you can. Static is a fallback, not a destination. Add Upstash and the badge flips automatically.

## The Vercel /tmp trap

This is the failure mode that prompted the v3 storage UX rework, and it's still the single most common gotcha.

When you click "Deploy with Vercel" and skip the Upstash integration, Kebab MCP boots, finds no `UPSTASH_REDIS_REST_URL`, then finds that `/tmp` is writable, then picks **File mode** pointing at `/tmp/mymcp-data/`. The dashboard works. You save your Notion token. The Connectors tab shows ✓. You move on.

15 minutes later, the function cold-starts. Vercel wipes `/tmp`. The next dashboard load shows your Notion token gone. There's no error, no warning, no log entry — the data was written successfully, then the storage layer got recycled.

**Kebab MCP v3 detects this case explicitly.** When the runtime is on Vercel and the data dir lives under `/tmp`, the storage layer marks itself `ephemeral: true` and the dashboard shows:

- A `Filesystem (temporary) ⚠` badge in the sidebar and on the Storage tab
- A red `FileEphemeralWarningCard` at the top of the Storage tab with a 3-step Upstash setup
- An orange storage step in the Welcome wizard with three explicit choices (set up Upstash, switch to env-vars-only mode, or accept the limitation)

We don't silently fall back to env-vars-only because that hides a real problem from the user. We don't silently write to a non-ephemeral location because there isn't one on Vercel. We make the trade-off visible and let you choose.

## Picking the right mode for your deploy

| Deploy                                   | Recommended mode | Setup                                                                              |
| ---------------------------------------- | ---------------- | ---------------------------------------------------------------------------------- |
| Vercel personal instance                 | **KV**           | Add the [Upstash integration](https://vercel.com/integrations/upstash) (free tier) |
| Vercel showcase / demo (no saves needed) | **Static**       | Set credentials as Vercel env vars only — no `/tmp` writes                         |
| Docker, single container                 | **File**         | Mount a volume at `/app/data` — `docker run -v mymcp-data:/app/data ...`           |
| Docker, multiple replicas                | **KV**           | Same Upstash setup, each replica reads/writes the same store                       |
| Local development                        | **File**         | Default — writes to `./data/`, gitignored                                          |

The dashboard tells you which mode you're in and links to the right upgrade path. You don't pick by editing a config file — you pick by setting (or not setting) the right env vars.

## Migrating between modes

### File → KV

1. Provision Upstash and add `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` to your environment
2. Restart Kebab MCP (redeploy on Vercel, `docker compose restart` on Docker, ctrl-C + `npm run dev` locally)
3. Open `/config → Storage`. The badge now shows `Upstash Redis ✓` and a "Migrate from file" expand-section appears under "KV is healthy"
4. Click **Preview & migrate**. The modal shows what will be added/updated/skipped. Existing KV values are preserved unless overwritten by file values.
5. Confirm. Done.

### KV → File

There's no UI for this — it's the wrong direction for a personal Vercel instance. If you genuinely need to back up KV to disk (e.g. moving from Vercel to self-hosted Docker), use:

```bash
# Operator CLI — run with the instance's KV credentials in the environment.
# Includes secrets (connector credentials, bootstrap token): treat the file as a credential.
npm run backup:export > backup.json
# Redacted, shareable variant:
npx tsx scripts/backup.ts export --no-secrets > backup-redacted.json
```

Then start the new instance with file storage and run `npm run backup:import backup.json`.

> The `mcp_backup_export` / `mcp_backup_import` MCP tools are disabled by default since the 2026-11 security audit (any MCP token could otherwise dump every stored secret). Set `KEBAB_MCP_BACKUP_TOOLS=1` to re-enable them; even then they never export or import credentials, first-run material or device scopes.

### KV-degraded recovery

If the badge flashes `KV unreachable ✗`, Kebab MCP can reach the env vars but the Upstash ping fails. Common causes:

- Token rotated in Upstash but not updated in Vercel
- Upstash database paused (free tier auto-pauses after long inactivity — open the [Upstash console](https://console.upstash.com) and resume)
- Network policy blocking Upstash from your Docker host

The dashboard refuses to save in this state by design. Fix the connectivity, click **Recheck**, and the mode flips back to `Upstash Redis ✓` without a restart.

## What if my saves disappeared?

Most likely you were in `Filesystem (temporary)` mode on Vercel and a cold start wiped `/tmp`. Recovery:

1. Check the Storage tab. If the badge is orange/amber, that's the cause.
2. Set up Upstash (the in-tab walkthrough takes ~2 minutes).
3. Re-paste your credentials in `/config → Connectors`. They'll persist this time.

If the badge is green and saves still disappeared, that's a real bug — please [open an issue](https://github.com/Yassinello/kebab-mcp/issues) with your storage status JSON (the Storage tab shows mode, latency, and counts you can copy in).

See also: [Troubleshooting](#troubleshooting) for the specific badge states, [Connector setup](#connectors) for where credentials end up.
