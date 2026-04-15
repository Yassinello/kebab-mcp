import { VERSION } from "@/core/version";
import { resolveRegistry } from "@/core/registry";
import { checkAdminAuth } from "@/core/auth";
import { withTimeout } from "@/core/timeout";

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

  const authError = checkAdminAuth(request);
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

  return Response.json({
    ok: degraded.length === 0,
    version: VERSION,
    checked: checks.length,
    degraded: degraded.length,
    connectors: checks,
  });
}
