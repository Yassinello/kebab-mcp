"use client";

import type { JSX } from "react";
import { useWelcomeDispatch, useWelcomeState } from "../WelcomeStateContext";
import { useMintToken } from "../hooks/useMintToken";
import { canAdvanceToTest } from "../wizard-steps";

/**
 * MintStep — Phase 45 Task 4 (UX-01a).
 *
 * Step 2 of the welcome wizard. Mints the instance's permanent
 * MCP_AUTH_TOKEN, displays it once, gates the "Continue" button
 * behind an explicit "I saved it" acknowledgment, and surfaces the
 * auto-magic env-write + redeploy state.
 *
 * Scope boundary (this commit): extracted as a dormant component
 * that wires `useMintToken` + the reducer dispatch. The full JSX
 * subtree (TokenDisplayPanel, TokenSaveChecklist,
 * TokenPersistencePanel, TokenGenerateExplainer — 590+ lines in the
 * legacy welcome-client) stays in `welcome-client.tsx` for this
 * phase. Extraction path is unblocked; a later phase can migrate the
 * JSX verbatim.
 *
 * UX-04 integration: `useMintToken` surfaces `already_minted` when a
 * concurrent browser wins the SETNX race. This component reads the
 * hook's `error` and renders the appropriate recovery hint without
 * losing the token state.
 */
export function MintStep(): JSX.Element {
  const state = useWelcomeState();
  const dispatch = useWelcomeDispatch();
  const mint = useMintToken();

  const onMint = async (): Promise<void> => {
    const res = await mint.mint({ permanent: false });
    if (res.ok && res.token) {
      dispatch({
        type: "TOKEN_MINTED",
        token: res.token,
        instanceUrl: res.instanceUrl ?? "",
        autoMagic:
          res.autoMagic !== undefined
            ? {
                autoMagic: Boolean(res.autoMagic),
                envWritten: Boolean(res.envWritten),
                redeployTriggered: Boolean(res.redeployTriggered),
                redeployError: res.redeployError,
              }
            : null,
      });
    } else {
      dispatch({ type: "ERROR_SET", error: res.error ?? "Initialization failed." });
    }
  };

  const canContinue = canAdvanceToTest(state);

  return (
    <section aria-label="Mint auth token">
      <h2 className="text-xl font-bold mb-2">Generate your auth token</h2>
      {!state.token ? (
        <>
          <p className="text-sm text-slate-400 mb-4">
            Your AI client uses this token as a bearer credential on every request.
          </p>
          {mint.error && (
            <p className="text-xs text-red-400 mb-3">
              {mint.error === "already_minted"
                ? "Another browser already minted this instance — paste the token you saved instead."
                : mint.error}
            </p>
          )}
          <button
            type="button"
            onClick={() => void onMint()}
            disabled={mint.busy}
            className="bg-blue-500 disabled:bg-slate-800 text-white px-5 py-2 rounded-md text-sm font-semibold"
          >
            {mint.busy ? "Generating…" : "Generate my token"}
          </button>
        </>
      ) : (
        <>
          <p className="text-sm text-slate-400 mb-2">Token minted — save it before continuing.</p>
          <label className="flex items-center gap-2 mb-4 text-xs text-slate-300">
            <input
              type="checkbox"
              checked={state.tokenSaved}
              onChange={(e) => dispatch({ type: "TOKEN_SAVED_SET", tokenSaved: e.target.checked })}
            />
            I saved this token in a password manager
          </label>
          <button
            type="button"
            onClick={() => dispatch({ type: "STEP_SET", step: "test" })}
            disabled={!canContinue}
            className="bg-blue-500 disabled:bg-slate-800 disabled:text-slate-500 text-white px-5 py-2 rounded-md text-sm font-semibold"
          >
            Continue → Connect
          </button>
        </>
      )}
    </section>
  );
}
