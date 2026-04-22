import { createHash } from "node:crypto";
import { kvScanAll } from "./kv-store";
import { getContextKVStore, getCurrentTenantId } from "./request-context";
import { dualReadKV } from "./migrations/v0.11-tenant-scope";
import { getConfigInt, getConfig } from "./config-facade";
import { toMsg } from "./error-utils";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number; // unix ms
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

// ── HOST-05: in-memory-only rate-limit path (opt-in) ────────────────
//
// `MYMCP_RATE_LIMIT_INMEMORY=1` forces the limiter to use this
// in-process Map instead of the KV backend. UNSAFE across replicas —
// each process holds its own counter map — so it is NOT the default.
// Intended for:
//   - single-process dev/test setups that want deterministic
//     non-KV behavior
//   - pure unit tests that do not want to touch the filesystem
// The normal path (flag unset / any other value) uses `getKVStore()`
// which auto-selects Upstash or FilesystemKV; both converge counters
// across replicas via KV. See docs/HOSTING.md §"Rate limiting".
const inMemoryBuckets = new Map<string, { count: number; resetAt: number }>();

function checkRateLimitInMemory(key: string, limit: number, resetAt: number): RateLimitResult {
  const now = Date.now();
  const entry = inMemoryBuckets.get(key);
  if (!entry || now >= entry.resetAt) {
    // Fresh bucket (or the previous one has expired).
    inMemoryBuckets.set(key, { count: 1, resetAt });
    return { allowed: true, remaining: Math.max(0, limit - 1), resetAt };
  }
  entry.count += 1;
  if (entry.count > limit) {
    return { allowed: false, remaining: 0, resetAt: entry.resetAt };
  }
  return { allowed: true, remaining: Math.max(0, limit - entry.count), resetAt: entry.resetAt };
}

/**
 * Test-only: clear the in-memory rate-limit bucket map.
 *
 * Exposed under a `__` prefix so callers understand this is not part
 * of the public API. Used by `tests/integration/multi-host.test.ts` to
 * reset state between scenarios.
 */
export function __resetInMemoryRateLimitForTests(): void {
  inMemoryBuckets.clear();
}

/**
 * Sliding-window (fixed per-minute bucket) rate limiter.
 *
 * **Phase 42 (TEN-01) — key-shape migration:**
 *
 * Old shape (pre-v0.11):
 *   `ratelimit:<tenantId>:<scope>:<idHash>:<bucket>`
 *   — tenantId embedded in the key body; written via bare `getKVStore()`.
 *
 * New shape (v0.11+):
 *   `ratelimit:<scope>:<idHash>:<bucket>` (key body),
 *   with TenantKVStore auto-prefixing to
 *   `tenant:<id>:ratelimit:<scope>:<idHash>:<bucket>` when a tenant
 *   context is active. Null-tenant keys stay at `ratelimit:...` (no
 *   prefix), matching the null-tenant passthrough in TenantKVStore.
 *
 * Legacy keys are read transparently via `dualReadKV()` during the
 * 2-release transition window. Writes ALWAYS go to the new (wrapped)
 * key. Legacy-key DELETE is deferred to v0.13.
 *
 * **Atomic-path caveat:** the atomic `incr` branch does NOT invoke
 * `dualReadKV`. Carrying over a legacy bucket into the atomic pipeline
 * would require a read-then-incr sequence and defeat the atomicity
 * guarantee that eliminates the get-then-set race. In the common case
 * (Upstash in prod), a tenant with a legacy bucket gets a fresh count
 * starting at 1 on the first post-v0.11 request within a 60-second
 * bucket window. That is transient over-leniency — the bucket expires
 * within 60 s and subsequent windows are clean.
 *
 * **Legacy path:** the get-then-set branch is kept only for stores
 * that don't implement `incr` (none in production). It invokes
 * `dualReadKV` so legacy counts carry over correctly.
 */
export async function checkRateLimit(
  identifier: string,
  options: { scope?: string; limit?: number } = {}
): Promise<RateLimitResult> {
  const scope = options.scope || "mcp";
  const defaultLimit = Math.max(1, getConfigInt("MYMCP_RATE_LIMIT_RPM", 60));
  const limit = options.limit ?? defaultLimit;
  const now = Date.now();
  const windowMs = 60_000;
  const minuteBucket = Math.floor(now / windowMs);
  const resetAt = (minuteBucket + 1) * windowMs;
  const idHash = hashToken(identifier);
  const tenantId = getCurrentTenantId();

  // Key body (no tenantId embedded). TenantKVStore prefixes automatically.
  const key = `ratelimit:${scope}:${idHash}:${minuteBucket}`;

  // Legacy key (pre-v0.11 shape). Read-only; used during dual-read.
  const legacyKey = legacyRateLimitKey(tenantId, scope, idHash, minuteBucket);

  // HOST-05: opt-in in-memory path. UNSAFE across replicas. Must be
  // checked BEFORE any KV resolution so dev/test setups that want a
  // pure in-process limiter never touch KV (filesystem or Upstash).
  // Composite in-memory key keeps tenants separate even without the
  // KV namespace wrapper.
  if (getConfig("MYMCP_RATE_LIMIT_INMEMORY") === "1") {
    const memKey = `${tenantId ?? "null"}:${key}`;
    return checkRateLimitInMemory(memKey, limit, resetAt);
  }

  const kv = getContextKVStore();

  try {
    // Atomic path — preferred whenever incr is implemented. TTL is set
    // to 2× the window so the bucket always outlives its own relevance
    // even under clock skew, without accumulating forever. See the
    // "Atomic-path caveat" in the function doc-comment: this branch
    // intentionally does NOT consult the legacy key; carrying a legacy
    // count into the atomic pipeline would defeat the atomicity
    // guarantee, and the 60-second bucket TTL bounds the staleness.
    if (typeof kv.incr === "function") {
      const count = await kv.incr(key, { ttlSeconds: Math.ceil((windowMs / 1000) * 2) });
      // v0.6 MED-1: FilesystemKV.incr does not honor TTL (dev-only path),
      // so stale buckets accumulate in `data/kv.json` forever without a
      // sweep. Upstash handles eviction natively via EXPIRE. We only
      // trigger the sweep on `count === 1` (fresh bucket boundary) to
      // avoid doing it on every request.
      if (kv.kind === "filesystem" && count === 1) {
        // fire-and-forget OK: janitor for stale bucket keys; no response dependency
        void sweepOldBuckets(scope, idHash, minuteBucket);
      }
      if (count > limit) {
        return { allowed: false, remaining: 0, resetAt };
      }
      return { allowed: true, remaining: Math.max(0, limit - count), resetAt };
    }

    // Legacy fallback (stores without incr). Racy but bounded.
    // dualReadKV carries legacy-bucket counts forward during the
    // v0.11 transition window.
    const raw = await dualReadKV(kv, key, legacyKey);
    const count = raw ? parseInt(raw, 10) : 0;

    if (count >= limit) {
      return { allowed: false, remaining: 0, resetAt };
    }

    // Write-through ALWAYS goes to the new (wrapped) key.
    await kv.set(key, String(count + 1));

    if (count === 0) {
      // fire-and-forget OK: janitor for stale bucket keys; no response dependency
      void sweepOldBuckets(scope, idHash, minuteBucket);
    }

    return { allowed: true, remaining: limit - count - 1, resetAt };
  } catch (err) {
    // Fail open: KV errors must not block legitimate requests
    console.warn("[Kebab MCP] Rate limit KV error (failing open):", toMsg(err));
    return { allowed: true, remaining: -1, resetAt };
  }
}

/**
 * Compute the pre-v0.11 rate-limit KV key for dual-read.
 *
 * Exported so the v0.11 migration shim's inventory step can count
 * legacy buckets via `kvScanAll(getKVStore(), "ratelimit:*")` and
 * detect un-prefixed entries (not starting with `tenant:`).
 */
export function legacyRateLimitKey(
  tenantId: string | null,
  scope: string,
  idHash: string,
  minuteBucket: number
): string {
  return `ratelimit:${tenantId ?? "global"}:${scope}:${idHash}:${minuteBucket}`;
}

/**
 * Best-effort bucket cleanup. Scans within the current tenant's
 * namespace (via `getContextKVStore()`) and deletes anything older
 * than the current minute. Failures are swallowed.
 */
async function sweepOldBuckets(
  scope: string,
  idHash: string,
  currentBucket: number
): Promise<void> {
  try {
    const kv = getContextKVStore();
    const prefix = `ratelimit:${scope}:${idHash}:`;
    const keys = await kvScanAll(kv, `${prefix}*`);
    for (const key of keys) {
      const bucketStr = key.slice(prefix.length);
      const bucket = parseInt(bucketStr, 10);
      if (Number.isFinite(bucket) && bucket < currentBucket) {
        await kv.delete(key);
      }
    }
  } catch {
    // ignore — cleanup is best-effort
  }
}
