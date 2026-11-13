"use client";

import { PRODUCT } from "@/core/constants/brand";
import { useCallback, useEffect, useState, type JSX } from "react";
import { McpClientSnippets } from "../../components/mcp-client-snippets";
import { useWelcomeDispatch, useWelcomeState } from "../WelcomeStateContext";

/**
 * TestStep — Phase 47 WIRE-01c (v2, live).
 *
 * Step 3 of the welcome wizard. Exercises the MCP endpoint with the
 * freshly-minted token to confirm the auth handshake works, surfaces
 * the client-side snippet for pasting into Claude Desktop / Cursor /
 * etc., optional StarterSkillsPanel tour, and hands off to /config
 * via `?token=…` handoff.
 *
 * JSX migrated verbatim from `renderStepConnect` + TestMcpPanel +
 * TokenUsagePanel + StarterSkillsPanel + MultiClientNote closures in
 * `WelcomeShell.tsx`. State flows via the reducer (`state.token`,
 * `state.instanceUrl`, `state.testStatus`, `state.testError`).
 *
 * Test-MCP fetch is an inline useCallback — fire-once on a button
 * click, no polling loop, doesn't warrant a dedicated hook (per
 * ROADMAP Phase 47 judgment call).
 *
 * Persistence-ready gate (BUG-04 / commit f818e01 contract): the
 * `Test MCP` button enables whenever the backend is durable
 * (state.storage.durable) OR Vercel env-var landed
 * (state.permanent). Reads `durableBackend` prop from the
 * orchestrator so the gate semantics match the mint step's
 * persistenceReady derivation.
 */

export interface TestStepProps {
  /** Orchestrator-derived: durable storage backend (kv | non-ephemeral file). */
  durableBackend: boolean;
  onBack?: () => void;
}

export function TestStep({ durableBackend, onBack }: TestStepProps): JSX.Element {
  const state = useWelcomeState();
  const dispatch = useWelcomeDispatch();

  // Step-local transient: `skipTest` — user can bypass the MCP probe
  // after confirming persistence is ready. Not a reducer field.
  const [skipTest, setSkipTest] = useState(false);

  const persistenceReady = durableBackend || state.permanent;

  const runMcpTest = useCallback(async () => {
    if (!state.token) return;
    dispatch({ type: "TEST_STARTED" });
    try {
      const res = await fetch("/api/welcome/test-mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: state.token }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      dispatch({
        type: "TEST_RESOLVED",
        ok: Boolean(data.ok),
        error: data.ok ? undefined : data.error || "MCP test failed",
      });
    } catch (err) {
      dispatch({
        type: "TEST_RESOLVED",
        ok: false,
        error: err instanceof Error ? err.message : "Network error",
      });
    }
  }, [state.token, dispatch]);

  const canContinue = persistenceReady && (state.testStatus === "ok" || skipTest);

  return (
    <section>
      <StepHeader
        title="Connect your AI client"
        subtitle={`Add ${PRODUCT.name} to your client's MCP server config, then verify it works.`}
      />

      {state.token && <TokenUsagePanel token={state.token} instanceUrl={state.instanceUrl} />}
      <MultiClientNote />

      <TestMcpPanel
        persistenceReady={persistenceReady}
        testStatus={state.testStatus}
        testError={state.testError}
        runMcpTest={runMcpTest}
      />

      {state.token && <StarterSkillsPanel />}

      <StepFooter
        secondary={onBack ? { label: "← Auth token", onClick: onBack } : undefined}
        primary={{
          label: canContinue ? "Open dashboard →" : "Test your MCP connection first",
          enabled: canContinue,
          // Pass the token as `?token=` so the middleware sets the
          // `mymcp_admin_token` cookie on the first hit. Without this,
          // /config is admin-gated and returns 401 the moment we land
          // — the user finishes welcome only to be told "Unauthorized".
          href:
            canContinue && state.token
              ? `/config?token=${encodeURIComponent(state.token)}`
              : undefined,
        }}
        tertiary={
          !canContinue && !skipTest
            ? {
                label: "Skip test and continue anyway",
                onClick: () => setSkipTest(true),
              }
            : undefined
        }
      />
    </section>
  );
}

// ── Shared step chrome ────────────────────────────────────────────────

function StepHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <header className="mb-6">
      <h1 className="text-2xl sm:text-3xl font-bold text-white tracking-tight mb-2">{title}</h1>
      <p className="text-sm text-slate-400 leading-relaxed">{subtitle}</p>
    </header>
  );
}

function StepFooter({
  primary,
  secondary,
  tertiary,
}: {
  primary: {
    label: string;
    enabled: boolean;
    onClick?: (() => void) | undefined;
    href?: string | undefined;
  };
  secondary?: { label: string; onClick: () => void } | undefined;
  tertiary?: { label: string; onClick: () => void } | undefined;
}) {
  return (
    <div className="mt-8 flex items-center justify-between gap-3 flex-wrap">
      <div className="flex items-center gap-3">
        {secondary && (
          <button
            type="button"
            onClick={secondary.onClick}
            className="text-xs text-slate-500 hover:text-slate-300 px-2 py-1.5"
          >
            {secondary.label}
          </button>
        )}
        {tertiary && (
          <button
            type="button"
            onClick={tertiary.onClick}
            className="text-xs text-slate-600 hover:text-slate-400 underline"
          >
            {tertiary.label}
          </button>
        )}
      </div>
      {primary.href ? (
        <a
          href={primary.enabled ? primary.href : undefined}
          aria-disabled={!primary.enabled}
          onClick={(e) => {
            if (!primary.enabled) e.preventDefault();
          }}
          className={`inline-block px-5 py-2.5 rounded-lg font-semibold text-sm transition-colors ${
            primary.enabled
              ? "bg-blue-500 hover:bg-blue-400 text-white"
              : "bg-slate-800 text-slate-500 cursor-not-allowed"
          }`}
        >
          {primary.label}
        </a>
      ) : (
        <button
          type="button"
          onClick={primary.enabled ? primary.onClick : undefined}
          disabled={!primary.enabled}
          className={`inline-block px-5 py-2.5 rounded-lg font-semibold text-sm transition-colors ${
            primary.enabled
              ? "bg-blue-500 hover:bg-blue-400 text-white cursor-pointer"
              : "bg-slate-800 text-slate-500 cursor-not-allowed"
          }`}
        >
          {primary.label}
        </button>
      )}
    </div>
  );
}

// ── Test-step panels ──────────────────────────────────────────────────

function TestMcpPanel({
  persistenceReady,
  testStatus,
  testError,
  runMcpTest,
}: {
  persistenceReady: boolean;
  testStatus: "idle" | "testing" | "ok" | "fail";
  testError: string | null;
  runMcpTest: () => void;
}) {
  return (
    <div className="mb-6 rounded-lg border border-slate-800 bg-slate-900/40 p-5">
      <p className="text-sm font-semibold text-white mb-1">Verify your install</p>
      <p className="text-[11px] text-slate-500 leading-relaxed mb-4">
        Test that your token authenticates against <code className="font-mono">/api/mcp</code> on
        this instance. Once it passes, the dashboard unlocks.
      </p>

      <ol className="space-y-2 mb-4 text-xs">
        <li className="flex items-center gap-2">
          <span aria-hidden>{persistenceReady ? "✓" : "⏳"}</span>
          <span className={persistenceReady ? "text-emerald-300" : "text-amber-300"}>
            {persistenceReady
              ? "Token persisted (durable across cold starts)"
              : "Waiting for Vercel redeploy (auto-polling)…"}
          </span>
        </li>
        <li className="flex items-center gap-2">
          <span aria-hidden>{testStatus === "ok" ? "✓" : testStatus === "fail" ? "✗" : "□"}</span>
          <span
            className={
              testStatus === "ok"
                ? "text-emerald-300"
                : testStatus === "fail"
                  ? "text-red-300"
                  : "text-slate-400"
            }
          >
            {testStatus === "idle" && "MCP endpoint not tested yet"}
            {testStatus === "testing" && "Testing MCP endpoint…"}
            {testStatus === "ok" && "MCP endpoint responded — install confirmed"}
            {testStatus === "fail" && `Test failed: ${testError ?? "unknown error"}`}
          </span>
        </li>
      </ol>

      <button
        type="button"
        onClick={runMcpTest}
        disabled={!persistenceReady || testStatus === "testing"}
        className="bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed text-slate-200 px-4 py-2 rounded-md text-xs font-semibold transition-colors"
      >
        {testStatus === "testing"
          ? "Testing…"
          : testStatus === "ok"
            ? "Re-run test"
            : "Test MCP connection"}
      </button>
      {!persistenceReady && (
        <span className="ml-3 text-[11px] text-slate-600">
          (enabled once persistence is confirmed)
        </span>
      )}
    </div>
  );
}

function TokenUsagePanel({ token, instanceUrl }: { token: string; instanceUrl: string }) {
  const baseUrl = instanceUrl || "https://YOUR-INSTANCE.vercel.app";
  return (
    <div className="mb-8 rounded-lg border border-slate-800 bg-slate-900/40 p-5">
      <p className="text-sm font-semibold text-white mb-3">How to use this token</p>
      <McpClientSnippets baseUrl={baseUrl} token={token} theme="welcome" />
    </div>
  );
}

function MultiClientNote() {
  return (
    <div className="mb-8 rounded-lg border border-slate-800 bg-slate-900/30 px-4 py-3">
      <p className="text-xs font-semibold text-slate-300 mb-1">One token, any number of clients</p>
      <p className="text-[11px] text-slate-500 leading-relaxed">
        The same token works in <strong className="text-slate-300">every</strong> MCP client —
        Claude Desktop, Claude Code, Cursor, ChatGPT, etc. Just paste it everywhere. Use multiple
        comma-separated tokens (in the{" "}
        <code className="font-mono text-slate-400">MCP_AUTH_TOKEN</code> env var) only if you want
        to revoke one client without breaking the others.
      </p>
    </div>
  );
}

// ── Starter skills panel ──────────────────────────────────────────────

interface StarterSkill {
  id: string;
  name: string;
  description: string;
  icon: string;
}

function StarterSkillsPanel() {
  const [skills, setSkills] = useState<StarterSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/welcome/starter-skills", { credentials: "include" });
        if (!res.ok) {
          if (!cancelled) setLoading(false);
          return;
        }
        const data = (await res.json()) as { skills: StarterSkill[] };
        if (!cancelled) {
          setSkills(data.skills || []);
          setLoading(false);
        }
      } catch {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const install = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch("/api/welcome/starter-skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ id }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (data.ok) {
        setInstalled((s) => {
          const next = new Set(s);
          next.add(id);
          return next;
        });
      } else {
        setError(data.error || "Install failed");
      }
    } catch {
      setError("Network error");
    }
    setBusy(null);
  };

  if (loading) return null;
  if (skills.length === 0) return null;

  return (
    <div className="mb-8 rounded-lg border border-slate-800 bg-slate-900/40 p-5">
      <div className="flex items-baseline justify-between gap-2 mb-3 flex-wrap">
        <p className="text-sm font-semibold text-white">Or skip credentials — start with a skill</p>
        <span className="text-[11px] text-slate-500">No connector setup required</span>
      </div>
      <p className="text-[11px] text-slate-500 leading-relaxed mb-4">
        Skills are reusable prompt templates exposed to your AI client as MCP tools. These three
        starters work in any client without needing Google, Notion, GitHub, or any other
        credentials. Install one now to feel the value, then come back to set up real connectors
        when you&apos;re ready.
      </p>
      <ul className="space-y-2">
        {skills.map((s) => {
          const done = installed.has(s.id);
          return (
            <li
              key={s.id}
              className="flex items-start gap-3 rounded-md border border-slate-800 bg-slate-950 p-3"
            >
              <span className="text-xl leading-none mt-0.5" aria-hidden>
                {s.icon}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-slate-200">
                  <code className="font-mono text-blue-300">skill_{s.name}</code>
                </p>
                <p className="text-[11px] text-slate-500 mt-0.5">{s.description}</p>
              </div>
              <button
                type="button"
                onClick={() => !done && install(s.id)}
                disabled={done || busy === s.id}
                className={`shrink-0 text-[11px] font-semibold px-3 py-1.5 rounded-md transition-colors ${
                  done
                    ? "bg-emerald-900/60 text-emerald-300 cursor-default"
                    : "bg-blue-500 hover:bg-blue-400 text-white disabled:opacity-50"
                }`}
              >
                {done ? "Installed ✓" : busy === s.id ? "Installing…" : "Install"}
              </button>
            </li>
          );
        })}
      </ul>
      {error && (
        <p className="mt-3 text-[11px] text-red-300">
          {error} — you can also add starter skills later from /config → Skills.
        </p>
      )}
    </div>
  );
}
