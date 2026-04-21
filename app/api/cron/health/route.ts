import { resolveRegistry } from "@/core/registry";
import {
  composeRequestPipeline,
  rehydrateStep,
  authStep,
  rateLimitStep,
  type PipelineContext,
} from "@/core/pipeline";

/**
 * Hourly cron health check (Vercel Cron).
 * Runs diagnose() on all enabled packs.
 * If MYMCP_ERROR_WEBHOOK_URL is set, alerts on degraded packs.
 *
 * Auth (fail-closed) — now enforced by `authStep('cron')`:
 * - If CRON_SECRET is set → must match Authorization: Bearer <secret>
 * - If CRON_SECRET is unset → only loopback requests are allowed
 *   (via authStep's fallback, gated on MYMCP_TRUST_URL_HOST etc.)
 *
 * v0.11 Phase 41: pipeline provides rehydrate + cron-auth + rate-limit.
 * The legacy `BOOTSTRAP_EXEMPT:` marker was removed — rehydrate now runs
 * via the pipeline's `rehydrateStep`.
 *
 * PIPE-04 rate-limit scope: 120/min keyed by sha256(CRON_SECRET). A
 * legit once-per-minute Vercel Cron call will never hit 120; a
 * misconfigured cron or attacker cannot exhaust quota by spraying from
 * many IPs because the key is per-deployment-per-secret.
 */
async function cronHealthHandler(_ctx: PipelineContext): Promise<Response> {
  const registry = resolveRegistry();
  const results: { pack: string; ok: boolean; message: string }[] = [];

  for (const p of registry) {
    if (!p.enabled || !p.manifest.diagnose) continue;
    try {
      const diag = await p.manifest.diagnose();
      results.push({ pack: p.manifest.label, ok: diag.ok, message: diag.message });
    } catch (err) {
      results.push({
        pack: p.manifest.label,
        ok: false,
        message: err instanceof Error ? err.message : "Check failed",
      });
    }
  }

  const degraded = results.filter((r) => !r.ok);

  // Alert via webhook if any pack is degraded.
  // Phase 41 T20/POST-V0.10-AUDIT §A.1 fold-in: convert the historical
  // `.catch(() => {})` silent swallow to a log-then-swallow so the
  // `no-silent-swallows` tripwire stays green on this file.
  if (degraded.length > 0) {
    const webhookUrl = process.env.MYMCP_ERROR_WEBHOOK_URL;
    if (webhookUrl) {
      try {
        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: `[Kebab MCP Health] ${degraded.length} pack(s) degraded: ${degraded.map((d) => `${d.pack}: ${d.message}`).join("; ")}`,
            packs: degraded,
          }),
        });
      } catch (err) {
        // silent-swallow-ok: error-webhook alert is best-effort observability; a failed alert must not break the cron health response
        console.info(
          `[Kebab MCP] error-webhook alert failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  return Response.json({
    ok: degraded.length === 0,
    checked: results.length,
    degraded: degraded.length,
    results,
  });
}

export const GET = composeRequestPipeline(
  [
    rehydrateStep,
    authStep("cron"),
    rateLimitStep({ scope: "cron", keyFrom: "cronSecretTokenId", limit: 120 }),
  ],
  cronHealthHandler
);
