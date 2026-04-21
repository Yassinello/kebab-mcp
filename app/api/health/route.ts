// BOOTSTRAP_EXEMPT: public liveness endpoint — cannot block on KV rehydrate; returns minimal { ok, version } and (with ?deep=1) per-connector diagnose(). Bootstrap state is never read here.
import { VERSION } from "@/core/version";
import { resolveRegistry } from "@/core/registry";
import { checkAdminAuth } from "@/core/auth";
import { withTimeout } from "@/core/timeout";
import { getContextKVStore } from "@/core/request-context";

/**
 * Public health endpoint.
 *
 * `GET /api/health` — liveness only. Returns `{ok, version}`. No
 * connector details, no env var info. Safe for public uptime monitors.
 *
 * `GET /api/health?deep=1` — admin-gated deep health check. Runs each
 * enabled connector's `diagnose()` hook in parallel and returns
 * per-connector status. The response reveals which connectors are
 * active and their raw error messages (fingerprinting risk), so this
 * path requires admin auth. Use for internal monitoring (Grafana,
 * Healthchecks.io) behind a Bearer token.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const deep = url.searchParams.get("deep") === "1";

  if (!deep) {
    return Response.json({ ok: true, version: VERSION });
  }

  const authError = await checkAdminAuth(request);
  if (authError) return authError;

  const registry = resolveRegistry();
  const enabled = registry.filter((p) => p.enabled);

  // Per-connector timeout — a single flaky upstream (Google token endpoint
  // taking 30s) must not block the whole health check past Vercel's 60s
  // function limit. 5s per connector × up to 13 connectors is still well
  // under the overall budget because the calls run in parallel.
  const PER_CONNECTOR_TIMEOUT_MS = 5_000;

  const checks = await Promise.all(
    enabled.map(async (p) => {
      const start = Date.now();
      if (!p.manifest.diagnose) {
        return {
          connector: p.manifest.id,
          label: p.manifest.label,
          ok: true,
          message: "no diagnose() hook",
          durationMs: 0,
        };
      }
      try {
        const diag = await withTimeout(
          p.manifest.diagnose(),
          PER_CONNECTOR_TIMEOUT_MS,
          `${p.manifest.id} diagnose()`
        );
        return {
          connector: p.manifest.id,
          label: p.manifest.label,
          ok: diag.ok,
          message: diag.message,
          durationMs: Date.now() - start,
        };
      } catch (err) {
        return {
          connector: p.manifest.id,
          label: p.manifest.label,
          ok: false,
          message: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - start,
        };
      }
    })
  );

  const degraded = checks.filter((c) => !c.ok);
  const allDown = checks.length > 0 && degraded.length === checks.length;
  const overall = allDown ? "down" : degraded.length > 0 ? "degraded" : "ok";

  // MEDIUM-2: Write health sample directly to KV with a dedicated key pattern.
  // This bypasses the LogStore entirely — avoids loading all logs then filtering.
  // Key format: `health:sample:<timestamp>` for efficient prefix-based listing.
  //
  // SEC-01b (v0.10): tenant-scoped via getContextKVStore + 7-day TTL to
  // stop unbounded key growth. Pre-v0.10, samples lived globally under
  // `health:sample:<ts>` with no TTL.
  const connectorMap: Record<string, { ok: boolean; latencyMs: number }> = {};
  for (const c of checks) {
    connectorMap[c.connector] = { ok: c.ok, latencyMs: c.durationMs };
  }
  const sampleTs = Date.now();
  const sample = { ts: sampleTs, overall, connectors: connectorMap };
  const HEALTH_SAMPLE_TTL_SECONDS = 7 * 24 * 3600;
  const kv = getContextKVStore();
  void kv
    .set(`health:sample:${sampleTs}`, JSON.stringify(sample), HEALTH_SAMPLE_TTL_SECONDS)
    .catch((err: Error) => console.error("[Kebab MCP] Health sample write failed:", err.message));

  return Response.json({
    ok: degraded.length === 0,
    version: VERSION,
    checked: checks.length,
    degraded: degraded.length,
    connectors: checks,
  });
}
