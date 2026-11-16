/**
 * Request-scoped context via AsyncLocalStorage.
 *
 * Allows tool handlers to access per-request data (like tenantId and
 * tenant-specific credentials) without threading it through every
 * function signature. The transport route wraps each request in
 * `requestContext.run(...)` so tool handlers can call
 * `getCurrentTenantId()` + `getCredential("SLACK_BOT_TOKEN")` and see
 * the values scoped to their request.
 *
 * SEC-02 (v0.10): `getCredential()` replaces direct `process.env[KEY]`
 * reads inside tool paths. Credentials never get written to the
 * process-global `process.env` at request time — that mutation is racy
 * under concurrent load on warm lambdas. Connectors that still read
 * `process.env.MY_KEY` directly continue to work against the boot-time
 * snapshot; the deprecation + migration is tracked for v0.11 via an
 * ESLint rule.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { getTenantKVStore, type KVStore } from "./kv-store";

export interface RequestContextData {
  tenantId: string | null;
  /**
   * Per-request credential overrides. Keyed by env var name
   * (e.g., "SLACK_BOT_TOKEN"). When set, `getCredential(key)` returns
   * these values before falling through to the boot-env snapshot.
   */
  credentials?: Record<string, string> | undefined;
}

export const requestContext = new AsyncLocalStorage<RequestContextData>();

/**
 * Frozen snapshot of process.env captured at module load. This is the
 * baseline that survivors of any request-time mutations should read from.
 * We intentionally do NOT read from the live `process.env` for most keys
 * — that is the concurrency-unsafe path SEC-02 closes.
 */
const bootEnv: Readonly<Record<string, string | undefined>> = Object.freeze({ ...process.env });

/**
 * Env vars that legitimately change at runtime (injected by the
 * platform). Reads for these keys fall through to the live process.env
 * rather than the frozen snapshot. Audit additions carefully: each
 * entry re-opens the concurrency-unsafe path for that key.
 */
const RUNTIME_READ_THROUGH = new Set<string>([
  // Vercel lifecycle values — can differ between warm lambdas, never
  // mutated at request time.
  "VERCEL",
  "VERCEL_GIT_COMMIT_SHA",
  "VERCEL_DEPLOYMENT_ID",
  "VERCEL_URL",
  "NODE_ENV",
]);

/**
 * Get the tenant ID from the current request context.
 * Returns null if no context is active (default tenant).
 */
export function getCurrentTenantId(): string | null {
  return requestContext.getStore()?.tenantId ?? null;
}

/**
 * Get a KV store scoped to the current request's tenant.
 * Replaces direct `getKVStore()` calls in tool handlers — ensures
 * tenant isolation is respected when a tenantId is present.
 */
export function getContextKVStore(): KVStore {
  return getTenantKVStore(getCurrentTenantId());
}

/**
 * SEC-02: Read a credential / env var through the request context.
 *
 * Resolution order:
 *  1. Request-scoped override (set via `runWithCredentials`)
 *  2. Live process.env for platform lifecycle keys (RUNTIME_READ_THROUGH)
 *  3. Boot-time process.env snapshot (read-only)
 *
 * Preferred over `process.env.MY_KEY` for any credential a tool
 * handler needs. Direct process.env reads are being deprecated; an
 * ESLint rule added in Task 8 blocks AssignmentExpressions against
 * process.env outside the boot path.
 */
export function getCredential(envKey: string): string | undefined {
  const ctx = requestContext.getStore();
  if (ctx?.credentials && Object.prototype.hasOwnProperty.call(ctx.credentials, envKey)) {
    return ctx.credentials[envKey];
  }
  if (RUNTIME_READ_THROUGH.has(envKey)) return process.env[envKey];
  return bootEnv[envKey];
}

/**
 * Run `fn` with the given credentials merged into the current request
 * context. If no context is active, a new one is started with the
 * provided credentials + a null tenantId. Propagates through await /
 * Promise.all / setTimeout via AsyncLocalStorage.
 */
export function runWithCredentials<T>(
  creds: Record<string, string>,
  fn: () => T | Promise<T>
): T | Promise<T> {
  const existing = requestContext.getStore();
  const next: RequestContextData = {
    tenantId: existing?.tenantId ?? null,
    credentials: { ...(existing?.credentials || {}), ...creds },
  };
  return requestContext.run(next, fn);
}

/**
 * Run `fn` with the given `tenantId` ambient in the request context.
 *
 * Thin wrapper over `requestContext.run` that preserves any existing
 * credential overrides so callers downstream can still read
 * `getCredential(...)` the same way they would mid-request.
 *
 * Phase 70 / Plan 02 webhook handlers use this to enter tenant scope
 * AFTER resolving `accountId → tenantId` via the root-scope reverse
 * index — at that point the lambda has no ambient tenant context (the
 * webhook ingress route runs anonymously via the static-secret path),
 * so the handler must establish one before any KV write so
 * `getContextKVStore()` prefixes correctly.
 */
export function runWithTenant<T>(tenantId: string, fn: () => T | Promise<T>): T | Promise<T> {
  const existing = requestContext.getStore();
  const next: RequestContextData = {
    tenantId,
    credentials: existing?.credentials,
  };
  return requestContext.run(next, fn);
}

// ── Public origin of the incoming request (contract 5) ───────────────
//
// Tool handlers do not see the HTTP request, but some must hand the model
// an absolute link to this instance (the dashboard, the approval page).
// The transport runs each MCP request under `runWithRequestOrigin` with
// the origin it derived from the request (`publicOrigin(request)`); a
// separate store so the credential/tenant re-entries above never drop it.

const requestOriginStore = new AsyncLocalStorage<string>();

/** Run `fn` with the public origin of the incoming request ambient. */
export function runWithRequestOrigin<T>(origin: string, fn: () => T): T {
  return requestOriginStore.run(origin, fn);
}

/** Origin (`https://host`) of the current request, `null` outside one. */
export function getRequestOrigin(): string | null {
  return requestOriginStore.getStore() ?? null;
}
