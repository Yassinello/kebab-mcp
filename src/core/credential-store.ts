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
import { getContextKVStore } from "./request-context";
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

// ── Module-scope credential snapshot (SEC-02) ─────────────────────────
//
// This replaces the pre-v0.10 practice of mutating process.env at
// request time. `hydrateCredentialsFromKV()` writes into this snapshot,
// and the transport wraps each request in `runWithCredentials(...)` so
// tool handlers see the current hydrated state via `getCredential()`.
//
// Never mutated by user-driven writes (`saveCredentialsToKV`); those
// go straight to KV and the next cold lambda picks them up via
// hydrate. This is intentional: request-level isolation trumps
// "changes visible immediately in the current warm lambda".

let hydratedSnapshot: Record<string, string> = {};

/** Snapshot exposed for the transport layer to inject via runWithCredentials. */
export function getHydratedCredentialSnapshot(): Record<string, string> {
  return hydratedSnapshot;
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
  const writes: Promise<void>[] = [];
  for (const [key, value] of Object.entries(vars)) {
    if (value) {
      writes.push(kv.set(`${CRED_PREFIX}${key}`, value));
      // Also update the in-process snapshot so the current warm
      // lambda's next request sees the new value via getCredential().
      // This is intentional: writes through saveCredentialsToKV() are
      // operator-driven (dashboard save), not per-tenant, so the
      // process-wide snapshot is the right shape.
      hydratedSnapshot[key] = value;
    }
  }
  await Promise.all(writes);
}

// ── Hydration ──────────────────────────────────────────────────────

let hydrated = false;

/**
 * Load all `cred:*` keys from KV into the in-process snapshot.
 * Runs once per process (idempotent). Skips keys already in
 * `process.env` from boot — boot env vars (Vercel dashboard, .env)
 * take precedence.
 *
 * SEC-02: does NOT mutate process.env. Tool handlers read through
 * `getCredential(envKey)` which consults (a) the request-scoped
 * credentials map, (b) the boot env snapshot, (c) the hydrated
 * snapshot — in that priority order.
 *
 * Called lazily from the transport entry path.
 */
export async function hydrateCredentialsFromKV(): Promise<void> {
  if (hydrated) return;
  hydrated = true;

  const kv = getContextKVStore();
  // Only hydrate if we have real KV (Upstash) — ephemeral /tmp KV
  // on Vercel without Upstash doesn't survive cold starts anyway.
  if (kv.kind !== "upstash") return;

  try {
    const keys = await kvScanAll(kv, `${CRED_PREFIX}*`);
    if (keys.length === 0) return;

    const values = kv.mget ? await kv.mget(keys) : await Promise.all(keys.map((k) => kv.get(k)));

    for (let i = 0; i < keys.length; i++) {
      const envKey = keys[i].slice(CRED_PREFIX.length);
      const value = values[i];
      // Don't overwrite existing env vars — boot env takes precedence.
      if (value && !getConfig(envKey)) {
        hydratedSnapshot[envKey] = value;
      }
    }
    if (keys.length > 0) {
      console.log(`[Kebab MCP] Hydrated ${keys.length} credential(s) from KV (SEC-02 snapshot)`);
    }
  } catch (err) {
    console.warn("[Kebab MCP] Failed to hydrate credentials from KV:", toMsg(err));
  }
}

/**
 * Reset the hydration flag. Test-only.
 */
export function resetHydrationFlag(): void {
  hydrated = false;
  hydratedSnapshot = {};
}

/**
 * Clear the bootstrap flag so hydration re-runs on next resolveRegistry.
 * Called after credentials are saved to KV to ensure they're visible.
 */
export function resetCredentialHydration(): void {
  hydrated = false;
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
    const envKey = keys[i].slice(CRED_PREFIX.length);
    const value = values[i];
    if (value) result[envKey] = value;
  }
  return result;
}
