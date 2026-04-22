// BOOTSTRAP_EXEMPT: public liveness endpoint — cannot block on KV rehydrate; handler has a hard 1.5s budget. Bootstrap state is surfaced as a read-only field (`bootstrap.state`) and never mutated here.
// PIPELINE_EXEMPT: public liveness endpoint with 1.5s hard budget; cannot afford pipeline overhead on the uptime-monitor hot path. `?deep=1` branch does admin-auth inline.
import { VERSION } from "@/core/version";
import { resolveRegistryAsync } from "@/core/registry";
import { checkAdminAuth } from "@/core/auth";
import { withTimeout } from "@/core/timeout";
import { getContextKVStore } from "@/core/request-context";
import { pingKV } from "@/core/kv-store";
import { getBootstrapState, getLastRehydrateAt } from "@/core/first-run";
import { getActiveDestructiveVars } from "@/core/env-safety";
import { getConfig } from "@/core/config-facade";
import { toMsg } from "@/core/error-utils";

/**
 * Public health endpoint.
 *
 * `GET /api/health` — liveness + lightweight observability (OBS-01, SAFE-02).
 * Returns:
 *   {
 *     ok,
 *     version,
 *     bootstrap: { state: "pending" | "active" | "error" },
 *     kv: { reachable, lastRehydrateAt: ISO | null },
 *     warnings?: [{ code, var, message }]   // omitted when empty
 *   }
 * No secrets, no env values, no tenant info. Hard-capped at 1.5 s total
 * so Vercel's uptime monitors never time out on a slow Upstash.
 *
 * `GET /api/health?deep=1` — admin-gated deep health check. Runs each
 * enabled connector's `diagnose()` hook in parallel and returns
 * per-connector status. The response reveals which connectors are
 * active and their raw error messages (fingerprinting risk), so this
 * path requires admin auth.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const deep = url.searchParams.get("deep") === "1";

  if (!deep) {
    // OBS-01 / SAFE-02: enriched public payload. Everything inside this
    // block has to finish in <1500 ms — use Promise.race / timeouts
    // defensively so a slow KV cannot hang a public liveness probe.
    const HEALTH_BUDGET_MS = 1500;
    const started = Date.now();
    const body: Record<string, unknown> = {
      ok: true,
      version: VERSION,
      bootstrap: { state: getBootstrapState() },
      kv: { reachable: false, lastRehydrateAt: null as string | null },
    };
    try {
      const kvWork = Promise.all([pingKV(), getLastRehydrateAt()]);
      const [kvStatus, lastRehydrate] = (await Promise.race([
        kvWork,
        new Promise<[{ reachable: boolean }, Date | null]>((_, reject) =>
          setTimeout(
            () => reject(new Error("health-budget-exceeded")),
            HEALTH_BUDGET_MS - (Date.now() - started)
          )
        ),
      ])) as [{ reachable: boolean }, Date | null];
      body.kv = {
        reachable: kvStatus.reachable,
        lastRehydrateAt: lastRehydrate ? lastRehydrate.toISOString() : null,
      };
    } catch {
      // Budget exceeded or KV backend unavailable. Report unreachable and
      // move on — liveness itself is still "ok" as long as the handler
      // returns a 200 within the budget.
      body.kv = { reachable: false, lastRehydrateAt: null };
    }

    // SAFE-02: surface destructive env vars that are active in an
    // environment they were not designed for. Only present when the
    // array is non-empty — keeps the happy-path payload minimal.
    const activeDestructive = getActiveDestructiveVars().filter((a) => !a.allowed);
    if (activeDestructive.length > 0) {
      body.warnings = activeDestructive.map((a) => ({
        code: "DESTRUCTIVE_ENV_VAR_ACTIVE",
        var: a.var.name,
        message: `${a.var.name} is set in a ${getConfig("NODE_ENV") || "unknown"} deployment; ${a.var.effect}`,
      }));
    }

    return Response.json(body);
  }

  const authError = await checkAdminAuth(request);
  if (authError) return authError;

  // PERF-01: lazy resolve — the deep-health path is already past the
  // 1.5s public-budget branch at this point (we are gated behind
  // admin auth with a 60s function budget). Awaiting the registry
  // is safe.
  const registry = await resolveRegistryAsync();
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
          message: toMsg(err),
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
  // fire-and-forget OK: deep-health sample is best-effort telemetry; caller returns the live response regardless
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
