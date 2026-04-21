import { NextResponse } from "next/server";
import { checkAdminAuth } from "@/core/auth";
import { getKVStore, kvScanAll } from "@/core/kv-store";
import { getTenantId } from "@/core/tenant";
import { withBootstrapRehydrate } from "@/core/with-bootstrap-rehydrate";

interface RateLimitScope {
  scope: string;
  current: number;
  max: number;
  tenantId: string;
  percentage: number;
}

/**
 * GET /api/admin/rate-limits
 *
 * Lists active rate limit buckets from KV, grouped by scope.
 * Auth-gated via admin token.
 *
 * KV key format: `ratelimit:{tenantId}:{scope}:{idHash}:{minuteBucket}`
 *
 * SEC-01b: filters scan results by the admin's tenant. Rate-limit
 * keys themselves embed the tenant in the key structure (written via
 * the allowlisted `getKVStore()` in rate-limit.ts), so the scan is
 * global but the returned rows are filtered to the admin's tenant.
 * An explicit `admin:global` future header could opt into the old
 * cross-tenant view; not exposed in v0.10.
 */
async function getHandler(request: Request) {
  const authError = await checkAdminAuth(request);
  if (authError) return authError;

  let requesterTenant: string | null;
  try {
    requesterTenant = getTenantId(request);
  } catch {
    return NextResponse.json({ error: "Invalid tenant header" }, { status: 400 });
  }
  const tenantFilter = requesterTenant ?? "default";

  const defaultLimit = Math.max(1, parseInt(process.env.MYMCP_RATE_LIMIT_RPM ?? "60", 10) || 60);

  try {
    const kv = getKVStore();
    const keys = await kvScanAll(kv, "ratelimit:*");

    if (keys.length === 0) {
      return NextResponse.json({ scopes: [] });
    }

    // Current minute bucket — only count active buckets
    const now = Date.now();
    const windowMs = 60_000;
    const currentBucket = Math.floor(now / windowMs);

    // Filter to current-bucket keys only, then batch-read values
    const groups = new Map<string, { scope: string; tenantId: string; current: number }>();

    // Pre-filter keys to current bucket AND to the requesting tenant.
    const activeKeys: { key: string; tenantId: string; scope: string }[] = [];
    for (const key of keys) {
      const parts = key.split(":");
      if (parts.length < 5) continue;
      const bucketStr = parts[parts.length - 1];
      const bucket = parseInt(bucketStr, 10);
      if (!Number.isFinite(bucket) || bucket !== currentBucket) continue;
      const keyTenant = parts[1];
      // SEC-01b: only the current admin's tenant gets surfaced.
      if (keyTenant !== tenantFilter) continue;
      activeKeys.push({ key, tenantId: keyTenant, scope: parts[2] });
    }

    // Batch-read all active key values via mget
    let values: (string | null)[];
    if (activeKeys.length > 0 && typeof kv.mget === "function") {
      values = await kv.mget(activeKeys.map((k) => k.key));
    } else {
      values = await Promise.all(activeKeys.map((k) => kv.get(k.key)));
    }

    for (let i = 0; i < activeKeys.length; i++) {
      const { tenantId, scope } = activeKeys[i];
      const raw = values[i];
      const count = raw ? parseInt(raw, 10) || 0 : 0;
      if (count === 0) continue;

      const groupKey = `${tenantId}:${scope}`;
      const existing = groups.get(groupKey);
      if (existing) {
        existing.current += count;
      } else {
        groups.set(groupKey, { scope, tenantId, current: count });
      }
    }

    const scopes: RateLimitScope[] = [];
    for (const group of groups.values()) {
      const max = defaultLimit;
      scopes.push({
        scope: group.scope,
        current: group.current,
        max,
        tenantId: group.tenantId,
        percentage: Math.round((group.current / max) * 100),
      });
    }

    // Sort by percentage descending
    scopes.sort((a, b) => b.percentage - a.percentage);

    return NextResponse.json({ scopes });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to read rate limits" },
      { status: 500 }
    );
  }
}

export const GET = withBootstrapRehydrate(getHandler);
