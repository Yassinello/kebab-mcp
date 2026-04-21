// BOOTSTRAP_EXEMPT: Vercel cron endpoint authenticated via CRON_SECRET; each enabled connector handles its own state reads via diagnose(); rehydrate not needed on this path and would add cold-start latency to scheduled probes.
import { resolveRegistry } from "@/core/registry";
import { isLoopbackRequest } from "@/core/request-utils";

/**
 * Hourly cron health check (Vercel Cron).
 * Runs diagnose() on all enabled packs.
 * If MYMCP_ERROR_WEBHOOK_URL is set, alerts on degraded packs.
 *
 * Auth (fail-closed):
 * - If CRON_SECRET is set → must match Authorization: Bearer <secret>
 * - If CRON_SECRET is unset → only loopback requests are allowed, so the
 *   endpoint can't be publicly called by an attacker to probe which
 *   connectors are configured (the response reveals connector labels and
 *   error messages).
 * - Vercel Cron also injects `x-vercel-cron: 1` header; we accept it as a
 *   secondary path when deployed on Vercel.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret) {
    // Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` when the
    // env var is configured — that's the documented contract, no
    // separate header to check.
    if (authHeader !== `Bearer ${cronSecret}`) {
      return new Response("Unauthorized", { status: 401 });
    }
  } else {
    // Fail-closed when CRON_SECRET is not configured.
    if (!isLoopbackRequest(request)) {
      return new Response("CRON_SECRET not configured — cron endpoint is locked to loopback", {
        status: 503,
      });
    }
  }

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

  // Alert via webhook if any pack is degraded
  if (degraded.length > 0) {
    const webhookUrl = process.env.MYMCP_ERROR_WEBHOOK_URL;
    if (webhookUrl) {
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: `[Kebab MCP Health] ${degraded.length} pack(s) degraded: ${degraded.map((d) => `${d.pack}: ${d.message}`).join("; ")}`,
          packs: degraded,
        }),
      }).catch(() => {});
    }
  }

  return Response.json({
    ok: degraded.length === 0,
    checked: results.length,
    degraded: degraded.length,
    results,
  });
}
