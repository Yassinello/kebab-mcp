import type { InstanceConfig } from "./types";
import { getKVStore } from "./kv-store";
import { getTenantKVStore } from "./kv-store";
import { emit } from "./events";
import { validateDestructiveVarsAtStartup } from "./env-safety";
import { getConfig } from "./config-facade";

/**
 * Reads instance configuration.
 *
 * v0.6 (A1): the four user settings (`displayName`, `timezone`, `locale`,
 * `contextPath`) now live in KVStore by default. Precedence on read:
 *   1. KVStore value (if set)
 *   2. Environment variable (legacy / bootstrap)
 *   3. Hard-coded default
 *
 * Because many call sites are synchronous (tool handlers), we keep a
 * module-level cache populated by `getInstanceConfigAsync()` on the first
 * async entry (pages, admin status, settings save). Synchronous callers
 * read from the cache or, on cold start, fall back to env/defaults.
 *
 * Framework-level: this module defines WHAT config exists.
 * Instance-level: values come from KV/env.
 */

const KV_KEYS = {
  displayName: "settings:displayName",
  timezone: "settings:timezone",
  locale: "settings:locale",
  contextPath: "settings:contextPath",
} as const;

export const SETTINGS_KV_KEYS = KV_KEYS;

/** Keys routed to KVStore instead of EnvStore when saved from the dashboard. */
export const SETTINGS_ENV_KEYS = [
  "MYMCP_DISPLAY_NAME",
  "MYMCP_TIMEZONE",
  "MYMCP_LOCALE",
  "MYMCP_CONTEXT_PATH",
] as const;

function envConfig(): InstanceConfig {
  // Phase 50 / BRAND-01: KEBAB_* is the modern key; getConfig() falls
  // back to MYMCP_* with a once-per-process deprecation warning.
  return {
    timezone: getConfig("KEBAB_TIMEZONE") || "UTC",
    locale: getConfig("KEBAB_LOCALE") || "en-US",
    displayName: getConfig("KEBAB_DISPLAY_NAME") || "User",
    contextPath: getConfig("KEBAB_CONTEXT_PATH") || "System/context.md",
  };
}

let cached: InstanceConfig | null = null;

// SAFE-04: destructive env-var validation runs lazily on the first
// getInstanceConfig() / getInstanceConfigAsync() call, NOT at module
// scope. Module-scope execution would:
//   (1) pollute test processes that deliberately set destructive vars
//       via `vi.stubEnv` after import
//   (2) force every test that imports from `@/core/config` to eat the
//       validation cost
// Vitest tests that want to exercise the validator call
// `runStartupValidation()` explicitly (and first reset via
// `__resetStartupValidationForTests`).
let bootValidated = false;

/**
 * One-shot destructive-env-var validator (SAFE-04). Called by
 * `getInstanceConfig()` / `getInstanceConfigAsync()` on first use so the
 * boot log surfaces any active destructive vars on the first request to
 * hit the instance. In production, reject-severity misconfigurations
 * terminate the process — the operator sees the Vercel / container crash
 * log and gets an actionable error instead of a silently-wiped deploy.
 */
export function runStartupValidation(): void {
  if (bootValidated) return;
  bootValidated = true;
  const { warnings, rejections } = validateDestructiveVarsAtStartup();
  for (const w of warnings) console.warn(w);
  for (const r of rejections) console.error(r);
  if (rejections.length > 0 && getConfig("NODE_ENV") === "production") {
    console.error(
      "[ENV-SAFETY] Refusing to start due to reject-severity destructive env vars. Unset them, or change NODE_ENV if this really is a development instance."
    );
    // Give the log a chance to flush before exit.
    process.exit(1);
  }
}

/** Test-only. Resets the one-shot boot-validation flag. */
export function __resetStartupValidationForTests(): void {
  bootValidated = false;
}

/**
 * Synchronous read of instance config. Returns the last value loaded from
 * KV via `getInstanceConfigAsync()`; on cold start (before any async
 * entry) falls back to env/defaults. Tool handlers can rely on this for
 * locale/timezone formatting without awaiting KV on every call.
 */
export function getInstanceConfig(): InstanceConfig {
  runStartupValidation();
  return cached ?? envConfig();
}

/** Test-only: reset the module cache. */
export function resetInstanceConfigCache(): void {
  cached = null;
}

/**
 * Async read: consult KVStore, fall back to env, fall back to defaults.
 * Also refreshes the sync cache so subsequent sync calls see the latest.
 *
 * One-time migration: if KV is empty for a key but env has a value, copy
 * env → KV so the dashboard can start managing it without losing state.
 */
export async function getInstanceConfigAsync(tenantId?: string | null): Promise<InstanceConfig> {
  runStartupValidation();
  const env = envConfig();
  let kv;
  try {
    kv = tenantId ? getTenantKVStore(tenantId) : getKVStore();
  } catch {
    cached = env;
    return env;
  }

  const [kvDisplay, kvTz, kvLocale, kvCtx] = await Promise.all([
    kv.get(KV_KEYS.displayName),
    kv.get(KV_KEYS.timezone),
    kv.get(KV_KEYS.locale),
    kv.get(KV_KEYS.contextPath),
  ]);

  // One-time env → KV migration per key. Idempotent: if KV already has a
  // value we never touch it.
  const migrations: Array<Promise<void>> = [];
  // Phase 50 / BRAND-01: KEBAB_* primary; facade handles MYMCP_* fallback.
  const envDisplay = getConfig("KEBAB_DISPLAY_NAME");
  const envTz = getConfig("KEBAB_TIMEZONE");
  const envLocale = getConfig("KEBAB_LOCALE");
  const envCtx = getConfig("KEBAB_CONTEXT_PATH");
  if (kvDisplay === null && envDisplay) {
    migrations.push(kv.set(KV_KEYS.displayName, envDisplay));
  }
  if (kvTz === null && envTz) {
    migrations.push(kv.set(KV_KEYS.timezone, envTz));
  }
  if (kvLocale === null && envLocale) {
    migrations.push(kv.set(KV_KEYS.locale, envLocale));
  }
  if (kvCtx === null && envCtx) {
    migrations.push(kv.set(KV_KEYS.contextPath, envCtx));
  }
  if (migrations.length > 0) {
    await Promise.all(migrations).catch(() => {
      /* best-effort migration; next read will retry */
    });
  }

  const resolved: InstanceConfig = {
    displayName: kvDisplay ?? env.displayName,
    timezone: kvTz ?? env.timezone,
    locale: kvLocale ?? env.locale,
    contextPath: kvCtx ?? env.contextPath,
  };
  cached = resolved;
  return resolved;
}

/**
 * Persist one or more settings to KVStore.
 *
 * Phase 48 / FACADE-04: when `tenantId` is provided, writes go to the
 * tenant-scoped KV namespace (`tenant:<id>:settings:*`). Otherwise —
 * global KV (backwards compatible with pre-Phase-48 callers). This is
 * the write-side counterpart to the read-side per-tenant path in
 * `getInstanceConfigAsync(tenantId)` (already Phase 42).
 */
export async function saveInstanceConfig(
  patch: Partial<InstanceConfig>,
  tenantId?: string | null
): Promise<void> {
  const kv = tenantId ? getTenantKVStore(tenantId) : getKVStore();
  const writes: Array<Promise<void>> = [];
  if (patch.displayName !== undefined) writes.push(kv.set(KV_KEYS.displayName, patch.displayName));
  if (patch.timezone !== undefined) writes.push(kv.set(KV_KEYS.timezone, patch.timezone));
  if (patch.locale !== undefined) writes.push(kv.set(KV_KEYS.locale, patch.locale));
  if (patch.contextPath !== undefined) writes.push(kv.set(KV_KEYS.contextPath, patch.contextPath));
  await Promise.all(writes);
  cached = null;
  // v0.6 MED-3: notify subscribers (registry cache, dashboard SSE) that
  // a setting backing process.env-equivalent state has changed, so they
  // can invalidate without waiting for the next lambda restart.
  emit("env.changed");
}

/** Default tool timeout in ms. Override via KEBAB_TOOL_TIMEOUT env var. */
export function getToolTimeout(): number {
  const raw = getConfig("KEBAB_TOOL_TIMEOUT");
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n > 0) return n;
  }
  // 80s default — sized for the slowest legitimate tools (Browser pack:
  // linkedin_feed, web_extract, web_agent boot a remote Stagehand session,
  // navigate, scroll, then run an LLM extract). Sits 10s under the
  // transport route's maxDuration: 90 so KEBAB_TOOL_TIMEOUT fires first,
  // surfacing a clean ToolTimeoutError instead of an opaque Vercel 504.
  // Tools that finish in <1s pay nothing — the timeout only fires when
  // a handler genuinely hangs, so a longer cap is purely defensive.
  return 80_000;
}

/** Webhook URL for error notifications. If set, POST is sent on tool failure. */
export function getErrorWebhookUrl(): string | undefined {
  return getConfig("KEBAB_ERROR_WEBHOOK_URL") || undefined;
}

/**
 * Parse KEBAB_ENABLED_PACKS if set (or the legacy MYMCP_* alias).
 * Returns undefined if not set (all packs auto-activate by env vars).
 * Returns Set of pack IDs if set (only listed packs are considered).
 *
 * Phase 50 / BRAND-01: facade handles KEBAB_* priority, MYMCP_* fallback
 * with a once-per-process deprecation warning.
 */
export function getEnabledPacksOverride(): Set<string> | undefined {
  const raw = getConfig("KEBAB_ENABLED_PACKS");
  if (!raw) return undefined;
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}
