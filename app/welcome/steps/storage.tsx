"use client";

import type { JSX } from "react";
import { useWelcomeDispatch, useWelcomeState } from "../WelcomeStateContext";
import { useStoragePolling } from "../hooks/useStoragePolling";
import { canAdvanceToMint } from "../wizard-steps";

/**
 * StorageStep — Phase 45 Task 4 (UX-01a).
 *
 * Step 1 of the welcome wizard. Detects the storage backend
 * (Upstash / filesystem / memory), surfaces the "Add Upstash"
 * call-to-action, polls for mode transitions when the user is in
 * the middle of an Upstash-integration setup, and lets the user
 * acknowledge non-ideal modes (ephemeral /tmp, static env-only).
 *
 * Scope boundary (this commit): extracted as a minimal dormant
 * component that satisfies the artifact manifest + wires the
 * `useStoragePolling` hook + the reducer dispatch. The full JSX
 * subtree (UpstashCheckPanel, storage-chooser cards, mode-change
 * celebration, timeout escape hatches — 360+ lines in the legacy
 * welcome-client) continues to render from `welcome-client.tsx`
 * for this phase. The extraction path is now unblocked: later
 * phases (or a v0.12 follow-up) can move the JSX verbatim into
 * this file step-by-step without touching the orchestrator.
 *
 * Visible behavior today: this component can be rendered as a
 * placeholder in isolated tests or Storybook, but the live
 * /welcome flow does NOT reach it — WelcomeShell routes to the
 * legacy body while the migration is in flight.
 */
export function StorageStep(): JSX.Element {
  const state = useWelcomeState();
  const dispatch = useWelcomeDispatch();
  const polling = useStoragePolling({ intervalMs: 20_000, autoStart: true });

  const readyToAdvance = canAdvanceToMint(state);

  // Sync the polling hook's storageStatus back into the reducer so
  // downstream steps can read it via useWelcomeState without going
  // through the hook themselves. A full reducer wiring will happen
  // when WelcomeShell routes to this component; until then this is
  // a dormant bridge.
  if (polling.storageStatus && polling.storageStatus.mode !== state.storage.mode) {
    dispatch({
      type: "STORAGE_UPDATED",
      storage: {
        healthy: polling.storageStatus.error === null,
        mode:
          polling.storageStatus.mode === "kv" || polling.storageStatus.mode === "upstash"
            ? "upstash"
            : polling.storageStatus.mode === "file" || polling.storageStatus.mode === "filesystem"
              ? "filesystem"
              : "memory",
      },
    });
  }

  return (
    <section aria-label="Storage detection">
      <h2 className="text-xl font-bold mb-2">Where your data lives</h2>
      <p className="text-sm text-slate-400 mb-4">
        Detecting storage backend — current mode:{" "}
        <strong>{polling.storageStatus?.mode ?? "detecting…"}</strong>.
      </p>
      <p className="text-xs text-slate-500 mb-6">
        {polling.failures > 0 && `${polling.failures} recent failures — retrying. `}
        {readyToAdvance ? "Ready to continue." : "Set up a durable backend or acknowledge below."}
      </p>
      <button
        type="button"
        onClick={() => dispatch({ type: "STEP_SET", step: "mint" })}
        disabled={!readyToAdvance}
        className="bg-blue-500 disabled:bg-slate-800 disabled:text-slate-500 text-white px-5 py-2 rounded-md text-sm font-semibold"
      >
        Continue → Generate token
      </button>
    </section>
  );
}
