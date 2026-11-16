"use client";

import { useEffect, useState, type JSX } from "react";
import { extractTokenFromInput } from "@/core/welcome-url-parser";
import { useClaimStatus } from "../hooks/useClaimStatus";
import { useWelcomeDispatch } from "../WelcomeStateContext";

/**
 * AlreadyInitializedPanel — Phase 45 Task 4 (UX-01a) + Phase 47 WIRE-01d (live).
 *
 * Alt-flow terminal screen: the instance is already bootstrapped +
 * has a durable token. The user visited /welcome but setup is done;
 * they just need to unlock the dashboard. Accepts either the bare
 * token (64-char hex) OR the full MCP URL (https://…?token=…) and
 * hands off to `/config?token=…` — middleware turns the query param
 * into a `mymcp_admin_token` cookie + clean redirect.
 *
 * Includes the "Lost your token?" recovery details block (commit
 * bc31b69 + 4e6fa0c precedent) — a pragmatic inline hint that replaces
 * the bare /config link that pre-bc31b69 produced a bare 401 at the
 * very end of the flow.
 *
 * Phase 47 WIRE-01d: optionally drives a CLAIM_RESOLVED dispatch to
 * keep the reducer in sync when this panel renders in response to
 * `useClaimStatus()` returning "already-initialized". Callers that
 * already know the claim state (e.g. WelcomeShell's outer claim hook)
 * can skip the internal hook by passing `skipClaimSync`.
 */
export function AlreadyInitializedPanel({
  skipClaimSync,
}: {
  /** When true, don't invoke useClaimStatus() — caller already owns the claim. */
  skipClaimSync?: boolean;
} = {}): JSX.Element {
  const [tokenInput, setTokenInput] = useState("");
  const extracted = extractTokenFromInput(tokenInput);
  const href = extracted ? `/config?token=${encodeURIComponent(extracted)}` : undefined;
  const inputLooksLikeUrl = /^https?:\/\//i.test(tokenInput.trim());

  const dispatch = useWelcomeDispatch();
  // Internal claim re-sync: only relevant when this panel is rendered
  // without the orchestrator having already resolved the claim. Always
  // calling the hook (React rules) but gating the dispatch.
  const { claim } = useClaimStatus();
  useEffect(() => {
    if (skipClaimSync) return;
    if (claim === "already-initialized") {
      dispatch({ type: "CLAIM_RESOLVED", claim: "already-initialized" });
    }
  }, [skipClaimSync, claim, dispatch]);

  return (
    <section aria-label="Already initialized" className="max-w-xl">
      <h1 className="text-2xl font-bold text-white mb-2">Already initialized</h1>
      <p className="text-slate-400 mb-6 leading-relaxed">
        Setup is done. Paste the admin key you saved to open your dashboard. It is removed from the
        address bar right away, so it does not stay in your browser history.
      </p>
      <label className="block mb-2 text-[11px] uppercase tracking-wider text-slate-500 font-semibold">
        Your admin key
      </label>
      <input
        type="password"
        value={tokenInput}
        onChange={(e) => setTokenInput(e.target.value)}
        placeholder="64-char hex OR https://…/api/mcp?token=…"
        autoComplete="off"
        spellCheck={false}
        className="w-full font-mono text-sm bg-slate-950 border border-slate-800 rounded-md px-3 py-2 text-blue-200 focus:outline-none focus:border-blue-600 mb-2"
      />
      {inputLooksLikeUrl && extracted && extracted !== tokenInput.trim() && (
        <p className="text-[11px] text-emerald-400 mb-4">
          ✓ Detected MCP URL — token extracted from the <code className="font-mono">?token=</code>{" "}
          parameter.
        </p>
      )}
      {inputLooksLikeUrl && extracted === tokenInput.trim() && (
        <p className="text-[11px] text-amber-400 mb-4">
          URL detected but no <code className="font-mono">?token=</code> parameter found — paste the
          token directly, or the full URL that contains it.
        </p>
      )}
      {!inputLooksLikeUrl && <div className="mb-4" />}
      <a
        href={href}
        aria-disabled={!href}
        onClick={(e) => {
          if (!href) e.preventDefault();
        }}
        className={`inline-block px-5 py-2.5 rounded-lg font-semibold text-sm transition-colors ${
          href
            ? "bg-blue-500 hover:bg-blue-400 text-white"
            : "bg-slate-800 text-slate-500 cursor-not-allowed"
        }`}
      >
        Open dashboard →
      </a>
      <details className="mt-8 text-xs text-slate-500">
        <summary className="cursor-pointer hover:text-slate-300">Lost your admin key?</summary>
        <p className="mt-2 leading-relaxed">
          Check the password manager where you saved it during setup, or look for{" "}
          <code className="font-mono">MCP_AUTH_TOKEN</code> in your hosting&apos;s environment
          variables. If it is truly gone, use &apos;Locked out? Recover access&apos; below to start
          over with a new key.
        </p>
      </details>
    </section>
  );
}
