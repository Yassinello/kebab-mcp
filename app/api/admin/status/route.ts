import { checkAdminAuth } from "@/core/auth";
import { resolveRegistry } from "@/core/registry";
import { getInstanceConfig } from "@/core/config";
import { getRecentLogs } from "@/core/logging";

/**
 * Private admin status endpoint — requires ADMIN_AUTH_TOKEN.
 * Returns detailed pack diagnostics, tool counts, config, and recent logs.
 * Runs diagnose() on enabled packs to verify credentials actually work.
 */
export async function GET(request: Request) {
  const authError = checkAdminAuth(request);
  if (authError) return authError;

  const registry = resolveRegistry();
  const config = getInstanceConfig();
  const logs = getRecentLogs();

  // Run diagnose() on enabled packs that have it
  const packs = await Promise.all(
    registry.map(async (p) => {
      let diagnosis: { ok: boolean; message: string } | undefined;
      if (p.enabled && p.manifest.diagnose) {
        try {
          diagnosis = await p.manifest.diagnose();
        } catch {
          diagnosis = { ok: false, message: "Diagnose check failed" };
        }
      }

      return {
        id: p.manifest.id,
        label: p.manifest.label,
        description: p.manifest.description,
        enabled: p.enabled,
        reason: p.reason,
        toolCount: p.manifest.tools.length,
        diagnosis,
        tools: p.manifest.tools.map((t) => ({
          name: t.name,
          description: t.description,
        })),
      };
    })
  );

  const totalTools = registry
    .filter((p) => p.enabled)
    .reduce((sum, p) => sum + p.manifest.tools.length, 0);

  return Response.json({
    version: "1.0.0",
    packs,
    totalTools,
    config: {
      timezone: config.timezone,
      locale: config.locale,
      displayName: config.displayName,
    },
    recentLogs: logs.slice(0, 20).map((l) => ({
      tool: l.tool,
      status: l.status,
      durationMs: l.durationMs,
      timestamp: l.timestamp,
      error: l.error,
    })),
    _ephemeral: "Logs are in-memory and reset on cold start.",
  });
}
