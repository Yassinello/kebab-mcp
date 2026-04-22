import { toMsg } from "./error-utils";
/**
 * Tiny framework event bus.
 *
 * Lets the registry invalidate its cache reactively when something
 * changes (env vars written, skills created, etc.) instead of rebuilding
 * on every request. Designed to be the opposite of a full pub/sub system:
 * four named events, sync listeners, no priorities, no wildcards.
 *
 * Adding a new event:
 *   1. Add the name to the `FrameworkEvent` union below.
 *   2. Emit it from wherever the mutation happens.
 *   3. Subscribe from the consumer (registry, dashboard SSE, etc.).
 *
 * Not a goal: cross-process / cross-instance delivery. Next.js serverless
 * functions each have their own module state — events emitted in one
 * lambda are invisible to another. For real-time dashboard updates across
 * instances we'd need an external pub/sub (Redis pubsub / NATS / Postgres
 * LISTEN). Tracked for v0.6+.
 *
 * NIT-08 (v0.6): in particular, `env.changed` does NOT propagate across
 * Vercel lambdas. If lambda A writes a setting via `/api/config/env` and
 * emits `env.changed`, lambda B's registry cache stays stale until B is
 * restarted (or the cache invalidated locally). The real fix is the O1
 * roadmap item — move settings to a persistent store with read-through
 * semantics so each lambda sees fresh values without a pub/sub event.
 * Until then, treat in-process invalidation as a best-effort dev nicety,
 * not a multi-lambda guarantee.
 */

export type FrameworkEvent =
  | "env.changed"
  | "connector.toggled"
  | "skill.created"
  | "skill.updated"
  | "skill.deleted";

type Listener = () => void;

const listeners = new Map<FrameworkEvent, Set<Listener>>();

export function on(event: FrameworkEvent, listener: Listener): () => void {
  let set = listeners.get(event);
  if (!set) {
    set = new Set();
    listeners.set(event, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
  };
}

export function emit(event: FrameworkEvent): void {
  const set = listeners.get(event);
  if (!set) return;
  for (const fn of set) {
    try {
      fn();
    } catch (err) {
      // Never let a buggy listener break the emitter.
      console.warn(`[events] listener for ${event} threw:`, toMsg(err));
    }
  }
}

/** Test helper — drop all listeners. Not part of the public API. */
export function __resetEventsForTests(): void {
  listeners.clear();
}
