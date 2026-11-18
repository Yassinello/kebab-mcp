"use client";

import { PRODUCT } from "@/core/constants/brand";
import { useCallback, useEffect, useState, type JSX } from "react";
import { ConnectClaudeCard } from "../../components/connect-claude-card";
import { useWelcomeDispatch, useWelcomeState } from "../WelcomeStateContext";

/**
 * TestStep — step 3 of the welcome wizard: connect Claude, then say one
 * sentence.
 *
 * The primary action is "Connect Claude" (shared card with the dashboard
 * Overview): one button, the URL to copy, three illustrated steps and the
 * setup phrase. Other clients (Cursor, Claude Code, ChatGPT, token
 * clients) sit in a closed section of the card. The admin key minted on
 * step 2 is never shown here: AI clients do not use it.
 *
 * The MCP self-test is an optional check; "Open my dashboard" is always
 * available. Dashboard links pass the admin key as `?token=` so the proxy
 * sets the admin cookie on the first hit (then strips it, keeping the
 * other query parameters).
 */

export interface TestStepProps {
  /** Orchestrator-derived: durable storage backend (kv | non-ephemeral file). */
  durableBackend: boolean;
  onBack?: () => void;
}

/** Dashboard URL that also signs the browser in when the admin key is known. */
function dashboardUrl(query: string, token: string | null): string {
  const q = new URLSearchParams(query);
  if (token) q.set("token", token);
  const s = q.toString();
  return s ? `/config?${s}` : "/config";
}

export function TestStep({ durableBackend, onBack }: TestStepProps): JSX.Element {
  const state = useWelcomeState();
  const dispatch = useWelcomeDispatch();

  const persistenceReady = durableBackend || state.permanent;
  const origin = state.instanceUrl || (typeof window !== "undefined" ? window.location.origin : "");
  const mcpUrl = `${origin}/api/mcp`;

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

  const dashboardHref = dashboardUrl("", state.token);
  const skillHref = dashboardUrl("tab=skills&panel=kebab-skill", state.token);

  return (
    <section>
      <header className="mb-6">
        <h1 className="text-2xl sm:text-3xl font-bold text-white tracking-tight mb-2">
          Your {PRODUCT.name} is ready
        </h1>
        <p className="text-sm text-slate-400 leading-relaxed">
          Connect Claude, then say one sentence: Claude sets up the rest with you in the
          conversation. Every AI client you connect later shares the same profile, skills and notes.
        </p>
      </header>

      <div className="mb-6">
        <ConnectClaudeCard mcpUrl={mcpUrl} tone="dark" skillHref={skillHref} />
      </div>

      <TestMcpPanel
        persistenceReady={persistenceReady}
        testStatus={state.testStatus}
        testError={state.testError}
        runMcpTest={runMcpTest}
      />

      {state.token && <StarterSkillsPanel />}

      <div className="mt-8 flex items-center justify-between gap-3 flex-wrap">
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            className="text-xs text-slate-500 hover:text-slate-300 px-2 py-1.5"
          >
            ← Admin key
          </button>
        ) : (
          <span />
        )}
        <a
          href={dashboardHref}
          className="inline-block px-5 py-2.5 rounded-lg font-semibold text-sm transition-colors bg-slate-800 hover:bg-slate-700 text-slate-100 border border-slate-700"
        >
          Open my dashboard →
        </a>
      </div>
    </section>
  );
}

// ── Panels ────────────────────────────────────────────────────────────

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
    <div className="mb-6 rounded-lg border border-slate-800 bg-slate-900/20 px-5 py-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <p className="text-xs font-semibold text-slate-300">Check the server (optional)</p>
          <p className="text-[11px] text-slate-500 leading-relaxed">
            Makes one test call to your {PRODUCT.name} server from here.
          </p>
        </div>
        <button
          type="button"
          onClick={runMcpTest}
          disabled={!persistenceReady || testStatus === "testing"}
          className="bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed text-slate-200 px-3 py-1.5 rounded-md text-xs font-semibold border border-slate-700"
        >
          {testStatus === "testing"
            ? "Checking…"
            : testStatus === "idle"
              ? "Run the check"
              : "Run it again"}
        </button>
      </div>
      {testStatus !== "idle" && testStatus !== "testing" && (
        <p
          role="status"
          className={`mt-2 text-xs ${testStatus === "ok" ? "text-emerald-300" : "text-red-300"}`}
        >
          {testStatus === "ok"
            ? "✓ Your server answered. Everything is in place."
            : `✗ The check failed: ${testError ?? "unknown error"}`}
        </p>
      )}
    </div>
  );
}

// ── Starter rituals ───────────────────────────────────────────────────

interface StarterSkill {
  id: string;
  name: string;
  title?: string;
  description: string;
  /** One benefit sentence for humans (catalog field). */
  summary?: string;
  /** What the user says to start it. */
  example?: string;
  icon: string;
  installed?: boolean;
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
          setInstalled(new Set((data.skills || []).filter((s) => s.installed).map((s) => s.id)));
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
    <details className="mb-6 rounded-lg border border-slate-800 bg-slate-900/20">
      <summary className="cursor-pointer px-5 py-3 text-sm font-semibold text-slate-300 hover:text-white">
        Rituals (optional: Claude installs them with you)
      </summary>
      <div className="border-t border-slate-800 px-5 py-4">
        <p className="text-[11px] text-slate-500 leading-relaxed mb-4">
          Ready-made routines your AI client runs when you say the phrase. Claude offers them during
          setup, or install them here now. You can change them anytime in your dashboard.
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
                  <p className="text-sm font-medium text-slate-200">{s.title ?? s.name}</p>
                  <p className="text-[11px] text-slate-400 mt-0.5">{s.summary ?? s.description}</p>
                  {s.example && (
                    <p className="text-[11px] text-slate-500 mt-1">
                      Say: <span className="text-blue-300">&ldquo;{s.example}&rdquo;</span>
                    </p>
                  )}
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
            {error}. You can also install rituals later from your dashboard (Skills).
          </p>
        )}
      </div>
    </details>
  );
}
