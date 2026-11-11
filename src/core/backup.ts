/**
 * Backup / restore logic for KV store data.
 *
 * Shared between:
 * - CLI: scripts/backup.ts
 * - Admin tools: mcp_backup_export, mcp_backup_import
 *
 * Export format (v2, Phase 42 / TEN-04):
 * ```
 * {
 *   version: 2,
 *   exportedAt: ISO string,
 *   scope: "tenant:<id>" | "default" | "all",
 *   entries: { key: value, ... }
 * }
 * ```
 *
 * **Phase 42 (TEN-04) — default-per-tenant scope:**
 *
 * Pre-v0.11, `exportBackup()` scanned every KV key in the store.
 * On a multi-tenant deploy this embedded every tenant's data in the
 * backup — a privacy regression. v0.11+ defaults to the current
 * tenant's namespace via `getContextKVStore()`. The root-operator
 * opts into a cross-tenant export via `opts.scope === "all"`, which
 * bypasses the tenant wrapper and uses raw `getKVStore()`.
 *
 * v1 (pre-v0.11) backups are still importable via a compat branch —
 * operators with v1 backups are single-tenant by definition.
 *
 * Safety guard: importing a `scope: "all"` backup into a tenant
 * context requires the caller to explicitly request `scope: "all"`.
 * Default-case ingestion of an all-tenants backup into one tenant's
 * namespace is rejected — prevents accidental cross-contamination.
 *
 * Only KV data is exported — no env vars or secrets.
 */

import { getKVStore, kvScanAll, type KVStore } from "./kv-store";
import { getContextKVStore, getCurrentTenantId } from "./request-context";
import { getLogger } from "./logging";

const backupLog = getLogger("BACKUP");

export const BACKUP_VERSION = 2;

export type BackupScopeTag = "all" | "default" | `tenant:${string}`;

export interface BackupData {
  version: number;
  exportedAt: string;
  /**
   * Phase 42 / TEN-04: scope tag records the namespace this backup
   * covers. Used by `importBackup` to guard against cross-tenant
   * contamination (a `scope: "all"` backup cannot be imported into a
   * single tenant's namespace without explicit `scope: "all"` intent).
   * Pre-v0.11 backups (version 1) lack this field — treated as
   * `"default"` under the legacy single-tenant compat branch.
   */
  scope?: BackupScopeTag;
  entries: Record<string, string>;
}

export interface ImportOptions {
  /**
   * "merge" (default): additive — only writes keys from the backup.
   * "replace": deletes all existing keys not in the backup, then writes all backup keys.
   */
  mode?: "merge" | "replace" | undefined;
  /**
   * SEC-02: allow writing secret-bearing and authorization keys
   * (`cred:*`, `mymcp:firstrun:*`, `devices:*`, ...). Defaults to false;
   * those keys are skipped and reported. In "replace" mode they are also
   * never deleted unless this is set.
   */
  includeSecrets?: boolean | undefined;
  /**
   * Phase 42 / TEN-04: target scope.
   * - "tenant" (default): writes via `getContextKVStore()` — current
   *   tenant only. Requires the backup to be tenant-scoped OR the
   *   caller to accept best-effort v1 compat.
   * - "all": writes via raw `getKVStore()` — restores every tenant's
   *   data. Root-operator path only.
   */
  scope?: "tenant" | "all" | undefined;
}

export interface ExportOptions {
  /** Explicit KV override — used by scripts/backup.ts when the caller holds a specific store. */
  kv?: KVStore;
  /** Phase 42 / TEN-04: scope selector. Defaults to "tenant". */
  scope?: "tenant" | "all";
  /**
   * SEC-02 (2026-11 audit): include secret-bearing keys (connector
   * credentials, first-run bootstrap/signing material, API connection
   * auth, OAuth access tokens). Defaults to false. Only the operator CLI
   * (`scripts/backup.ts`, which already holds raw KV credentials) passes
   * true; the MCP tool surface never does.
   */
  includeSecrets?: boolean;
}

/**
 * SEC-02: key prefixes that carry secrets. Excluded from exports and
 * refused on import unless `includeSecrets` is set. Matching is done on
 * the tenant-relative key (TenantKV strips the `tenant:<id>:` prefix) and
 * on the raw key for `scope: "all"` exports.
 */
export const SECRET_KEY_PREFIXES: readonly string[] = [
  "cred:",
  "mymcp:firstrun:",
  "api:connections",
  "google:oauth:access-token",
];

/**
 * SEC-02: keys that are not secret but control authorization. Exported
 * (they document the instance) but never written by a non-secret import:
 * rewriting `devices:<id>` would let an importer drop its own connector
 * scope.
 */
export const AUTHZ_KEY_PREFIXES: readonly string[] = ["devices:"];

function stripTenantPrefix(key: string): string {
  const m = /^tenant:[^:]+:(.*)$/.exec(key);
  return m?.[1] ?? key;
}

export function isSecretKey(key: string): boolean {
  const k = stripTenantPrefix(key);
  return SECRET_KEY_PREFIXES.some((p) => k.startsWith(p));
}

function isAuthzKey(key: string): boolean {
  const k = stripTenantPrefix(key);
  return AUTHZ_KEY_PREFIXES.some((p) => k.startsWith(p));
}

/**
 * Export KV entries. Default scope is the current tenant's namespace.
 *
 * - `opts.kv` overrides the store entirely (CLI compat).
 * - `opts.scope === "all"` exports every tenant's keys via raw KV.
 * - Otherwise exports the current tenant's namespace via
 *   `getContextKVStore()`.
 *
 * MEDIUM-1: Uses mget() for single-roundtrip batch reads when available,
 * falls back to batched parallel gets in groups of 50.
 */
export async function exportBackup(opts?: ExportOptions): Promise<BackupData> {
  const scopeMode = opts?.scope ?? "tenant";
  let kv: KVStore;
  let scope: BackupScopeTag;

  if (opts?.kv) {
    // Explicit override — preserve legacy caller contract. Scope tag
    // reflects the resolver, not the store (we can't introspect a
    // third-party KVStore's tenantId reliably).
    kv = opts.kv;
    const tenantId = getCurrentTenantId();
    scope = tenantId ? `tenant:${tenantId}` : "default";
  } else if (scopeMode === "all") {
    kv = getKVStore();
    scope = "all";
  } else {
    kv = getContextKVStore();
    const tenantId = getCurrentTenantId();
    scope = tenantId ? `tenant:${tenantId}` : "default";
  }

  const includeSecrets = opts?.includeSecrets === true;
  const keys = (await kvScanAll(kv, "*")).filter((k) => includeSecrets || !isSecretKey(k));
  const entries: Record<string, string> = {};

  if (typeof kv.mget === "function") {
    // Single-roundtrip batch read via MGET
    const BATCH_SIZE = 50;
    for (let i = 0; i < keys.length; i += BATCH_SIZE) {
      const batch = keys.slice(i, i + BATCH_SIZE);
      const values = await kv.mget(batch);
      for (let j = 0; j < batch.length; j++) {
        const k = batch[j];
        const v = values[j];
        if (k !== undefined && v !== null && v !== undefined) {
          entries[k] = v;
        }
      }
    }
  } else {
    // Fallback: batched parallel gets
    const BATCH_SIZE = 10;
    for (let i = 0; i < keys.length; i += BATCH_SIZE) {
      const batch = keys.slice(i, i + BATCH_SIZE);
      const values = await Promise.all(batch.map((key) => kv.get(key)));
      for (let j = 0; j < batch.length; j++) {
        const k = batch[j];
        const v = values[j];
        if (k !== undefined && v !== null && v !== undefined) {
          entries[k] = v;
        }
      }
    }
  }

  return {
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    scope,
    entries,
  };
}

/**
 * Import a backup into the KV store. Validates schema version before
 * writing.
 *
 * **Phase 42 / TEN-04 scope safety:**
 * - Default `opts.scope === "tenant"` writes via `getContextKVStore()`
 *   (current tenant only).
 * - `opts.scope === "all"` writes via raw `getKVStore()` (root-operator
 *   path). A backup whose own `scope === "all"` MUST be imported with
 *   `opts.scope === "all"` — importing it into a tenant namespace
 *   would cross-contaminate that tenant with every other tenant's
 *   data. We reject that case explicitly.
 * - v1 backups (no `scope` field) are treated as `"default"` and
 *   imported into the current scope with a warning — operators with
 *   v1 backups are single-tenant by definition.
 *
 * HIGH-1: Supports `mode: "replace"` — deletes keys not in the backup.
 */
export async function importBackup(
  data: unknown,
  opts?: ImportOptions & { kv?: KVStore }
): Promise<{ ok: boolean; message: string; count?: number; skipped?: number }> {
  if (!data || typeof data !== "object") {
    return { ok: false, message: "Invalid backup: expected a JSON object" };
  }

  const backup = data as Record<string, unknown>;
  const version = backup.version;

  if (version !== 1 && version !== BACKUP_VERSION) {
    return {
      ok: false,
      message: `Unsupported backup version: ${version} (expected ${BACKUP_VERSION})`,
    };
  }

  if (!backup.entries || typeof backup.entries !== "object" || Array.isArray(backup.entries)) {
    return { ok: false, message: "Invalid backup: missing or malformed entries" };
  }

  const scopeMode = opts?.scope ?? "tenant";
  const backupScope =
    typeof backup.scope === "string" ? (backup.scope as BackupScopeTag) : undefined;

  // v1 compat branch — pre-Phase-42 backups have no `scope` field.
  if (version === 1) {
    backupLog.warn(
      "importing v1 (pre-v0.11) backup into current scope — single-tenant assumption",
      {
        targetScope: scopeMode,
      }
    );
  } else if (backupScope === "all" && scopeMode !== "all") {
    // Cross-tenant contamination guard.
    return {
      ok: false,
      message:
        "Refusing to import a scope=all backup into a tenant namespace. " +
        "Pass opts.scope='all' to explicitly restore every tenant's data (root-operator path).",
    };
  }

  const entries = backup.entries as Record<string, unknown>;
  const kv = opts?.kv ?? (scopeMode === "all" ? getKVStore() : getContextKVStore());
  const mode = opts?.mode ?? "merge";
  const includeSecrets = opts?.includeSecrets === true;
  const isProtected = (key: string) => !includeSecrets && (isSecretKey(key) || isAuthzKey(key));
  let count = 0;
  let skipped = 0;

  // In "replace" mode, delete all existing keys not present in the backup.
  // SEC-02: protected keys are never deleted by a non-secret import —
  // a "replace" from a redacted export must not wipe credentials.
  if (mode === "replace") {
    const existingKeys = await kvScanAll(kv, "*");
    const backupKeySet = new Set(Object.keys(entries));
    for (const key of existingKeys) {
      if (!backupKeySet.has(key) && !isProtected(key)) {
        await kv.delete(key);
      }
    }
  }

  for (const [key, value] of Object.entries(entries)) {
    if (typeof value !== "string") continue;
    if (isProtected(key)) {
      skipped++;
      continue;
    }
    await kv.set(key, value);
    count++;
  }

  if (skipped > 0) {
    backupLog.warn("import skipped protected keys (secrets / authorization)", { skipped });
  }
  const modeLabel = mode === "replace" ? "Replaced" : "Imported";
  const skippedLabel = skipped > 0 ? ` (${skipped} protected keys skipped)` : "";
  return { ok: true, message: `${modeLabel} ${count} entries${skippedLabel}`, count, skipped };
}
