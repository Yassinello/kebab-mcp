/**
 * credential-store.ts — KV-backed credential persistence.
 *
 * On Vercel, the filesystem is read-only. When Upstash is configured,
 * connector credentials (GITHUB_PAT, SLACK_BOT_TOKEN, etc.) are saved
 * to KV under `cred:<KEY>` keys. On cold start, `hydrateCredentialsFromKV()`
 * loads them back into `process.env` before the registry resolves.
 *
 * Key prefix: `cred:` — distinct from `settings:` (user config).
 */

import { getKVStore, kvScanAll } from "./kv-store";

export const CRED_PREFIX = "cred:";

/** Whether Upstash is configured (real KV persistence). */
export function isUpstashConfigured(): boolean {
  return Boolean(
    process.env.UPSTASH_REDIS_REST_URL?.trim() && process.env.UPSTASH_REDIS_REST_TOKEN?.trim()
  );
}

/** Whether Vercel API is configured (env var write via API). */
export function isVercelApiConfigured(): boolean {
  return Boolean(process.env.VERCEL_TOKEN?.trim() && process.env.VERCEL_PROJECT_ID?.trim());
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
  if (process.env.VERCEL === "1") {
    if (isVercelApiConfigured()) return "vercel-api";
    return "none";
  }
  return "filesystem";
}

/**
 * Save credentials to KV under `cred:<KEY>` keys.
 * Also sets them on `process.env` in-memory for immediate activation.
 */
export async function saveCredentialsToKV(vars: Record<string, string>): Promise<void> {
  const kv = getKVStore();
  const writes: Promise<void>[] = [];
  for (const [key, value] of Object.entries(vars)) {
    if (value) {
      writes.push(kv.set(`${CRED_PREFIX}${key}`, value));
      process.env[key] = value;
    }
  }
  await Promise.all(writes);
}

// ── Hydration ──────────────────────────────────────────────────────

let hydrated = false;

/**
 * Load all `cred:*` keys from KV into `process.env`.
 * Runs once per process (idempotent). Skips keys already in env
 * (env vars from Vercel dashboard / .env take precedence).
 *
 * Called lazily from `resolveRegistry()` before scanning env vars.
 */
export async function hydrateCredentialsFromKV(): Promise<void> {
  if (hydrated) return;
  hydrated = true;

  const kv = getKVStore();
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
      // Don't overwrite existing env vars — they take precedence
      if (value && !process.env[envKey]) {
        process.env[envKey] = value;
      }
    }
    if (keys.length > 0) {
      console.log(`[MyMCP] Hydrated ${keys.length} credential(s) from KV into process.env`);
    }
  } catch (err) {
    console.warn(
      "[MyMCP] Failed to hydrate credentials from KV:",
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * Reset the hydration flag. Test-only.
 */
export function resetHydrationFlag(): void {
  hydrated = false;
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
  const kv = getKVStore();
  // On Vercel without Upstash the KV is an ephemeral /tmp filesystem —
  // reading from it is useless (data doesn't survive cold starts).
  if (process.env.VERCEL === "1" && kv.kind !== "upstash") return {};

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
