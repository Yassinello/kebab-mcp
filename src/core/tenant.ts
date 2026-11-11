/**
 * Multi-tenant support via `x-mymcp-tenant` header.
 *
 * When the header is present, KV keys are prefixed with `tenant:<id>:` to
 * isolate per-tenant data. When absent (null tenantId), keys are unchanged —
 * this preserves the existing single-user behavior with zero regression.
 */

const TENANT_HEADER = "x-mymcp-tenant";
/** Q-03 (2026-11 audit): brand-consistent alias, preferred when both are sent. */
const KEBAB_TENANT_HEADER = "x-kebab-tenant";

/** Allowed tenant ID pattern: 1-64 alphanumeric + hyphens. */
const TENANT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Extract tenant ID from request headers.
 * Returns null if the header is absent (default tenant).
 * Throws if the header is present but invalid.
 */
export function getTenantId(request: Request): string | null {
  const raw = request.headers.get(KEBAB_TENANT_HEADER) ?? request.headers.get(TENANT_HEADER);
  if (raw === null || raw === "") return null;
  const id = raw.trim().toLowerCase();
  if (!TENANT_ID_RE.test(id)) {
    throw new TenantError(`Invalid tenant ID "${id}" — must match ${TENANT_ID_RE}`);
  }
  return id;
}

/**
 * Prefix a KV key with tenant namespace.
 * If tenantId is null (default tenant), the key is returned unchanged.
 */
export function withTenantPrefix(key: string, tenantId: string | null): string {
  if (tenantId === null) return key;
  return `tenant:${tenantId}:${key}`;
}

/** Tenant validation error — callers can catch to return 400. */
export class TenantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantError";
  }
}
