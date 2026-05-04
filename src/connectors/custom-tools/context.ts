import { AsyncLocalStorage } from "node:async_hooks";

/**
 * AsyncLocalStorage-backed call-stack tracker for the Custom Tools runner.
 *
 * Why this exists (CR-01): the manifest wrapper
 * (`buildCustomToolDefinition`) is what an outer Custom Tool calls when
 * its step references another Custom Tool by name (the lookup goes
 * through the registry, not through the runner directly). Before this
 * fix, the wrapper called `runCustomTool(B)` with no memory of the outer
 * A frame, so A→B→A was only caught by the JS engine's stack overflow —
 * way too late, and on Vercel the lambda would crash with runaway
 * billing implications.
 *
 * Putting the active-ids set in an AsyncLocalStorage means any nested
 * `runCustomTool` call automatically sees the parent's call-stack,
 * regardless of the path that triggered it (manifest wrapper, direct
 * runner call from a test endpoint, …). The runner reads the previous
 * set, validates `tool.id` is not in it, then re-runs its body inside an
 * extended context so deeper nesting still inherits.
 */

const activeIdsStore = new AsyncLocalStorage<Set<string>>();

/**
 * Return the set of Custom Tool ids currently on the call stack. Returns
 * an empty set when called outside any Custom Tool execution.
 *
 * The returned set is a defensive copy — callers must not mutate it.
 */
export function getActiveCustomToolIds(): Set<string> {
  const current = activeIdsStore.getStore();
  return current ? new Set(current) : new Set();
}

/**
 * Run `fn` with `activeIds` installed as the call-stack snapshot. Any
 * `runCustomTool` invocation inside `fn` (direct or via the manifest
 * wrapper) will see this set as the previous active set.
 */
export function runWithActiveCustomToolIds<T>(
  activeIds: Set<string>,
  fn: () => Promise<T>
): Promise<T> {
  return activeIdsStore.run(activeIds, fn);
}
