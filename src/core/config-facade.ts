/**
 * SEC-02 / Phase 48 (FACADE-01).
 *
 * Single resolution point for environment-style configuration reads.
 * Replaces direct `process.env.X` across src/ + app/ (post-migration:
 * boot-only sites on `ALLOWED_DIRECT_ENV_READS`).
 *
 * Resolution order (synchronous `getConfig()`):
 *   1. Request-context credential override (via the v0.10
 *      `getCredential()` seam in request-context.ts).
 *   2. RUNTIME_READ_THROUGH — live process.env for platform lifecycle
 *      keys that the platform legitimately mutates between warm lambda
 *      invocations (VERCEL_*, NODE_ENV).
 *   3. bootEnv snapshot (frozen at module load).
 *   4. undefined.
 *
 * The synchronous path does NOT consult the KV credential store — that
 * is a per-handler concern. For per-tenant settings that honor KV
 * overrides, use `getTenantSetting()` (async).
 *
 * Why a snapshot: direct `process.env.X` reads at request time are
 * concurrency-unsafe under warm lambdas — one tenant's
 * `runWithCredentials({SLACK_BOT_TOKEN:'x'})` cannot leak to another.
 * The frozen snapshot is the last-resort fallback; credentials always
 * route through the request-context seam first.
 *
 * DOWNSTREAM: Phase 49's `getRequiredEnv()` strictness work attaches
 * here. Phase 50's `KEBAB_*` / `MYMCP_*` alias priority adds a second
 * lookup step between (1) and (2) without touching the public API.
 */

import { getCredential } from "./request-context";
import { McpConfigError } from "./errors";

/**
 * Frozen snapshot of process.env captured at module load. Tests that
 * need to mutate env after import use `vi.stubEnv` on
 * RUNTIME_READ_THROUGH keys, or `runWithCredentials()` for the
 * request-context override path.
 */
const bootEnv: Readonly<Record<string, string | undefined>> = Object.freeze({ ...process.env });

/**
 * Platform lifecycle keys that the process itself may legitimately
 * differ between warm lambdas. Audit additions carefully — each entry
 * re-opens a concurrency-unsafe read for that key. Mirrors the list in
 * request-context.ts (the two are kept in sync by convention).
 */
const RUNTIME_READ_THROUGH = new Set<string>([
  "VERCEL",
  "VERCEL_URL",
  "VERCEL_ENV",
  "VERCEL_GIT_COMMIT_SHA",
  "VERCEL_DEPLOYMENT_ID",
  "NODE_ENV",
]);

/**
 * Primary accessor. Resolves: context → runtime → boot → undefined.
 */
export function getConfig(key: string): string | undefined {
  const ctx = getCredential(key);
  if (ctx !== undefined) return ctx;
  if (RUNTIME_READ_THROUGH.has(key)) return process.env[key];
  return bootEnv[key];
}

/**
 * Required-key accessor. Throws `McpConfigError` on missing / empty —
 * catchable at the pipeline layer so handlers don't have to repeat
 * "missing env" boilerplate. For optional keys with defaults, prefer
 * the typed helpers below.
 */
export function getRequiredConfig(key: string): string {
  const v = getConfig(key);
  if (v === undefined || v === "") {
    throw new McpConfigError(`Missing required config: ${key}`, key);
  }
  return v;
}

/**
 * Parse an integer config value. Falls back to `fallback` on:
 *   - key unset or empty
 *   - malformed input (non-numeric)
 *   - NaN / Infinity result
 */
export function getConfigInt(key: string, fallback: number): number {
  const raw = getConfig(key);
  if (raw === undefined || raw === "") return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Parse a boolean config value. Truthy set: `"1"`, `"true"` (case-insensitive).
 * Anything else is falsy. Matches the convention in rate-limit.ts /
 * logging.ts / welcome flow flags.
 */
export function getConfigBool(key: string, fallback = false): boolean {
  const raw = getConfig(key);
  if (raw === undefined) return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

/**
 * Parse a comma-separated list. Trims each entry, drops empties.
 * Returns `fallback` (default `[]`) when the key is unset.
 */
export function getConfigList(key: string, fallback: string[] = []): string[] {
  const raw = getConfig(key);
  if (!raw) return fallback;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * FACADE-04 — per-tenant setting accessor with KV override.
 *
 * Resolution order (async):
 *   1. Request-context credential override (same as getConfig()).
 *   2. Tenant KV store at `kvKey` when `tenantId` provided.
 *   3. Global KV store at `kvKey`.
 *   4. bootEnv snapshot at `envKey`.
 *   5. undefined.
 *
 * Use this for settings that should be tenant-overridable
 * (KEBAB_TIMEZONE / MYMCP_TIMEZONE, KEBAB_LOCALE / MYMCP_LOCALE,
 * KEBAB_DISPLAY_NAME / MYMCP_DISPLAY_NAME, KEBAB_CONTEXT_PATH /
 * MYMCP_CONTEXT_PATH). Sync reads via `getConfig()` DO NOT consult KV.
 *
 * Note on KEBAB_* aliasing: Phase 48 ships the single env name passed
 * by the caller. Phase 50 adds `KEBAB_*` ↔ `MYMCP_*` alias resolution
 * with a deprecation warning — the `envKey` argument is unchanged
 * between phases; only `getConfig()`'s lookup gains an alias step.
 */
export async function getTenantSetting(
  envKey: string,
  kvKey: string,
  tenantId?: string | null
): Promise<string | undefined> {
  // Early out: request-context override wins unconditionally.
  const ctx = getCredential(envKey);
  if (ctx !== undefined) return ctx;

  // Lazy import: kv-store may transitively read config; circular import
  // prevention is critical here.
  try {
    const { getTenantKVStore, getKVStore } = await import("./kv-store");
    const kv = tenantId ? getTenantKVStore(tenantId) : getKVStore();
    const kvVal = await kv.get(kvKey);
    if (kvVal !== null && kvVal !== undefined) return kvVal;
  } catch {
    // KV unavailable (first-run, fresh cold start, transient error).
    // Fall through to env; callers already tolerate undefined.
  }
  // bootEnv (post-tenant-KV fallback).
  return getConfig(envKey);
}

/**
 * Boot-only direct `process.env` reads exempt from the
 * `kebab/no-direct-process-env` ESLint rule (Phase 48 / FACADE-03).
 *
 * Every entry:
 *   - has a file path relative to the repo root
 *   - lists the env var(s) read directly in that file
 *   - carries a reason string ≥ 20 chars describing WHY the read
 *     cannot route through `getConfig()` (boot ordering, circular dep,
 *     module-load init, etc.)
 *
 * Keep the list short and sorted by path. New entries require a
 * 20+-char reason and code-review approval.
 */
export interface AllowedDirectEnvRead {
  file: string;
  vars: readonly string[];
  reason: string;
}

export const ALLOWED_DIRECT_ENV_READS: ReadonlyArray<AllowedDirectEnvRead> = Object.freeze([
  {
    file: "src/core/config-facade.ts",
    vars: ["*"],
    reason: "facade itself owns the bootEnv snapshot + RUNTIME_READ_THROUGH",
  },
  {
    file: "src/core/credential-store.ts",
    vars: ["VERCEL", "VERCEL_TOKEN", "VERCEL_PROJECT_ID"],
    reason: "boot-time credential bootstrap before request context exists",
  },
  {
    file: "src/core/env-store.ts",
    vars: ["VERCEL", "VERCEL_TOKEN", "VERCEL_PROJECT_ID", "VERCEL_TEAM_ID"],
    reason: "EnvStore platform bootstrap; also on SEC-02 off-list for mutation",
  },
  {
    file: "src/core/first-run-edge.ts",
    vars: ["MCP_AUTH_TOKEN"],
    reason: "edge runtime bootstrap — facade import graph not available",
  },
  {
    file: "src/core/first-run.ts",
    vars: ["VERCEL", "MCP_AUTH_TOKEN", "MYMCP_RECOVERY_RESET"],
    reason: "first-run bootstrap pathway predates facade in module-load order",
  },
  {
    file: "src/core/kv-store.ts",
    vars: ["VERCEL", "MYMCP_KV_PATH"],
    reason: "boot-time KVStore selection; facade lazy-imports this module",
  },
  {
    file: "src/core/log-store.ts",
    vars: [
      "MYMCP_LOG_MAX_ENTRIES",
      "MYMCP_LOG_MAX_AGE_SECONDS",
      "MYMCP_LOG_ROTATE_SEGMENTS",
      "VERCEL",
    ],
    reason: "LogStore platform + rotation bootstrap at module load",
  },
  {
    file: "src/core/request-context.ts",
    vars: ["*"],
    reason: "owns its own bootEnv snapshot for the getCredential seam",
  },
  {
    file: "src/core/signing-secret.ts",
    vars: ["VERCEL", "NODE_ENV", "MYMCP_ALLOW_EPHEMERAL_SECRET"],
    reason: "boot-time signing-secret derivation before request context exists",
  },
  {
    file: "src/core/storage-mode.ts",
    vars: [
      "VERCEL",
      "NETLIFY",
      "AWS_LAMBDA_FUNCTION_NAME",
      "LAMBDA_TASK_ROOT",
      "K_SERVICE",
      "MYMCP_KV_PATH",
    ],
    reason: "serverless platform detection at module load — predates facade init",
  },
  {
    file: "src/core/tracing.ts",
    vars: ["OTEL_SERVICE_NAME", "OTEL_EXPORTER_OTLP_ENDPOINT"],
    reason: "OTel SDK init runs at module load; facade import ordering would invert dep",
  },
]);

/**
 * Test-only. bootEnv is frozen at module load; this is an intentional
 * no-op that lets test suites state the invariant explicitly. Tests
 * needing env-override use vi.stubEnv for RUNTIME_READ_THROUGH keys,
 * or runWithCredentials() for the request-context path.
 */
export function __resetBootEnvForTests(): void {
  // No-op: bootEnv is frozen and captured at module load.
}
