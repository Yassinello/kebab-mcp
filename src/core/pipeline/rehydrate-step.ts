/**
 * rehydrateStep — PIPE-07.
 *
 * Equivalent semantics to `withBootstrapRehydrate`: awaits
 * `rehydrateBootstrapAsync()` before yielding to the next step, and fires
 * the one-shot v0.10 tenant-prefix migration exactly once per process.
 *
 * Implementation intentionally mirrors the HOC byte-for-byte (module
 * flag `migrationScheduled`, `void … .catch(() => {})` fire-and-forget)
 * so the two paths stay in lock-step and `withBootstrapRehydrate`
 * remains the canonical backwards-compat adapter for BOOTSTRAP_EXEMPT
 * routes that haven't (or won't) migrate to the pipeline.
 */

import type { Step } from "./types";
import { rehydrateBootstrapAsync } from "../first-run";
import { runV010TenantPrefixMigration } from "../migrations/v0.10-tenant-prefix";

// Module-scope one-shot flag for the background migration trigger. Reset
// only by `__resetRehydrateStepForTests()`.
let migrationScheduled = false;

export const rehydrateStep: Step = async (_ctx, next) => {
  await rehydrateBootstrapAsync();
  if (!migrationScheduled) {
    migrationScheduled = true;
    // fire-and-forget OK: v0.10 one-shot tenant-prefix migration; KV-flagged idempotent, never blocks request path
    void runV010TenantPrefixMigration().catch(() => {});
  }
  return next();
};

/**
 * Test-only helper: resets the one-shot migration flag so tests can
 * exercise the first-request-in-process code path repeatedly.
 */
export function __resetRehydrateStepForTests(): void {
  migrationScheduled = false;
}
