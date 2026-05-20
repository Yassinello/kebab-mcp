/**
 * credential-store.ts — KV-backed credential persistence.
 *
 * On Vercel, the filesystem is read-only. When Upstash is configured,
 * connector credentials (GITHUB_PAT, SLACK_BOT_TOKEN, etc.) are saved
 * to KV under `cred:<KEY>` keys. On cold start, `hydrateCredentialsFromKV()`
 * loads them into an in-process snapshot (NOT process.env — SEC-02) so
 * that tool handlers reading via `getCredential()` (or through the
 * back-compat boot-env snapshot in request-context.ts) see the values.
 *
 * Key prefix: `cred:` — distinct from `settings:` (user config).
 *
 * SEC-02: pre-v0.10, saveCredentialsToKV() and hydrateCredentialsFromKV()
 * wrote to the process-global `process.env`. That was racy on warm
 * lambdas (tenant A's save mutated state visible to tenant B's
 * concurrent tool call). Now credentials flow through
 * `runWithCredentials(creds, ...)` at the request entry instead.
 */

import { kvScanAll } from "./kv-store";
import { getContextKVStore, getCurrentTenantId } from "./request-context";
import { hasUpstashCreds } from "./upstash-env";
import { getConfig } from "./config-facade";
import { toMsg } from "./error-utils";

export const CRED_PREFIX = "cred:";

/** Whether Upstash is configured (real KV persistence). */
export function isUpstashConfigured(): boolean {
  return hasUpstashCreds();
}

/** Whether Vercel API is configured (env var write via API). */
export function isVercelApiConfigured(): boolean {
  return Boolean(getConfig("VERCEL_TOKEN")?.trim() && getConfig("VERCEL_PROJECT_ID")?.trim());
}

/**
 * Detect the best storage backend for credentials.
 *
 * - "upstash"     — Upstash KV is available (instant, no redeploy)
 * - "vercel-api"  — Vercel token configured (writes via API, needs redeploy)
 * - "filesystem"  — local/Docker (writes to .env)
 * - "none"        — Vercel without Upstash or VERCEL_TOKEN
 */
export type StorageBackend = "upstash" | "vercel-api" | "filesystem" | "none";

export function detectStorageBackend(): StorageBackend {
  if (isUpstashConfigured()) return "upstash";
  if (getConfig("VERCEL") === "1") {
    if (isVercelApiConfigured()) return "vercel-api";
    return "none";
  }
  return "filesystem";
}

// ── Per-tenant credential snapshot (SEC-02 + HIGH-4) ──────────────────
//
// This replaces the pre-v0.10 practice of mutating process.env at
// request time. `hydrateCredentialsFromKV()` writes into the snapshot
// for the CURRENT tenant, and the transport wraps each request in
// `runWithCredentials(...)` so tool handlers see the current hydrated
// state via `getCredential()`.
//
// HIGH-4: the snapshot + hydration promise are keyed by tenant id. They
// used to be process-global, which leaked credentials across tenants on
// warm lambdas: the first tenant to trigger hydration on a cold lambda
// locked in its `cred:*` values (read via the tenant-scoped
// `getContextKVStore()`), and every subsequent tenant reused that same
// snapshot. Now each tenant gets its own memoized hydrate + snapshot, so
// tenant B never sees tenant A's connector tokens.
//
// The null-tenant (default / single-tenant deploy) path uses the
// `NULL_TENANT_KEY` sentinel and is unchanged behaviorally.
//
// Never mutated by cross-tenant writes — `saveCredentialsToKV` updates
// only the calling tenant's snapshot, mirroring its tenant-scoped KV
// write.

const NULL_TENANT_KEY = "__null__";

function tenantSnapshotKey(): string {
  return getCurrentTenantId() ?? NULL_TENANT_KEY;
}

const hydratedSnapshots = new Map<string, Record<string, string>>();

function getSnapshotForCurrentTenant(): Record<string, string> {
  const key = tenantSnapshotKey();
  let snap = hydratedSnapshots.get(key);
  if (!snap) {
    snap = {};
    hydratedSnapshots.set(key, snap);
  }
  return snap;
}

/**
 * Snapshot exposed for the transport layer to inject via
 * runWithCredentials. Returns the CURRENT tenant's snapshot (HIGH-4).
 */
export function getHydratedCredentialSnapshot(): Record<string, string> {
  return getSnapshotForCurrentTenant();
}

/**
 * Save credentials to KV under `cred:<KEY>` keys.
 *
 * SEC-02 change: no longer mutates `process.env`. The credentials
 * become visible to subsequent requests once a cold lambda picks them
 * up via hydrate, or once the operator issues a redeploy. Warm-lambda
 * callers in the same process will also see them on the next
 * hydrate cycle (the `hydrated` flag is reset by callers that know
 * they just saved).
 */
export async function saveCredentialsToKV(vars: Record<string, string>): Promise<void> {
  const kv = getContextKVStore();
  const snapshot = getSnapshotForCurrentTenant();
  const writes: Promise<void>[] = [];
  for (const [key, value] of Object.entries(vars)) {
    if (value) {
      writes.push(kv.set(`${CRED_PREFIX}${key}`, value));
      // Also update the in-process snapshot so the current warm lambda's
      // next request sees the new value via getCredential(). HIGH-4: the
      // write lands in the CURRENT tenant's snapshot, matching the
      // tenant-scoped KV write above — never a process-global snapshot.
      snapshot[key] = value;
    }
  }
  await Promise.all(writes);
}

// ── Hydration ──────────────────────────────────────────────────────

// Memoized promise instead of a boolean flag. The pre-fix `let hydrated`
// pattern set the flag *before* awaiting the KV fetch — so a transient
// failure (timeout, network blip) left the lambda permanently in a
// "claims hydrated, snapshot empty" state. Every subsequent request on
// that lambda then read missing-env for connectors whose credentials
// were actually in KV. Memoizing the promise (and clearing it on
// failure) lets concurrent callers share one in-flight fetch while
// allowing the next caller to retry after a failure.
//
// HIGH-4: keyed per-tenant so tenant A's in-flight hydrate doesn't get
// reused by tenant B (which would serve A's credentials).
const hydrationPromises = new Map<string, Promise<void>>();

/**
 * Load all `cred:*` keys from KV into the in-process snapshot.
 * Runs once per process on success (idempotent). Skips keys already in
 * `process.env` from boot — boot env vars (Vercel dashboard, .env)
 * take precedence.
 *
 * SEC-02: does NOT mutate process.env. Tool handlers read through
 * `getCredential(envKey)` which consults (a) the request-scoped
 * credentials map, (b) the boot env snapshot, (c) the hydrated
 * snapshot — in that priority order.
 *
 * Called lazily from the transport entry path and from
 * `resolveRegistryAsync()` (dashboard render). On a failed KV fetch the
 * cached promise is dropped so the next caller retries instead of
 * inheriting a poisoned cache.
 */
export async function hydrateCredentialsFromKV(): Promise<void> {
  const tenantKey = tenantSnapshotKey();
  const existing = hydrationPromises.get(tenantKey);
  if (existing) return existing;

  const snapshot = getSnapshotForCurrentTenant();
  const promise = (async () => {
    const kv = getContextKVStore();
    // Only hydrate if we have real KV (Upstash) — ephemeral /tmp KV
    // on Vercel without Upstash doesn't survive cold starts anyway.
    if (kv.kind !== "upstash") return;

    const keys = await kvScanAll(kv, `${CRED_PREFIX}*`);
    if (keys.length === 0) return;

    const values = kv.mget ? await kv.mget(keys) : await Promise.all(keys.map((k) => kv.get(k)));

    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (!k) continue;
      const envKey = k.slice(CRED_PREFIX.length);
      const value = values[i];
      // Don't overwrite existing env vars — boot env takes precedence.
      if (value && !getConfig(envKey)) {
        snapshot[envKey] = value;
      }
    }
    if (keys.length > 0) {
      console.log(
        `[Kebab MCP] Hydrated ${keys.length} credential(s) from KV (SEC-02 snapshot, tenant=${tenantKey})`
      );
    }
  })().catch((err: unknown) => {
    console.warn("[Kebab MCP] Failed to hydrate credentials from KV:", toMsg(err));
    // Drop the cached promise so the next call retries. Without this,
    // a transient KV blip would lock the lambda into "snapshot empty"
    // forever, surfacing as "missing env" for every connector whose
    // credentials only live in KV.
    hydrationPromises.delete(tenantKey);
  });
  hydrationPromises.set(tenantKey, promise);
  return promise;
}

/**
 * Reset all per-tenant hydration state. Test-only.
 */
export function resetHydrationFlag(): void {
  hydrationPromises.clear();
  hydratedSnapshots.clear();
}

/**
 * Clear the current tenant's hydration promise so hydration re-runs on
 * the next resolveRegistry. Called after credentials are saved to KV to
 * ensure they're visible. HIGH-4: scoped to the calling tenant — a
 * dashboard save under tenant A must not force tenant B to re-hydrate.
 */
export function resetCredentialHydration(): void {
  hydrationPromises.delete(tenantSnapshotKey());
}

/**
 * Read all credential keys from KV (unmasked).
 * Used by the .env export endpoint.
 */
export async function readAllCredentialsFromKV(): Promise<Record<string, string>> {
  const kv = getContextKVStore();
  // On Vercel without Upstash the KV is an ephemeral /tmp filesystem —
  // reading from it is useless (data doesn't survive cold starts).
  if (getConfig("VERCEL") === "1" && kv.kind !== "upstash") return {};

  const keys = await kvScanAll(kv, `${CRED_PREFIX}*`);
  if (keys.length === 0) return {};

  const values = kv.mget ? await kv.mget(keys) : await Promise.all(keys.map((k) => kv.get(k)));

  const result: Record<string, string> = {};
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (!k) continue;
    const envKey = k.slice(CRED_PREFIX.length);
    const value = values[i];
    if (value) result[envKey] = value;
  }
  return result;
}
