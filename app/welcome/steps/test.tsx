"use client";

import { PRODUCT } from "@/core/constants/brand";
import {
  claudeAddConnectorUrl,
  claudeCodeAddCommand,
  cursorInstallUrl,
  SETUP_PHRASE,
} from "@/core/client-links";
import { useCallback, useEffect, useState, type JSX, type ReactNode } from "react";
import { useWelcomeDispatch, useWelcomeState } from "../WelcomeStateContext";

/**
 * TestStep — step 3 of the welcome wizard: connect an AI client.
 *
 * Order (audit C2.1): Claude first (one button, then the setup phrase),
 * then the clients that sign in on their own from a URL (Claude Code,
 * Cursor, ChatGPT), then "other clients", which get their own device token
 * from the dashboard after setup. The admin key minted on step 2 is never
 * shown here: AI clients do not use it.
 *
 * The MCP self-test is an optional check; "Open my dashboard" is always
 * available. The dashboard hand-off passes the admin key as `?token=` so
 * the proxy sets the admin cookie on the first hit (then strips it).
 */

export interface TestStepProps {
  /** Orchestrator-derived: durable storage backend (kv | non-ephemeral file). */
  durableBackend: boolean;
  onBack?: () => void;
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

  const dashboardHref = state.token
    ? `/config?token=${encodeURIComponent(state.token)}`
    : "/config";

  return (
    <section>
      <header className="mb-6">
        <h1 className="text-2xl sm:text-3xl font-bold text-white tracking-tight mb-2">
          Connect your AI client
        </h1>
        <p className="text-sm text-slate-400 leading-relaxed">
          Every AI client you connect shares the same {PRODUCT.name}: your profile, your skills and
          your notes. Start with one, add the others whenever you like.
        </p>
      </header>

      <ClaudePanel mcpUrl={mcpUrl} />
      <UrlClientsPanel mcpUrl={mcpUrl} />
      <OtherClientsPanel />

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
          className="inline-block px-5 py-2.5 rounded-lg font-semibold text-sm transition-colors bg-blue-500 hover:bg-blue-400 text-white"
        >
          Open my dashboard →
        </a>
      </div>
    </section>
  );
}

// ── Panels ────────────────────────────────────────────────────────────

function Panel({ step, title, children }: { step?: string; title: string; children: ReactNode }) {
  return (
    <div className="mb-6 rounded-lg border border-slate-800 bg-slate-900/40 p-5">
      <p className="text-sm font-semibold text-white mb-3">
        {step && <span className="text-blue-300 mr-2">{step}</span>}
        {title}
      </p>
      {children}
    </div>
  );
}

function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // Ignore: older browsers / insecure origins.
        }
      }}
      className="shrink-0 bg-slate-800 hover:bg-slate-700 text-slate-200 px-3 py-1.5 rounded-md text-xs font-semibold border border-slate-700"
    >
      {copied ? "Copied ✓" : label}
    </button>
  );
}

function CopyLine({ value }: { value: string }) {
  return (
    <div className="flex items-center gap-2">
      <code className="flex-1 min-w-0 break-all text-xs text-blue-200 font-mono bg-slate-950/50 border border-slate-800 rounded-md px-3 py-2">
        {value}
      </code>
      <CopyButton value={value} />
    </div>
  );
}

/** 1. Claude: one button, then the setup phrase. */
function ClaudePanel({ mcpUrl }: { mcpUrl: string }) {
  return (
    <Panel step="1" title="Claude (web, desktop and mobile)">
      <ol className="space-y-3 text-xs text-slate-400 leading-relaxed list-decimal list-inside">
        <li>
          <a
            href={claudeAddConnectorUrl(mcpUrl)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 bg-blue-500 hover:bg-blue-400 text-white px-4 py-1.5 rounded-md text-xs font-semibold"
          >
            Add to Claude
          </a>
          <p className="mt-1.5">
            Claude then sends you to your {PRODUCT.name} page to approve the connection and choose
            what Claude may do. If it asks you to sign in, use your admin key.
          </p>
        </li>
        <li>
          Then, in a new chat, say:
          <div className="mt-1.5">
            <CopyLine value={SETUP_PHRASE} />
          </div>
          <p className="mt-1.5">
            Claude interviews you for a few minutes, writes your profile with you and sets up your
            first rituals.
          </p>
        </li>
      </ol>
    </Panel>
  );
}

/** 2. Clients that sign in on their own from the URL. */
function UrlClientsPanel({ mcpUrl }: { mcpUrl: string }) {
  return (
    <Panel step="2" title="Claude Code, Cursor, ChatGPT">
      <p className="text-xs text-slate-400 leading-relaxed mb-3">
        These clients only need your {PRODUCT.name} URL. You sign in from the client itself, the
        same way as for Claude.
      </p>
      <CopyLine value={mcpUrl} />
      <ul className="mt-4 space-y-3 text-xs text-slate-400 leading-relaxed">
        <li>
          <p className="font-semibold text-slate-300 mb-1">Claude Code</p>
          <CopyLine value={claudeCodeAddCommand(mcpUrl)} />
        </li>
        <li>
          <p className="font-semibold text-slate-300 mb-1">Cursor</p>
          <a
            href={cursorInstallUrl(mcpUrl)}
            className="inline-flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 px-3 py-1.5 rounded-md text-xs font-semibold border border-slate-700"
          >
            Add to Cursor
          </a>
        </li>
        <li>
          <p className="font-semibold text-slate-300 mb-1">ChatGPT</p>
          In ChatGPT on the web: Settings → Apps &amp; Connectors → turn on Developer mode, then
          create a connector with the URL above.
        </li>
      </ul>
    </Panel>
  );
}

/** 3. Clients that cannot sign in: their own device token, after setup. */
function OtherClientsPanel() {
  return (
    <details className="mb-6 rounded-lg border border-slate-800 bg-slate-900/20 group">
      <summary className="cursor-pointer px-5 py-3 text-sm font-semibold text-slate-300 hover:text-white">
        <span className="text-blue-300 mr-2">3</span>Other clients (token)
      </summary>
      <div className="border-t border-slate-800 px-5 py-4 text-xs text-slate-400 leading-relaxed space-y-2">
        <p>
          Some clients cannot sign in and need a token instead. Give each one its own: after setup,
          open your dashboard and go to{" "}
          <strong className="text-slate-300">Devices → Add device</strong>.
        </p>
        <p>
          Each device gets its own token, its own access level and its own entry in the activity
          log, and you can revoke one without touching the others. Do not use your admin key in an
          AI client.
        </p>
      </div>
    </details>
  );
}

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
    <div className="mb-8 rounded-lg border border-slate-800 bg-slate-900/40 p-5">
      <p className="text-sm font-semibold text-white mb-1">Rituals</p>
      <p className="text-[11px] text-slate-500 leading-relaxed mb-4">
        Ready-made routines your AI client runs when you say the phrase. Claude can also install
        them for you during setup. You can change them anytime in your dashboard.
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
  );
}
