"use client";

import { useState, type JSX } from "react";
import { extractTokenFromInput } from "@/core/welcome-url-parser";

/**
 * AlreadyInitializedPanel — Phase 45 Task 4 (UX-01a).
 *
 * Alt-flow terminal screen: the instance is already bootstrapped +
 * has a durable token. The user visited /welcome but setup is done;
 * they just need to unlock the dashboard. Accepts either the bare
 * token (64-char hex) OR the full MCP URL (https://…?token=…) and
 * hands off to `/config?token=…` — middleware turns the query param
 * into a `mymcp_admin_token` cookie + clean redirect.
 *
 * This module mirrors the legacy `AlreadyInitializedPanel` closure
 * in `welcome-client.tsx:2098` verbatim, minus the parallel copy of
 * `extractTokenFromInput` — the named export from
 * `src/core/welcome-url-parser.ts` (Phase 45 Task 1) is imported
 * directly, closing Phase 40 FOLLOW-UP A's "parallel
 * re-implementation" concern at the UI-import site too.
 *
 * This component is dormant in this commit (welcome-client still
 * routes to its inline copy). Task 5's WelcomeShell swap is what
 * activates it.
 */
export function AlreadyInitializedPanel(): JSX.Element {
  const [tokenInput, setTokenInput] = useState("");
  const extracted = extractTokenFromInput(tokenInput);
  const href = extracted ? `/config?token=${encodeURIComponent(extracted)}` : undefined;
  const inputLooksLikeUrl = /^https?:\/\//i.test(tokenInput.trim());

  return (
    <section aria-label="Already initialized" className="max-w-xl">
      <h1 className="text-2xl font-bold text-white mb-2">Already initialized</h1>
      <p className="text-slate-400 mb-6 leading-relaxed">
        This instance has a durable token — setup is done. Paste your saved token OR the full MCP
        URL below to unlock the dashboard. We&apos;ll set the cookie and strip the token from the
        URL on the next hop so nothing leaks into your browser history.
      </p>
      <label className="block mb-2 text-[11px] uppercase tracking-wider text-slate-500 font-semibold">
        Your auth token (or full MCP URL)
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
    </section>
  );
}
