import { checkAdminAuth } from "@/core/auth";
import { kvScanAll } from "@/core/kv-store";
import { getContextKVStore } from "@/core/request-context";
import { withBootstrapRehydrate } from "@/core/with-bootstrap-rehydrate";

/**
 * GET /api/admin/health-history — admin-gated.
 *
 * Returns health-check sample history from dedicated KV keys.
 * Each sample is written by the deep health check (`GET /api/health?deep=1`)
 * at `health:sample:<timestamp>`.
 *
 * MEDIUM-2: Reads directly from KV with prefix scan instead of loading
 * all LogStore entries and filtering. Much more efficient.
 *
 * SEC-01b (v0.10): tenant-scoped via getContextKVStore. An admin sees
 * only their own tenant's samples — cross-tenant leak closed.
 *
 * Query params:
 * - `days` — retention window (default: MYMCP_HEALTH_SAMPLE_RETENTION_DAYS or 7)
 */
async function getHandler(request: Request) {
  const authError = await checkAdminAuth(request);
  if (authError) return authError;

  const url = new URL(request.url);
  const defaultDays = parseInt(process.env.MYMCP_HEALTH_SAMPLE_RETENTION_DAYS || "7", 10);
  const days = Math.max(
    1,
    Math.min(parseInt(url.searchParams.get("days") || String(defaultDays), 10) || defaultDays, 90)
  );
  const cutoff = Date.now() - days * 86_400_000;

  const kv = getContextKVStore();
  const keys = await kvScanAll(kv, "health:sample:*");

  // Batch-read values via mget when available, else parallel gets
  const BATCH_SIZE = 50;
  interface HealthSample {
    ts: number;
    overall: string;
    connectors: Record<string, { ok: boolean; latencyMs: number }>;
  }
  const samples: HealthSample[] = [];

  for (let i = 0; i < keys.length; i += BATCH_SIZE) {
    const batch = keys.slice(i, i + BATCH_SIZE);
    const values =
      typeof kv.mget === "function"
        ? await kv.mget(batch)
        : await Promise.all(batch.map((k) => kv.get(k)));
    for (const raw of values) {
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as HealthSample;
        if (parsed.ts >= cutoff) {
          samples.push(parsed);
        }
      } catch {
        // skip malformed entries
      }
    }
  }

  // Sort chronologically (oldest first)
  samples.sort((a, b) => a.ts - b.ts);

  // Clean up old samples beyond retention (fire-and-forget)
  // With TTL on the write path, this is now defense in depth. Pre-v0.10
  // samples had no TTL and may linger until explicit cleanup.
  const staleKeys = keys.filter((k) => {
    const ts = parseInt(k.replace("health:sample:", ""), 10);
    return Number.isFinite(ts) && ts < cutoff;
  });
  if (staleKeys.length > 0) {
    Promise.all(staleKeys.map((k) => kv.delete(k))).catch(() => {});
  }

  return Response.json(samples);
}

export const GET = withBootstrapRehydrate(getHandler);
