# Kebab MCP — Deployment Examples

Two compose files, one decision: **do you need to scale horizontally?**

- **No** → `docker-compose.single.yml` (1 replica + filesystem KV).
- **Yes** → `docker-compose.multi.yml` (N replicas + Upstash KV).

Both assume `docker` and `docker compose` are installed, and that you
have copied `../../.env.example` to `./.env` inside this directory
(the compose files read env vars from that file via interpolation).

For the full host matrix (Vercel / Docker / Fly / Render / Cloud Run /
bare-metal), see [`../HOSTING.md`](../HOSTING.md).

---

## `docker-compose.single.yml` — 1 replica + filesystem KV

**When to use.** Personal or single-user deployments on any host with a
persistent disk (Docker, Fly single-machine, bare-metal). This is the
recommended starter.

**What it needs.** `MCP_AUTH_TOKEN` only. Everything else has a default.

**Boot.**

```bash
cd docs/examples
cp ../../.env.example .env        # fill in MCP_AUTH_TOKEN at minimum
docker compose -f docker-compose.single.yml up -d
```

**Verify.**

```bash
curl -sf http://localhost:3000/api/health
# → {"ok":true,"version":"...","kv":{"reachable":true,...}, ...}
```

**State.** Lives at `./data/kv.json` on the host (bind-mounted to
`/app/data/kv.json` in the container). Survives `docker compose down` +
`up`. Delete the directory to wipe state.

---

## `docker-compose.multi.yml` — N replicas + Upstash KV

**When to use.** Horizontal scaling, multi-machine Fly, Kubernetes-lite,
any deploy where two or more processes serve traffic behind a load
balancer. Zero-downtime rolling deploys fall into this bucket too — even
if your steady state is 1 replica, briefly running `replicas=2` during
a deploy requires shared state.

**What it needs.** `MCP_AUTH_TOKEN`, `UPSTASH_REDIS_REST_URL`,
`UPSTASH_REDIS_REST_TOKEN`. (Vercel Marketplace names `KV_REST_API_URL`
/ `KV_REST_API_TOKEN` also work — see `src/core/upstash-env.ts`.)

**Boot.**

```bash
cd docs/examples
cp ../../.env.example .env    # fill in MCP_AUTH_TOKEN + UPSTASH_*
docker compose -f docker-compose.multi.yml up -d --scale kebab-mcp=3
```

**Caveat.** `MYMCP_DURABLE_LOGS=1` is set automatically in this compose.
Do not override it — per-replica in-memory log rings diverge across
replicas and `mcp_logs` becomes non-deterministic otherwise. See
[`../HOSTING.md`](../HOSTING.md) §"Durable logs mandatory for N-replica".

**LB.** The `lb` service is a minimal Caddy reverse proxy. Docker's
internal DNS round-robins across the replicas, so Caddy picks them all
up automatically. On Docker Swarm, drop the `lb` service and let the
routing mesh handle fan-out.

---

## Migration path

Start with `docker-compose.single.yml`. When you need HA (zero-downtime
deploys, horizontal scaling, multi-machine hosting), graduate to
`docker-compose.multi.yml`:

1. Create an Upstash Redis instance (free tier at https://upstash.com).
2. Add `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` to `.env`.
3. Stop the single-replica compose (`docker compose -f docker-compose.single.yml down`).
4. Boot the multi-replica compose.
5. Re-run the welcome flow if credentials need to be re-written from
   filesystem KV into Upstash — or copy `./data/kv.json` values over
   with `scripts/backup.ts` (see the repo root).

See [`../HOSTING.md`](../HOSTING.md) §"Upgrade: single-replica → multi-replica"
for the full checklist.
