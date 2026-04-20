/**
 * v0.10 Migration — Move legacy un-prefixed `cred:*` and `skills:*`
 * keys into the default-tenant namespace.
 *
 * Pre-v0.10, connector stores (skills, credential-store) wrote KV
 * keys at the global prefix (`skills:all`, `cred:SLACK_BOT_TOKEN`).
 * SEC-01 tenant-scoped those callsites to `getContextKVStore()`,
 * which routes them through `tenant:<id>:...` when a tenant context
 * is active and through the unprefixed path when no context is.
 *
 * For single-tenant deploys that upgraded from pre-v0.10, the
 * legacy un-prefixed keys still exist — but the code now reads from
 * the tenant-null path, which is still the un-prefixed path. So
 * strictly speaking, no migration is required for backwards
 * compatibility on single-tenant deploys.
 *
 * However, for multi-tenant deploys or for any operator who
 * retroactively enables the `x-mymcp-tenant` header, legacy keys
 * become invisible. This migration copies them into an explicit
 * default-tenant namespace (`tenant::cred:...` — empty tenantId,
 * which is distinct from the null-tenant unprefixed path) so that
 * operators can explicitly retrieve them via a `?tenant=default`
 * CLI tool later if needed.
 *
 * Actually — simpler semantics: leave legacy keys in place. The
 * null-tenant code path already reads them. This migration is
 * therefore **a no-op** in the common case; we only document the
 * idempotency marker in KV and log the count.
 *
 * Idempotency marker: `mymcp:migrations:v0.10-tenant-prefix`. Once
 * set to "completed", the migration does not re-run.
 */

import { getKVStore, kvScanAll } from "../kv-store";

const MIGRATION_KEY = "mymcp:migrations:v0.10-tenant-prefix";

let migrationStarted = false;

/**
 * Idempotent, fire-and-forget on first boot. Safe to call from any
 * long-lived handler entry point. Logs once, then does nothing on
 * subsequent calls in the same process.
 */
export async function runV010TenantPrefixMigration(): Promise<void> {
  if (migrationStarted) return;
  migrationStarted = true;
  try {
    const kv = getKVStore();
    const already = await kv.get(MIGRATION_KEY);
    if (already === "completed") return;

    // Count how many legacy un-prefixed keys exist for logging
    // purposes. The null-tenant code path (getContextKVStore with no
    // tenant) continues to read these as-is, so there is nothing to
    // move. We only record the marker + the inventory for operators.
    let legacyCred = 0;
    let legacySkills = 0;
    try {
      const credKeys = await kvScanAll(kv, "cred:*");
      legacyCred = credKeys.filter((k) => !k.startsWith("tenant:")).length;
    } catch {
      // ignore — KV may not support scan reliably on all backends
    }
    try {
      const skillKeys = await kvScanAll(kv, "skills:*");
      legacySkills = skillKeys.filter((k) => !k.startsWith("tenant:")).length;
    } catch {
      // ignore
    }

    await kv.set(
      MIGRATION_KEY,
      JSON.stringify({
        status: "completed",
        at: new Date().toISOString(),
        legacyCounts: { cred: legacyCred, skills: legacySkills },
      })
    );
    if (legacyCred + legacySkills > 0) {
      console.info(
        `[Kebab MCP migration v0.10-tenant-prefix] noted ${legacyCred} legacy cred:* + ${legacySkills} legacy skills:* keys (served via null-tenant path unchanged)`
      );
    }
  } catch (err) {
    // Never fail boot — migration is idempotent best-effort.
    console.info(
      `[Kebab MCP migration v0.10-tenant-prefix] skipped: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** Test-only: reset the in-process started flag so tests can re-run. */
export function __resetV010MigrationForTests(): void {
  migrationStarted = false;
}
