/**
 * v0.11 Migration — Tenant-scope every per-tenant KV surface.
 *
 * Phase 42 (TEN-01..06) moves 5 KV-writing surfaces off bare
 * `getKVStore()` and onto `getContextKVStore()`:
 *
 *   - `src/core/rate-limit.ts`      — rate limit buckets (TEN-01)
 *   - `src/core/log-store.ts`       — per-tenant log list (TEN-02)
 *   - `src/core/tool-toggles.ts`    — per-tenant tool disables (TEN-03)
 *   - `src/core/backup.ts`          — per-tenant export/import (TEN-04)
 *   - `app/api/config/context/route.ts` — per-tenant Claude persona (TEN-05)
 *
 * For each surface, the key body stays bare (`ratelimit:...`,
 * `tool:disabled:<name>`, `mymcp:context:inline`, `mymcp:logs`); the
 * TenantKVStore wrapper prefixes `tenant:<id>:` automatically based on
 * the current `requestContext` tenantId.
 *
 * During the transition window (2 releases), pre-v0.11 deploys still
 * have legacy un-wrapped keys (`ratelimit:<tenantId>:*`,
 * `tool:disabled:*`, `mymcp:context:*`, `mymcp:logs`). `dualReadKV()`
 * lets the migrated callers read those legacy values on the first
 * post-v0.11 read; writes always go to the new (wrapped) key. Legacy
 * keys are NOT deleted until v0.13.
 *
 * ### Idempotency marker
 *
 * Per-tenant marker key: `tenant:<id>:migrations:v0.11-tenant-scope`
 * (or `migrations:v0.11-tenant-scope` for null tenant). Once set to a
 * JSON payload with `status: "completed"`, the migration short-circuits
 * for that tenant. Each tenant dual-reads until its own first
 * post-v0.11 request completes the shim.
 *
 * ### Safety
 *
 * This module never throws on KV failure — it logs via
 * `getLogger("MIGRATION")` (Phase 45 QA-02 hygiene precedent) and
 * returns silently. Never block boot on a best-effort inventory step.
 */

import { getKVStore, kvScanAll, type KVStore } from "../kv-store";
import { getCurrentTenantId } from "../request-context";
import { withTenantPrefix } from "../tenant";
import { getLogger } from "../logging";
import { toMsg } from "../error-utils";

const migrationLog = getLogger("MIGRATION");

const MIGRATION_KEY_BASE = "migrations:v0.11-tenant-scope";

/**
 * Prefixes the shim counts during the inventory step. Each migrated
 * caller dual-reads its own legacy key shape via `dualReadKV(kv,
 * newKey, legacyKey)` — the shim does not rewrite or copy keys.
 *
 * Note: `mymcp:logs` is a single key, not a prefix. It's included
 * here for inventory-counting symmetry with the other 3 prefixes so
 * operators see a complete picture in the first-boot log line.
 */
export const LEGACY_KEY_PREFIXES: readonly string[] = Object.freeze([
  "ratelimit:",
  "tool:disabled:",
  "mymcp:context:",
  "mymcp:logs",
]);

/**
 * Read-through helper: prefer `newKey`, fall back to `legacyKey`.
 *
 * Pure helper — no writes, no side effects. The caller is responsible
 * for write-through to the new key (pattern: read via `dualReadKV`,
 * compute next value, `kv.set(newKey, nextValue)`). Keeping the helper
 * read-only lets tests isolate cases + keeps the atomic `incr` code
 * path in rate-limit.ts simple.
 *
 * Returns `null` (not `undefined`, not throw) when both keys are
 * missing. This matches the `KVStore.get()` contract.
 *
 * @param kv — the tenant-wrapped KV store (usually `getContextKVStore()`)
 * @param newKey — the new (unwrapped; TenantKVStore prefixes it) key
 * @param legacyKey — the old un-wrapped key (raw, pre-TenantKVStore shape)
 */
export async function dualReadKV(
  kv: KVStore,
  newKey: string,
  legacyKey: string
): Promise<string | null> {
  const newValue = await kv.get(newKey);
  if (newValue !== null) return newValue;
  // Fall back to legacy key. NOTE: on a TenantKVStore the legacy key
  // will be wrapped again — callers that pass a RAW (un-prefixed) KV
  // reference for legacy reads should do so deliberately. For in-tenant
  // dual-reads the legacy key shape often embeds the tenantId directly
  // (e.g. `ratelimit:alpha:mcp:...`), which means the wrapping would
  // produce `tenant:alpha:ratelimit:alpha:...` — still unique, still
  // safe, but distinct from the pre-v0.11 shape. Callers that need raw
  // legacy access should bypass the tenant wrapper via `getKVStore()`
  // (allowlisted) + explicit handling.
  return kv.get(legacyKey);
}

// In-process per-tenant flag to gate re-runs within the same process.
// Map key = tenantId or "null" (null-tenant sentinel).
const migrationStartedPerTenant = new Set<string>();

/**
 * Idempotent, per-tenant, fire-and-forget on first boot.
 *
 * Inventory-only: counts legacy keys for operator visibility (logs
 * once at INFO level), sets a per-tenant marker, returns. Does NOT
 * copy keys — dual-read handles the transition window, and wholesale
 * copy would race with live writes.
 *
 * Safe to call from any long-lived handler entry point after a
 * requestContext.run has set the tenantId. Logs once per tenant, then
 * does nothing on subsequent calls in the same process.
 */
export async function runV011TenantScopeMigration(): Promise<void> {
  const tenantKey = getCurrentTenantId() ?? "__null__";
  if (migrationStartedPerTenant.has(tenantKey)) return;
  migrationStartedPerTenant.add(tenantKey);

  try {
    const kv = getKVStore();
    const tenantId = getCurrentTenantId();
    const markerKey = withTenantPrefix(MIGRATION_KEY_BASE, tenantId);

    const already = await kv.get(markerKey);
    if (already && tryParseStatus(already) === "completed") return;

    // Count legacy keys for operator visibility. Each count is
    // best-effort — a failing scan must not block.
    const counts: Record<string, number> = {};
    for (const prefix of LEGACY_KEY_PREFIXES) {
      try {
        // `mymcp:logs` is a single exact key; others are prefixes.
        if (prefix === "mymcp:logs") {
          const v = await kv.get(prefix);
          counts[prefix] = v !== null ? 1 : 0;
        } else {
          const keys = await kvScanAll(kv, `${prefix}*`);
          // Filter out already-tenant-wrapped entries — the shim only
          // cares about legacy un-wrapped keys.
          counts[prefix] = keys.filter((k) => !k.startsWith("tenant:")).length;
        }
      } catch {
        counts[prefix] = -1; // sentinel for "scan unsupported / failed"
      }
    }

    await kv.set(
      markerKey,
      JSON.stringify({
        status: "completed",
        at: new Date().toISOString(),
        tenantId,
        legacyCounts: counts,
      })
    );

    const total = Object.values(counts).filter((n) => n > 0).length;
    if (total > 0) {
      const summary = Object.entries(counts)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${n} legacy ${k}*`)
        .join(", ");
      migrationLog.info(
        `v0.11-tenant-scope: noted ${summary} keys served via dual-read (tenant=${tenantId ?? "null"})`
      );
    }
  } catch (err) {
    migrationLog.warn("v0.11-tenant-scope: skipped", {
      error: toMsg(err),
    });
  }
}

function tryParseStatus(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof parsed.status === "string") {
      return parsed.status;
    }
  } catch {
    // Legacy plain-string marker written by an older shim revision.
    if (raw === "completed") return "completed";
  }
  return null;
}

/** Test-only: clear the in-process started flag so tests can re-run. */
export function __resetV011MigrationForTests(): void {
  migrationStartedPerTenant.clear();
}
