"use client";

import type { JSX } from "react";
import { useWelcomeDispatch, useWelcomeState } from "../WelcomeStateContext";

/**
 * TestStep — Phase 45 Task 4 (UX-01a).
 *
 * Step 3 of the welcome wizard. Exercises the MCP endpoint with the
 * freshly-minted token to confirm the auth handshake works, surfaces
 * a snippet for pasting into the user's MCP client (TokenUsagePanel),
 * offers the StarterSkillsPanel tour, and hands off to /config.
 *
 * Scope boundary (this commit): extracted as a dormant component
 * wired to `useWelcomeState()` / `useWelcomeDispatch()`. The full
 * JSX subtree (TestMcpPanel, TokenUsagePanel, StarterSkillsPanel,
 * /config handoff — 230+ lines in the legacy welcome-client) stays
 * in `welcome-client.tsx` for this phase. Extraction path is
 * unblocked; a later phase can migrate the JSX verbatim.
 *
 * Test-MCP fetch is inline here (not yet abstracted to a hook)
 * because it's fire-once on a button click, not a polling effect
 * — the ≤ 1 useEffect budget that drove the hook extraction for
 * claim/storage/mint doesn't apply.
 */
export function TestStep(): JSX.Element {
  const state = useWelcomeState();
  const dispatch = useWelcomeDispatch();

  const runMcpTest = async (): Promise<void> => {
    if (!state.token) return;
    dispatch({ type: "TEST_STARTED" });
    try {
      const res = await fetch("/api/welcome/test-mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: state.token }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      dispatch({ type: "TEST_RESOLVED", ok: data.ok, error: data.error });
    } catch (err) {
      dispatch({
        type: "TEST_RESOLVED",
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <section aria-label="Test MCP connection">
      <h2 className="text-xl font-bold mb-2">Connect an AI client</h2>
      <p className="text-sm text-slate-400 mb-4">
        Verify the token works end-to-end before leaving setup.
      </p>

      {state.testStatus === "idle" && (
        <button
          type="button"
          onClick={() => void runMcpTest()}
          className="bg-blue-500 text-white px-5 py-2 rounded-md text-sm font-semibold mb-4"
        >
          Test MCP connection
        </button>
      )}
      {state.testStatus === "testing" && <p className="text-xs text-slate-400 mb-4">Testing…</p>}
      {state.testStatus === "ok" && (
        <p className="text-xs text-emerald-300 mb-4">✓ MCP handshake succeeded</p>
      )}
      {state.testStatus === "fail" && (
        <p className="text-xs text-red-400 mb-4">
          ✗ Test failed: {state.testError ?? "unknown error"}
        </p>
      )}

      <a
        href="/config"
        className="inline-block bg-emerald-500 hover:bg-emerald-400 text-white px-5 py-2 rounded-md text-sm font-semibold"
      >
        Finish → Open dashboard
      </a>
    </section>
  );
}
