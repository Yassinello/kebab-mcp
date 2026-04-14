"use client";

import { useCallback, useEffect, useState } from "react";

type ClaimStatus = "loading" | "new" | "claimer" | "claimed-by-other" | "already-initialized";

interface InitResponse {
  ok: boolean;
  token: string;
  instanceUrl: string;
  autoMagic?: boolean;
  envWritten?: boolean;
  redeployTriggered?: boolean;
  redeployError?: string;
}

interface AutoMagicState {
  autoMagic: boolean;
  envWritten: boolean;
  redeployTriggered: boolean;
  redeployError?: string;
}

interface StatusResponse {
  initialized: boolean;
  permanent: boolean;
  isBootstrap: boolean;
}

export default function WelcomeClient({ initialBootstrap }: { initialBootstrap: boolean }) {
  const [claim, setClaim] = useState<ClaimStatus>("loading");
  const [token, setToken] = useState<string | null>(null);
  const [instanceUrl, setInstanceUrl] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [permanent, setPermanent] = useState(false);
  const [autoMagicState, setAutoMagicState] = useState<AutoMagicState | null>(null);

  // Step 1: claim the instance. If we re-enter with bootstrap already active
  // (user came back to /welcome before the redeploy), auto-call init so we
  // can re-display the token without forcing them to click again. /init is
  // idempotent and returns the existing token.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/welcome/claim", { method: "POST" });
        const data = (await res.json()) as { status: ClaimStatus };
        if (cancelled) return;
        setClaim(data.status);
        if (
          !cancelled &&
          initialBootstrap &&
          (data.status === "claimer" || data.status === "new")
        ) {
          try {
            const initRes = await fetch("/api/welcome/init", { method: "POST" });
            const initData = (await initRes.json()) as InitResponse | { error: string };
            if (!cancelled && initRes.ok && "token" in initData) {
              setToken(initData.token);
              setInstanceUrl(initData.instanceUrl || window.location.origin);
              setAutoMagicState({
                autoMagic: Boolean(initData.autoMagic),
                envWritten: Boolean(initData.envWritten),
                redeployTriggered: Boolean(initData.redeployTriggered),
                redeployError: initData.redeployError,
              });
            }
          } catch {
            // Silent — user can still click "Initialize" manually below.
          }
        }
      } catch {
        if (!cancelled) setError("Could not reach this instance. Try refreshing.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initialBootstrap]);

  // Poll status to detect "permanent" state (env var set in Vercel + redeployed).
  useEffect(() => {
    if (permanent) return;
    const id = setInterval(async () => {
      try {
        const res = await fetch("/api/welcome/status");
        const data = (await res.json()) as StatusResponse;
        if (data.permanent) setPermanent(true);
      } catch {
        // Ignore transient errors.
      }
    }, 10_000);
    return () => clearInterval(id);
  }, [permanent]);

  const initialize = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/welcome/init", { method: "POST" });
      const data = (await res.json()) as InitResponse | { error: string };
      if (!res.ok || !("token" in data)) {
        setError(("error" in data && data.error) || "Initialization failed.");
        return;
      }
      setToken(data.token);
      setInstanceUrl(data.instanceUrl || window.location.origin);
      setAutoMagicState({
        autoMagic: Boolean(data.autoMagic),
        envWritten: Boolean(data.envWritten),
        redeployTriggered: Boolean(data.redeployTriggered),
        redeployError: data.redeployError,
      });
    } catch {
      setError("Network error.");
    } finally {
      setBusy(false);
    }
  }, []);

  const copyToken = useCallback(async () => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Ignore.
    }
  }, [token]);

  // Vercel doesn't expose precise team/project slugs at runtime without a
  // VERCEL_TOKEN — we link to the dashboard root and let the user navigate.
  const vercelEnvUrl = "https://vercel.com/dashboard";
  const vercelDeployUrl = "https://vercel.com/dashboard";

  // ── Render branches ─────────────────────────────────────────────────

  if (claim === "loading") {
    return (
      <Shell>
        <p className="text-slate-400">Connecting to this instance…</p>
      </Shell>
    );
  }

  if (claim === "already-initialized") {
    return (
      <Shell>
        <h1 className="text-2xl font-bold text-white mb-2">Already initialized</h1>
        <p className="text-slate-400 mb-6">
          This instance has a permanent token. Head to the dashboard.
        </p>
        <a
          href="/config"
          className="inline-block bg-blue-500 hover:bg-blue-400 text-white px-5 py-2.5 rounded-lg font-semibold text-sm"
        >
          Open dashboard →
        </a>
      </Shell>
    );
  }

  if (claim === "claimed-by-other") {
    return (
      <Shell>
        <h1 className="text-2xl font-bold text-white mb-2">Instance locked</h1>
        <p className="text-slate-400">
          Another browser is currently initializing this instance. Wait for them to finish, or
          contact the operator who deployed it.
        </p>
      </Shell>
    );
  }

  // claim === "new" or "claimer" — allow init.
  if (!token && !initialBootstrap) {
    return (
      <Shell>
        <h1 className="text-3xl font-bold text-white mb-3 tracking-tight">Welcome to MyMCP</h1>
        <p className="text-slate-400 mb-8 leading-relaxed">
          Click below to generate your permanent auth token and unlock this instance. The token will
          be shown once — save it somewhere safe.
        </p>
        {error && (
          <div className="mb-6 rounded-lg border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}
        <button
          type="button"
          onClick={initialize}
          disabled={busy}
          className="bg-blue-500 hover:bg-blue-400 disabled:opacity-50 text-white px-6 py-3 rounded-lg font-semibold text-sm transition-colors"
        >
          {busy ? "Generating…" : "Initialize this instance"}
        </button>
        <a href="/config" className="block mt-4 text-sm text-slate-500 hover:text-slate-300">
          Or explore the dashboard first →
        </a>
        <RecoveryFooter />
      </Shell>
    );
  }

  // Token visible: either freshly minted or we re-entered with bootstrap active.
  return (
    <Shell wide>
      {permanent &&
        !(
          autoMagicState?.autoMagic &&
          autoMagicState.envWritten &&
          autoMagicState.redeployTriggered
        ) && (
          <div className="mb-6 rounded-lg border border-emerald-800 bg-emerald-950/40 px-4 py-3 text-sm text-emerald-300">
            Setup complete — your Vercel deployment is now using the permanent token.
          </div>
        )}

      <h1 className="text-3xl font-bold text-white mb-3 tracking-tight">Your auth token</h1>
      <p className="text-slate-400 mb-6 leading-relaxed">
        This is your permanent token.{" "}
        <span className="text-amber-300 font-medium">
          Save it now — you won&apos;t see it again.
        </span>
      </p>

      {token && (
        <div className="mb-8 rounded-lg border border-slate-800 bg-slate-900/60 p-4">
          <div className="flex items-start gap-3">
            <code className="flex-1 break-all text-sm text-blue-300 font-mono">{token}</code>
            <button
              type="button"
              onClick={copyToken}
              className="shrink-0 bg-slate-800 hover:bg-slate-700 text-slate-200 px-3 py-1.5 rounded text-xs font-semibold"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
        </div>
      )}

      {(() => {
        const autoMagicSuccess =
          autoMagicState?.autoMagic &&
          autoMagicState.envWritten &&
          autoMagicState.redeployTriggered;
        const autoMagicPartial =
          autoMagicState?.autoMagic &&
          (!autoMagicState.envWritten || !autoMagicState.redeployTriggered);

        if (autoMagicSuccess) {
          return (
            <ol className="space-y-4 mb-8">
              <li className="flex items-start gap-3">
                <span className="text-emerald-400 mt-0.5">✓</span>
                <span className="text-slate-300">Token generated</span>
              </li>
              <li className="flex items-start gap-3">
                <span className="text-emerald-400 mt-0.5">✓</span>
                <span className="text-slate-300">Written to Vercel env vars</span>
              </li>
              <li className="flex items-start gap-3">
                <span
                  className={permanent ? "text-emerald-400 mt-0.5" : "text-amber-400 mt-0.5"}
                  aria-hidden
                >
                  {permanent ? "✓" : "⏳"}
                </span>
                <span className="text-slate-300">
                  {permanent ? "Redeployed — your instance is permanent." : "Redeploying… (~60s)"}
                </span>
              </li>
              <li className="flex items-start gap-3">
                <span className="text-slate-500 mt-0.5">□</span>
                <span className="text-slate-300">Configure your MCP client (snippet below)</span>
              </li>
            </ol>
          );
        }

        return (
          <>
            {autoMagicPartial && (
              <div className="mb-4 rounded-lg border border-amber-900/60 bg-amber-950/40 px-4 py-3 text-sm text-amber-300">
                Auto-deploy partially failed
                {autoMagicState?.redeployError ? ` (${autoMagicState.redeployError})` : ""} — fall
                back to manual steps below.
              </div>
            )}
            <ol className="space-y-4 mb-8">
              <li className="flex items-start gap-3">
                <span className="text-emerald-400 mt-0.5">✓</span>
                <span className="text-slate-300">Token generated</span>
              </li>
              <li className="flex items-start gap-3">
                <span className="text-slate-500 mt-0.5">□</span>
                <span className="text-slate-300">
                  Add token to Vercel as <code className="text-blue-300">MCP_AUTH_TOKEN</code> →{" "}
                  <a
                    href={vercelEnvUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-400 hover:text-blue-300 underline"
                  >
                    Open Vercel dashboard
                  </a>
                </span>
              </li>
              <li className="flex items-start gap-3">
                <span className="text-slate-500 mt-0.5">□</span>
                <span className="text-slate-300">
                  Redeploy from the Deployments tab →{" "}
                  <a
                    href={vercelDeployUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-400 hover:text-blue-300 underline"
                  >
                    Open Vercel dashboard
                  </a>
                </span>
              </li>
              <li className="flex items-start gap-3">
                <span className="text-slate-500 mt-0.5">□</span>
                <span className="text-slate-300">Configure your MCP client (snippet below)</span>
              </li>
            </ol>
          </>
        );
      })()}

      {token && <TokenUsagePanel token={token} instanceUrl={instanceUrl} />}
      <MultiClientNote />

      <a
        href="/config"
        className="inline-block bg-blue-500 hover:bg-blue-400 text-white px-6 py-3 rounded-lg font-semibold text-sm"
      >
        Continue to dashboard →
      </a>
      <RecoveryFooter />
    </Shell>
  );
}

function TokenUsagePanel({ token, instanceUrl }: { token: string; instanceUrl: string }) {
  const [tab, setTab] = useState<"desktop" | "code" | "other">("desktop");
  const [copied, setCopied] = useState(false);

  const url = `${instanceUrl || "https://YOUR-INSTANCE.vercel.app"}/api/mcp`;

  const desktopSnippet = JSON.stringify(
    {
      mcpServers: {
        mymcp: {
          url,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    },
    null,
    2
  );

  const codeSnippet = `claude mcp add --transport http mymcp ${url} \\\n  --header "Authorization: Bearer ${token}"`;

  const desktopPath =
    typeof navigator !== "undefined" && /Mac/i.test(navigator.platform)
      ? "~/Library/Application Support/Claude/claude_desktop_config.json"
      : "%APPDATA%\\Claude\\claude_desktop_config.json";

  const snippet = tab === "desktop" ? desktopSnippet : tab === "code" ? codeSnippet : url;

  const copySnippet = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  return (
    <div className="mb-8 rounded-lg border border-slate-800 bg-slate-900/40 p-5">
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm font-semibold text-white">How to use this token</p>
        <div className="flex items-center gap-1 bg-slate-950 rounded-md p-0.5 border border-slate-800">
          {(
            [
              ["desktop", "Claude Desktop"],
              ["code", "Claude Code"],
              ["other", "Other"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              className={`text-[11px] font-medium px-2.5 py-1 rounded transition-colors ${
                tab === k ? "bg-slate-800 text-white" : "text-slate-500 hover:text-slate-300"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {tab === "desktop" && (
        <p className="text-[11px] text-slate-500 leading-relaxed mb-2">
          Open <code className="font-mono text-slate-400">{desktopPath}</code> (create it if it
          doesn&apos;t exist), paste the snippet below, then restart Claude Desktop.
        </p>
      )}

      {tab === "code" && (
        <p className="text-[11px] text-slate-500 leading-relaxed mb-2">
          Run this in any terminal — registers MyMCP as an HTTP MCP server in your Claude Code
          config.
        </p>
      )}

      {tab === "other" && (
        <p className="text-[11px] text-slate-500 leading-relaxed mb-2">
          For Cursor, ChatGPT desktop, n8n, or any other MCP client: point it at the URL below and
          send your token as a <code className="font-mono text-slate-400">Bearer</code> header in
          the <code className="font-mono text-slate-400">Authorization</code> field. The exact UI
          varies per client.
        </p>
      )}

      <div className="relative">
        <pre className="text-[11px] font-mono bg-slate-950 border border-slate-800 px-3 py-2.5 rounded-md text-slate-300 overflow-x-auto whitespace-pre-wrap break-all">
          {snippet}
        </pre>
        <button
          type="button"
          onClick={copySnippet}
          className={`absolute top-2 right-2 text-[10px] font-medium px-2 py-1 rounded transition-colors ${
            copied
              ? "bg-emerald-900/60 text-emerald-300"
              : "bg-slate-800 hover:bg-slate-700 text-slate-300"
          }`}
        >
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>

      <p className="text-[10px] text-slate-600 mt-3">
        Endpoint: <code className="font-mono text-slate-500">{url}</code>
      </p>
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

function RecoveryFooter() {
  return (
    <details className="mt-12 text-xs text-slate-600">
      <summary className="cursor-pointer hover:text-slate-400">Locked out? Recover access</summary>
      <p className="mt-2 leading-relaxed">
        If you&apos;ve lost access to this instance, set{" "}
        <code className="text-slate-500">MYMCP_RECOVERY_RESET=1</code> in your Vercel project&apos;s
        environment variables and trigger a redeploy. After the new deployment boots, the bootstrap
        state will be cleared and you can claim this instance again from <code>/welcome</code>.
        Remove <code className="text-slate-500">MYMCP_RECOVERY_RESET</code> after recovery —
        otherwise it resets on every cold start.
      </p>
    </details>
  );
}

function Shell({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-200">
      <div className={`mx-auto px-6 py-20 ${wide ? "max-w-2xl" : "max-w-xl"}`}>
        <p className="text-xs font-mono text-blue-400 mb-4 tracking-wider uppercase">
          MyMCP · First-run setup
        </p>
        {children}
      </div>
    </div>
  );
}
