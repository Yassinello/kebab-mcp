/**
 * withBootstrapRehydrate — DUR-02
 *
 * HOC wrapping a Next.js route handler. Ensures `rehydrateBootstrapAsync()`
 * runs before the inner handler, so any auth-gated / bootstrap-aware
 * handler that reads MCP_AUTH_TOKEN or calls isFirstRunMode() sees the
 * durable state rehydrated from /tmp or KV on cold lambdas.
 *
 * Every auth-gated route under `app/api/**` should either be wrapped in
 * this HOC or carry a `// BOOTSTRAP_EXEMPT: <reason>` marker in the first
 * 10 lines of the file. See the `route-rehydrate-coverage` contract test.
 *
 * Also triggers the one-shot v0.10 tenant-prefix migration on the FIRST
 * invocation per process (module-flag gated, fire-and-forget annotated).
 * Moved here from `first-run.ts` — the migration trigger used to fire on
 * every `rehydrateBootstrapAsync()` call, which made test order depend
 * on a module-load disk-I/O side effect (see ARCH-AUDIT §3).
 *
 * @see .planning/milestones/v0.10-durability-ROADMAP.md DUR-01..03
 */

import { rehydrateBootstrapAsync } from "./first-run";
import { runV010TenantPrefixMigration } from "./migrations/v0.10-tenant-prefix";

/** Marker string used by the contract test to recognize exempt route files. */
export const BOOTSTRAP_EXEMPT_MARKER = "BOOTSTRAP_EXEMPT:";

// Module-scope one-shot flag for the background migration trigger. Reset
// only by `__resetBootstrapRehydrateForTests()`.
let migrationScheduled = false;

// Any Next.js route handler signature: first arg is the Request, optional
// trailing arg is the dynamic-route ctx `{ params: Promise<...> }`. The
// generic `H` below preserves whichever signature the caller produced.
type AnyHandler = (req: Request, ...rest: never[]) => Promise<Response>;

/**
 * Wrap a Next.js route handler so `rehydrateBootstrapAsync()` runs before
 * the inner handler. Rehydrate is internally idempotent; wrapping a handler
 * that also calls it directly is safe (and will be the case during the
 * DUR-01 migration sweep until the inline calls are cleaned up).
 *
 * Re-throws rehydrate errors — the caller (Next.js) decides how to respond.
 * No swallowing; the session-bug class was partly caused by silent
 * swallows hiding infrastructure failures.
 *
 * Generic `H` preserves the caller's exact signature (including ctx type
 * for dynamic routes like `[id]/route.ts`) — `wrapped as H` is a safe
 * cast because the wrapper forwards `...rest` verbatim. Using `never[]`
 * on the bound keeps `H` contravariant so routes with typed ctx (e.g.
 * `{ params: Promise<{ id: string }> }`) still satisfy `H extends AnyHandler`.
 */
export function withBootstrapRehydrate<H extends AnyHandler>(handler: H): H {
  const wrapped = (async (req: Request, ...rest: unknown[]): Promise<Response> => {
    await rehydrateBootstrapAsync();
    if (!migrationScheduled) {
      migrationScheduled = true;
      // fire-and-forget OK: v0.10 one-shot tenant-prefix migration; KV-flagged idempotent, never blocks request path
      void runV010TenantPrefixMigration().catch(() => {});
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (handler as unknown as (req: Request, ...r: any[]) => Promise<Response>)(req, ...rest);
  }) as unknown as H;
  return wrapped;
}

/**
 * Test-only helper: resets the one-shot migration flag so tests can
 * exercise the first-request-in-process code path repeatedly.
 */
export function __resetBootstrapRehydrateForTests(): void {
  migrationScheduled = false;
}
