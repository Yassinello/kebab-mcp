# Kebab MCP — Hosting Guide

Kebab MCP is host-agnostic. What changes between hosts is the **state
layer**: where `mymcp:*` keys live, how many processes share them, and
how graceful the shutdown story is. The matrix below picks a safe
combination for your target. Default to **Vercel + Upstash** or
**Docker single-replica + filesystem KV** if you are unsure.

For working boot examples, see [`docs/examples/`](./examples/).

---

## Host compatibility matrix

| Target              | Persistence default                       | Scaling model               | Required env vars                                                                                              | Healthcheck path | SIGTERM handling                                            | Volume mount                   | Migration checklist from Vercel                                                    |
| ------------------- | ----------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------- |
| Vercel              | Upstash KV (Marketplace or manual)        | Serverless (ephemeral λ)    | `MCP_AUTH_TOKEN`, `KV_REST_API_URL` or `UPSTASH_REDIS_REST_URL` (+ `_TOKEN`)                                   | `/api/health`    | N/A — lambdas are SIGKILL'd by the runtime                  | N/A                            | Baseline — no migration needed                                                     |
| Docker 1-replica    | Filesystem KV (`./data/kv.json`)          | Single persistent process   | `MCP_AUTH_TOKEN`                                                                                               | `/api/health`    | 5s graceful drain (override via `MYMCP_SHUTDOWN_TIMEOUT_MS`) | `./data:/app/data`             | Export env, `docker compose up -d`                                                 |
| Docker N-replica    | Upstash KV (mandatory)                    | Load-balanced persistent    | `MCP_AUTH_TOKEN`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, **`MYMCP_DURABLE_LOGS=1`** (mandatory) | `/api/health`    | 5s graceful drain (override via `MYMCP_SHUTDOWN_TIMEOUT_MS`) | None (state in Upstash)        | Export env, switch to Upstash, set `MYMCP_DURABLE_LOGS=1`                          |
| Fly.io              | Upstash KV (recommended) or Fly volume    | Horizontal (machines)       | Same as Docker N-replica + **`MYMCP_DURABLE_LOGS=1`**                                                          | `/api/health`    | 5s graceful drain (Fly sends SIGINT then SIGTERM)           | Fly volume at `/app/data` if FS KV | Same as Docker N-replica; `fly.toml` checks at `/api/health`                       |
| Render              | Upstash KV (Render disks are per-service) | Horizontal (instances)      | Same as Docker N-replica + **`MYMCP_DURABLE_LOGS=1`**                                                          | `/api/health`    | 5s graceful drain (Render grace window = 30s)               | N/A (state in Upstash)         | Same as Docker N-replica                                                           |
| Cloud Run           | Upstash KV (mandatory — stateless)        | Serverless + horizontal     | Same as Docker N-replica + **`MYMCP_DURABLE_LOGS=1`**                                                          | `/api/health`    | 10s default grace window — our 5s drain fits inside it      | N/A                            | Same as Docker N-replica; set `--min-instances=1` to avoid cold starts             |
| Bare-metal          | Filesystem KV or Upstash (operator choice) | Single or clustered (choice) | `MCP_AUTH_TOKEN` + Upstash vars if clustered (+ `MYMCP_DURABLE_LOGS=1` if multi-node)                          | `/api/health`    | 5s graceful drain via `systemd` or pm2                      | `./data/` mounted by operator  | Most flexible; filesystem for single-node, Upstash for HA                          |

---

## Persistence modes

Kebab MCP detects the state backend at boot from env vars alone. See
`src/core/kv-store.ts` for the selection logic.

- **Filesystem KV** (`./data/kv.json`) — durable on any persistent disk.
  **NOT safe across replicas** — each process holds its own copy. Perfect
  for single-replica Docker, Fly single-machine, and bare-metal single-node.
- **Upstash KV** — durable, HTTP-based, safe across replicas. **Required**
  for any host that runs more than one process in parallel (Docker N-replica,
  Fly multi-machine, Render multi-instance, Cloud Run). Accepts both
  `UPSTASH_REDIS_REST_*` (manual) and `KV_REST_API_*` (Vercel Marketplace)
  naming; see `.env.example` for details.
- **`/tmp` fallback** — used only on Vercel when Upstash is not configured,
  and only for the cold-start bootstrap handshake (`/tmp/mymcp-kv.json`).
  Ephemeral — evaporates ~15 minutes after last traffic. **Never** relied
  on for long-term persistence; treated as a last-resort cache only.

---

## Healthcheck endpoint

Two variants of `/api/health` are available:

- **`GET /api/health`** — public, cheap, returns `{ ok, version, warnings?, bootstrap?, kv? }`.
  **Use this for container `HEALTHCHECK` directives** (Docker, Fly, Cloud Run,
  Kubernetes liveness probe). It is hard-capped at 1.5s total and never
  leaks secrets.
- **`GET /api/health?deep=1`** — admin-gated (`Authorization: Bearer <ADMIN_AUTH_TOKEN>`),
  runs `diagnose()` on every enabled connector. **Use this for operator
  probes** (Grafana synthetic monitors, Healthchecks.io, Better Uptime),
  NOT for container-orchestrator liveness checks — it hits external APIs
  and will take several seconds on a healthy deploy.

The root `docker-compose.yml` and the examples under `docs/examples/`
all use the basic `/api/health` path for their `HEALTHCHECK`.

---

## SIGTERM handling

Every persistent-process deployment (Docker, Fly, Render, Cloud Run,
bare-metal) runs via the `server.js` wrapper at the repo root. It
installs a SIGTERM + SIGINT handler that:

1. Logs `[shutdown] Received SIGTERM, draining in <N>ms...`.
2. Lets in-flight requests finish naturally (the wrapper does NOT close
   the HTTP server — it relies on Next's active-handle bookkeeping so
   connections flush cleanly).
3. After the drain window elapses, calls `process.exit(0)`.

Defaults:

- **Drain window:** 5000 ms.
- **Override:** `MYMCP_SHUTDOWN_TIMEOUT_MS=<ms>` in the container env.
- **Minimum:** 1000 ms (the wrapper clamps small values upward).

Tune per host based on the orchestrator's termination grace period:

| Host       | Grace window  | Recommended drain       |
| ---------- | ------------- | ----------------------- |
| Docker     | 10s default   | 5000 (fits inside 10s)  |
| Fly.io     | 30s default   | 5000–10000              |
| Render     | 30s default   | 5000–10000              |
| Cloud Run  | 10s default   | 5000 (fits inside 10s)  |
| Kubernetes | `terminationGracePeriodSeconds` (default 30) | 5000–10000 |

Vercel lambdas ignore SIGTERM — the runtime SIGKILLs them at the
invocation deadline. `MYMCP_SHUTDOWN_TIMEOUT_MS` is a no-op on Vercel.

---

## Durable logs mandatory for N-replica

When running more than one replica behind a load balancer, **set
`MYMCP_DURABLE_LOGS=1`**. Without it, each replica writes tool-call
logs to its own in-process ring buffer, and the `mcp_logs` tool will
return a non-deterministic slice depending on which replica serves the
request.

With `MYMCP_DURABLE_LOGS=1`:

- Logs aggregate in KV at the `log:*` key prefix.
- `mcp_logs` reads from KV, so every replica sees the same view.
- Retention controlled by `MYMCP_LOG_MAX_ENTRIES` and
  `MYMCP_LOG_MAX_AGE_SECONDS` (see `.env.example`).

The matrix rows for **Docker N-replica**, **Fly** (multi-machine),
**Render**, and **Cloud Run** list this as the default expectation.
Single-replica Vercel and Docker deploys are fine on the default
(`MYMCP_DURABLE_LOGS=false`) because there is only one ring buffer.

**Phase 39 note:** the code default stays `false` — we only mandate
`=1` in the deployment docs. A future milestone may auto-flip on
Upstash detection (tracked as a v0.11 follow-up).

---

## Upgrade: single-replica → multi-replica

Run through this checklist when graduating a filesystem-KV deploy to
a horizontally scaled one:

1. **Switch to Upstash.** Create an Upstash Redis instance (free tier
   at https://upstash.com) and set `UPSTASH_REDIS_REST_URL` +
   `UPSTASH_REDIS_REST_TOKEN` in the deployment env.
2. **Set `MYMCP_DURABLE_LOGS=1`.** Mandatory per above.
3. **Remove the `./data` volume mount.** Once state is in Upstash,
   the filesystem mount is not used and keeping it on one replica
   risks confusion about which backend is authoritative.
4. **Rotate `MCP_AUTH_TOKEN`** if the original was cached in logs
   or CI artifacts.
5. **Verify `/api/health`** returns 200 and the `kv.reachable: true`
   field from `/api/health?deep=1` confirms Upstash is live.
6. **Re-run the welcome flow** only if you need to re-claim the
   instance; otherwise existing tokens keep working.

---

## Migration checklist from Vercel to self-hosted

1. **Export env** from Vercel (`vercel env pull .env`).
2. **Decide filesystem vs Upstash.** Single-replica → filesystem is
   fine. N-replica or zero-downtime deploys → keep Upstash.
3. **Adjust `MYMCP_DURABLE_LOGS`** per the matrix (default `false` for
   single-replica, `1` for multi-replica).
4. **Rotate `MCP_AUTH_TOKEN`** — the Vercel-minted token should not be
   re-used cross-environment.
5. **Boot** via `docker compose up -d` (or equivalent on Fly/Render/
   Cloud Run/bare-metal).
6. **Verify `/api/health`** returns `{ ok: true }`. Hit it via the
   container port or the LB.
7. **Run the welcome flow** if first-run state needs rebuilding — or
   copy `./data/kv.json` from a previous Docker deploy to skip.

---

## Degraded-mode contract

This matrix documents which deployment combinations protect the
concurrent first-run claim race (two browsers hitting
`POST /api/welcome/init` with the same claim cookie) and which
accept a race window as documented dev-mode behavior.

| Host     | KV backend             | Race-protection guarantee                             | Status                        |
|----------|------------------------|-------------------------------------------------------|-------------------------------|
| Vercel   | Upstash                | Atomic `SET key value NX EX` — cross-lambda safe      | Fully protected (production)  |
| Vercel   | no external KV         | Unprotected — each lambda has its own memory cache    | Not recommended for prod      |
| Docker   | FilesystemKV (1 proc)  | Write-queue serialization inside a single process     | Protected in-process only     |
| Docker   | FilesystemKV (N procs) | Cross-process race possible — FilesystemKV not atomic | Not protected — use Upstash   |
| Node dev | MemoryKV               | Map.has guard inside one process                      | Dev only — single-process     |

### What "protected" means

The winner minting call returns `200 { ok: true, token }`.
The loser returns `409 { error: "already_minted" }` with no token
in the body. The loser re-enters via the already-initialized
paste-token flow.

### What "unprotected" means

Both concurrent callers may return `200` with different tokens.
The last write wins; one browser holds a token that is NOT the
one persisted. Acceptable for single-user local dev; NOT
acceptable for multi-user or production.

### How to upgrade

- Vercel + Upstash: set `UPSTASH_REDIS_REST_URL` +
  `UPSTASH_REDIS_REST_TOKEN` (or `KV_REST_API_URL` +
  `KV_REST_API_TOKEN`) in Vercel env vars.
- Docker multi-process: point the container at an external Upstash
  (or Redis with a compatible REST gateway) via the same env vars.
  FilesystemKV is for single-process deployments only.

### Related code paths

- Helper: `src/core/first-run.ts` → `flushBootstrapToKvIfAbsent()`
- Route: `app/api/welcome/init/route.ts` 409 "already_minted" branch
- Tests: `tests/integration/welcome-init-concurrency.test.ts`

---

*See also:*
*- `docs/examples/docker-compose.single.yml` — 1-replica filesystem starter.*
*- `docs/examples/docker-compose.multi.yml` — N-replica Upstash + LB.*
*- `.env.example` — every env var documented with defaults and scope.*
