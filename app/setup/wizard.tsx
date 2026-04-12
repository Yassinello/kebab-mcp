"use client";

import { useState, useCallback, useEffect } from "react";

// ── Types ───────────────────────────────────────────────────────────

interface PackVar {
  key: string;
  label: string;
  help?: string;
  helpUrl?: string;
  placeholder?: string;
  sensitive?: boolean;
  optional?: boolean;
}

interface PackDef {
  id: string;
  name: string;
  description: string;
  toolCount: number;
  icon: string;
  starter?: boolean;
  recommended?: boolean;
  setupGuide: string[];
  vars: PackVar[];
}

// ── Pack definitions ────────────────────────────────────────────────

const PACKS: PackDef[] = [
  {
    id: "vault",
    name: "Obsidian Vault",
    description: "Notes, search, backlinks, web clipper",
    toolCount: 14,
    icon: "V",
    starter: true,
    recommended: true,
    setupGuide: [
      "Push your Obsidian vault to a GitHub repository",
      "Generate a Personal Access Token with 'repo' scope",
      "Enter the repo in owner/repo format (or paste the GitHub URL)",
    ],
    vars: [
      {
        key: "GITHUB_PAT",
        label: "GitHub Personal Access Token",
        helpUrl: "https://github.com/settings/tokens",
        help: "Needs 'repo' scope to read/write vault files.",
        placeholder: "ghp_...",
        sensitive: true,
      },
      {
        key: "GITHUB_REPO",
        label: "GitHub Repository",
        help: "You can paste the full URL — it will be converted automatically.",
        placeholder: "yourname/your-vault",
      },
    ],
  },
  {
    id: "slack",
    name: "Slack",
    description: "Channels, messages, threads, search",
    toolCount: 6,
    icon: "S",
    starter: true,
    setupGuide: [
      "Create a Slack App at api.slack.com/apps",
      "Add Bot Token Scopes: channels:history, channels:read, chat:write, search:read",
      "Install the app to your workspace",
      "Copy the Bot User OAuth Token below",
    ],
    vars: [
      {
        key: "SLACK_BOT_TOKEN",
        label: "Bot User OAuth Token",
        helpUrl: "https://api.slack.com/apps",
        help: "Starts with xoxb-",
        placeholder: "xoxb-...",
        sensitive: true,
      },
    ],
  },
  {
    id: "notion",
    name: "Notion",
    description: "Search, read, create, update, query databases",
    toolCount: 5,
    icon: "N",
    starter: true,
    setupGuide: [
      "Create an Internal Integration at notion.so/my-integrations",
      "Share your target pages/databases with the integration",
      "Copy the Internal Integration Token below",
    ],
    vars: [
      {
        key: "NOTION_API_KEY",
        label: "Internal Integration Token",
        helpUrl: "https://www.notion.so/my-integrations",
        help: "Starts with ntn_ or secret_",
        placeholder: "ntn_...",
        sensitive: true,
      },
    ],
  },
  {
    id: "google",
    name: "Google Workspace",
    description: "Gmail, Calendar, Contacts, Drive",
    toolCount: 18,
    icon: "G",
    setupGuide: [
      "Go to Google Cloud Console → APIs & Credentials",
      "Create an OAuth 2.0 Client (Web application type)",
      "Add your callback URL in Authorized redirect URIs",
      "Copy the Client ID and Client Secret below",
    ],
    vars: [
      {
        key: "GOOGLE_CLIENT_ID",
        label: "OAuth Client ID",
        helpUrl: "https://console.cloud.google.com/apis/credentials",
        placeholder: "123456789-abc.apps.googleusercontent.com",
      },
      {
        key: "GOOGLE_CLIENT_SECRET",
        label: "OAuth Client Secret",
        placeholder: "GOCSPX-...",
        sensitive: true,
      },
      {
        key: "GOOGLE_REFRESH_TOKEN",
        label: "OAuth Refresh Token",
        help: "You can generate this after deploy via the /api/auth/google flow.",
        placeholder: "1//...",
        sensitive: true,
        optional: true,
      },
    ],
  },
  {
    id: "browser",
    name: "Browser Automation",
    description: "Web browse, extract, act, LinkedIn feed",
    toolCount: 4,
    icon: "B",
    setupGuide: [
      "Create a Browserbase account for cloud browser sessions",
      "Create an OpenRouter account for AI-powered extraction",
      "Copy your API keys and project ID below",
    ],
    vars: [
      {
        key: "BROWSERBASE_API_KEY",
        label: "Browserbase API Key",
        helpUrl: "https://browserbase.com",
        placeholder: "bb_live_...",
        sensitive: true,
      },
      {
        key: "BROWSERBASE_PROJECT_ID",
        label: "Browserbase Project ID",
        placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      },
      {
        key: "OPENROUTER_API_KEY",
        label: "OpenRouter API Key",
        helpUrl: "https://openrouter.ai/keys",
        placeholder: "sk-or-v1-...",
        sensitive: true,
      },
    ],
  },
  {
    id: "paywall",
    name: "Paywall Readers",
    description: "Read paywalled Medium & Substack articles via your session cookies",
    toolCount: 1,
    icon: "P",
    setupGuide: [
      "Open Medium or Substack in Chrome, logged in",
      "DevTools → Application → Cookies → copy the session cookie value",
      "Paste it below — you only need to configure the sources you use",
    ],
    vars: [
      {
        key: "MEDIUM_SID",
        label: "Medium session cookie (sid)",
        help: "From medium.com cookies. Lasts ~1 year.",
        placeholder: "1:xxxxxxxx...",
        sensitive: true,
        optional: true,
      },
      {
        key: "SUBSTACK_SID",
        label: "Substack session cookie (substack.sid)",
        help: "From any *.substack.com cookies. Lasts ~30 days.",
        placeholder: "s%3Axxxxx...",
        sensitive: true,
        optional: true,
      },
    ],
  },
  {
    id: "composio",
    name: "Composio",
    description: "1000+ app integrations (Jira, HubSpot, Salesforce...)",
    toolCount: 2,
    icon: "C",
    setupGuide: [
      "Create a Composio account at composio.dev",
      "Go to Settings to find your API key",
      "Connect your apps in the Composio dashboard",
    ],
    vars: [
      {
        key: "COMPOSIO_API_KEY",
        label: "API Key",
        helpUrl: "https://composio.dev",
        placeholder: "ck_...",
        sensitive: true,
      },
    ],
  },
];

// ── Helpers ─────────────────────────────────────────────────────────

function generateToken(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  // base64url
  let bin = "";
  for (const b of array) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function normalizeGitHubRepo(value: string): string {
  const cleaned = value.trim().replace(/\/+$/, "");
  const match = cleaned.match(/github\.com\/([^/]+\/[^/]+)/);
  return match ? match[1] : cleaned;
}

function cleanCredential(value: string): string {
  return value.trim().replace(/^[A-Z_]+=/, "");
}

// ── Icons ───────────────────────────────────────────────────────────

function InfoIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-text-muted"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4m0-4h.01" />
    </svg>
  );
}

function ExtIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="inline ml-1 opacity-60"
    >
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6m4-3h6v6m-11 5L21 3" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`transition-transform ${open ? "rotate-90" : ""}`}
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

function CheckIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function EyeIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {open ? (
        <>
          <path d="m15 18-.722-3.25M2 8a10.645 10.645 0 0 0 20 0M20 15l-1.726-2.05M4 15l1.726-2.05M9 18l.722-3.25" />
        </>
      ) : (
        <>
          <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
          <circle cx="12" cy="12" r="3" />
        </>
      )}
    </svg>
  );
}

// ── Credential Input ────────────────────────────────────────────────

export function CredentialInput({
  v,
  value,
  onChange,
}: {
  v: PackVar;
  value: string;
  onChange: (value: string) => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const filled = value.length > 0;

  return (
    <div className="relative">
      <input
        type={v.sensitive && !revealed ? "password" : "text"}
        placeholder={v.placeholder || v.key}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`w-full bg-bg-muted border rounded-md pl-3 pr-20 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent/30 transition-colors ${
          filled ? "border-green/40 bg-green-bg/30" : "border-border focus:border-accent"
        }`}
      />
      <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
        {filled && (
          <span className="text-green flex items-center pr-1">
            <CheckIcon size={14} />
          </span>
        )}
        {v.sensitive && filled && (
          <button
            type="button"
            onClick={() => setRevealed(!revealed)}
            className="text-text-muted hover:text-text p-1 rounded"
            title={revealed ? "Hide value" : "Show value"}
          >
            <EyeIcon open={revealed} />
          </button>
        )}
      </div>
    </div>
  );
}

// Also export PACKS + helpers so /config Packs tab can reuse them.
export { PACKS, normalizeGitHubRepo, cleanCredential };
export type { PackDef, PackVar };

// ── Main Component ──────────────────────────────────────────────────

export function SetupWizard({
  firstTime,
  isVercel,
  hasToken,
  initialPack,
}: {
  firstTime: boolean;
  isVercel: boolean;
  hasToken: boolean;
  initialPack?: string;
}) {
  // Step 1 = Auth. If token already exists, skip to step 2.
  const [step, setStep] = useState(hasToken ? 1 : 0);
  const [mcpToken, setMcpToken] = useState<string | null>(null);
  const [tokenSaved, setTokenSaved] = useState(false);
  const [copiedToken, setCopiedToken] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [showAllPacks, setShowAllPacks] = useState(false);
  const [selectedPack, setSelectedPack] = useState<string>(initialPack || "vault");
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    message: string;
    detail?: string;
  } | null>(null);
  const [expandedGuide, setExpandedGuide] = useState(false);
  const [expandedError, setExpandedError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // On mount, if first-run and no token, generate + save it immediately
  useEffect(() => {
    if (!hasToken && firstTime) {
      const t = generateToken();
      setMcpToken(t);
      // Persist immediately so middleware starts protecting the server
      fetch("/api/setup/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ envVars: { MCP_AUTH_TOKEN: t } }),
      })
        .then((r) => r.json())
        .then((d) => {
          if (d.ok) setTokenSaved(true);
        })
        .catch(() => {
          /* non-fatal — user can still copy */
        });
    }
  }, [hasToken, firstTime]);

  const updateCredential = useCallback((key: string, rawValue: string) => {
    setCredentials((prev) => ({ ...prev, [key]: cleanCredential(rawValue) }));
  }, []);

  const activePack = PACKS.find((p) => p.id === selectedPack);

  const packFillStatus = useCallback(
    (pack: PackDef) => {
      const required = pack.vars.filter((v) => !v.optional);
      const filled = required.filter((v) => credentials[v.key]);
      return {
        total: required.length,
        filled: filled.length,
        ready: filled.length === required.length,
      };
    },
    [credentials]
  );

  const testPack = useCallback(async () => {
    if (!activePack) return;
    setTestResult({ ok: false, message: "Testing..." });
    setExpandedError(false);
    try {
      const res = await fetch("/api/setup/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pack: activePack.id, credentials }),
      });
      const data = await res.json();
      setTestResult(data);
    } catch {
      setTestResult({ ok: false, message: "Network error", detail: "Is the dev server running?" });
    }
  }, [activePack, credentials]);

  const copyToken = useCallback(() => {
    if (!mcpToken) return;
    navigator.clipboard.writeText(mcpToken);
    setCopiedToken(true);
    setTimeout(() => setCopiedToken(false), 2000);
  }, [mcpToken]);

  const saveEnv = useCallback(async () => {
    if (!activePack) return;
    setSaving(true);
    const env: Record<string, string> = {};
    for (const v of activePack.vars) {
      const val = credentials[v.key];
      if (val) env[v.key] = v.key === "GITHUB_REPO" ? normalizeGitHubRepo(val) : val;
    }
    try {
      // Use /api/config/env if token is already present (add-pack mode),
      // else /api/setup/save. In both cases we forward the token we just
      // generated (or the existing one) so the request is authorized even
      // though the browser has no cookie yet.
      const endpoint = hasToken ? "/api/config/env" : "/api/setup/save";
      const body = hasToken ? { vars: env } : { envVars: env };
      const method = hasToken ? "PUT" : "POST";
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (mcpToken) headers["Authorization"] = `Bearer ${mcpToken}`;
      const res = await fetch(endpoint, {
        method,
        headers,
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.ok) {
        setSaved(true);
        // If this was an add-pack flow, bounce to /config
        if (initialPack) {
          setTimeout(() => {
            window.location.href = "/config?tab=packs";
          }, 1000);
        }
      } else {
        alert(data.error || "Save failed");
      }
    } catch {
      alert("Failed to save configuration");
    }
    setSaving(false);
  }, [activePack, credentials, hasToken, initialPack]);

  const starterPacks = PACKS.filter((p) => p.starter);
  const otherPacks = PACKS.filter((p) => !p.starter);
  const visiblePacks = showAllPacks ? PACKS : starterPacks;

  return (
    <div>
      {/* ── Step indicator ─────────────────────────────────────────── */}
      <div className="flex items-center justify-center gap-2 mb-10">
        <StepDot num={1} active={step === 0} done={step > 0} label="Auth" />
        <div className={`h-0.5 w-12 ${step > 0 ? "bg-green" : "bg-border"}`} />
        <StepDot num={2} active={step === 1} done={saved} label="Pick a pack" />
      </div>

      {/* ═══ Step 1: Auth token ════════════════════════════════════════ */}
      {step === 0 && (
        <div>
          <div className="mb-6">
            <h2 className="font-semibold text-lg">Your MCP auth token</h2>
            <p className="text-sm text-text-dim mt-1">
              This token protects your MCP endpoint. You&rsquo;ll paste it into Claude, ChatGPT, or
              any MCP client. We generated one for you — copy it now.
            </p>
          </div>

          <div className="border border-border rounded-lg p-5">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-1.5">
                <p className="text-sm font-medium">MCP_AUTH_TOKEN</p>
                {tokenSaved && (
                  <span className="text-[11px] font-medium text-green bg-green-bg px-2 py-0.5 rounded-full flex items-center gap-1">
                    <CheckIcon size={10} /> Saved to .env
                  </span>
                )}
              </div>
              <button
                onClick={() => setShowToken(!showToken)}
                className="text-xs text-accent hover:underline flex items-center gap-1"
              >
                <EyeIcon open={showToken} />
                {showToken ? "Hide" : "Show"}
              </button>
            </div>
            <code className="text-xs font-mono bg-bg-muted px-3 py-2 rounded-md border border-border block overflow-x-auto select-all break-all">
              {mcpToken
                ? showToken
                  ? mcpToken
                  : `${mcpToken.slice(0, 8)}${"•".repeat(24)}${mcpToken.slice(-4)}`
                : "Generating..."}
            </code>
            <div className="flex items-center justify-between mt-3">
              <p className="text-[11px] text-text-muted">
                Store this somewhere safe. You can rotate it later from /config → Settings.
              </p>
              <button
                onClick={copyToken}
                disabled={!mcpToken}
                className={`text-xs font-medium px-3 py-1.5 rounded-md transition-colors ${
                  copiedToken
                    ? "bg-green-bg text-green"
                    : "bg-bg-muted hover:bg-border-light text-text-dim"
                }`}
              >
                {copiedToken ? "Copied!" : "Copy token"}
              </button>
            </div>
          </div>

          <div className="mt-8 flex justify-end">
            <button
              onClick={() => setStep(1)}
              disabled={!tokenSaved}
              className={`px-6 py-2.5 rounded-md text-sm font-medium transition-colors ${
                tokenSaved
                  ? "bg-accent text-white hover:bg-accent/90"
                  : "bg-bg-muted text-text-muted cursor-not-allowed"
              }`}
            >
              Continue &rarr;
            </button>
          </div>
        </div>
      )}

      {/* ═══ Step 2: Pick a pack ═══════════════════════════════════════ */}
      {step === 1 && (
        <div>
          <div className="mb-6">
            <h2 className="font-semibold text-lg">
              {initialPack ? "Connect this pack" : "Pick your first pack"}
            </h2>
            <p className="text-sm text-text-dim mt-1">
              {initialPack
                ? "Fill in the credentials below, test, then save. You'll be redirected to /config."
                : "Start with one pack — you can add more from /config after setup. Recommended: Vault (just one credential)."}
            </p>
          </div>

          {/* Pack selector */}
          {!initialPack && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
                {visiblePacks.map((pack) => {
                  const isSelected = pack.id === selectedPack;
                  return (
                    <button
                      key={pack.id}
                      onClick={() => {
                        setSelectedPack(pack.id);
                        setTestResult(null);
                        setExpandedError(false);
                      }}
                      className={`text-left border rounded-lg p-4 transition-all ${
                        isSelected
                          ? "border-accent bg-accent/5 shadow-sm"
                          : "border-border hover:border-border-light"
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-1.5">
                        <div
                          className={`w-7 h-7 rounded-md flex items-center justify-center font-bold text-xs ${
                            isSelected
                              ? "bg-accent text-white"
                              : "bg-bg-muted text-text-muted border border-border-light"
                          }`}
                        >
                          {pack.icon}
                        </div>
                        <p className="font-semibold text-sm">{pack.name}</p>
                        {pack.recommended && (
                          <span className="text-[10px] font-medium text-accent bg-accent/10 px-1.5 py-0.5 rounded-full ml-auto">
                            Recommended
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-text-dim">{pack.description}</p>
                      <p className="text-[11px] text-text-muted mt-1.5">
                        {pack.toolCount} tools
                        {pack.id === "vault" && " · 60s to set up"}
                      </p>
                    </button>
                  );
                })}
              </div>

              {!showAllPacks && otherPacks.length > 0 && (
                <button
                  onClick={() => setShowAllPacks(true)}
                  className="text-xs text-accent hover:underline mb-4"
                >
                  Show all packs ({otherPacks.length} more) &darr;
                </button>
              )}
            </>
          )}

          {/* Credentials form */}
          {activePack && (
            <div className="border border-border rounded-lg p-5">
              <div className="flex items-center gap-2 mb-4">
                <div className="w-8 h-8 rounded-md bg-accent text-white flex items-center justify-center font-bold text-sm">
                  {activePack.icon}
                </div>
                <div>
                  <p className="font-semibold text-sm">{activePack.name}</p>
                  <p className="text-xs text-text-dim">{activePack.description}</p>
                </div>
              </div>

              <button
                onClick={() => setExpandedGuide(!expandedGuide)}
                className="flex items-center gap-1.5 text-xs text-accent hover:underline mb-4"
              >
                <ChevronIcon open={expandedGuide} />
                How to get these credentials
              </button>

              {expandedGuide && (
                <div className="bg-bg-muted rounded-md p-4 mb-4 text-sm text-text-dim space-y-2">
                  {activePack.setupGuide.map((line, i) => (
                    <div key={i} className="flex gap-2">
                      <span className="text-accent font-semibold shrink-0">{i + 1}.</span>
                      <span>{line}</span>
                    </div>
                  ))}
                </div>
              )}

              <div className="space-y-4">
                {activePack.vars.map((v) => (
                  <div key={v.key}>
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <label className="text-sm font-medium">{v.label}</label>
                      {v.optional && (
                        <span className="text-[11px] text-text-muted bg-bg-muted px-1.5 py-0.5 rounded">
                          optional
                        </span>
                      )}
                      {v.help && (
                        <span title={v.help}>
                          <InfoIcon />
                        </span>
                      )}
                      {v.helpUrl && (
                        <a
                          href={v.helpUrl}
                          target="_blank"
                          rel="noopener"
                          className="text-[11px] text-accent hover:underline ml-auto"
                        >
                          Get it here <ExtIcon />
                        </a>
                      )}
                    </div>
                    <CredentialInput
                      v={v}
                      value={credentials[v.key] || ""}
                      onChange={(val) => updateCredential(v.key, val)}
                    />
                  </div>
                ))}
              </div>

              <div className="mt-5 flex items-center gap-3 flex-wrap">
                <button
                  onClick={testPack}
                  disabled={!packFillStatus(activePack).ready}
                  className={`text-sm font-medium px-4 py-1.5 rounded-md transition-colors ${
                    packFillStatus(activePack).ready
                      ? "bg-bg-muted hover:bg-border-light text-text-dim hover:text-text"
                      : "bg-bg-muted text-text-muted cursor-not-allowed"
                  }`}
                >
                  Test connection
                </button>
                {testResult && testResult.message !== "Testing..." && (
                  <span
                    className={`text-xs font-medium px-2 py-1 rounded-full ${
                      testResult.ok ? "text-green bg-green-bg" : "text-red bg-red-bg"
                    }`}
                  >
                    {testResult.ok ? "✓ " : "✗ "}
                    {testResult.message}
                  </span>
                )}
                {testResult && testResult.message === "Testing..." && (
                  <span className="text-xs text-accent">Testing...</span>
                )}
                {testResult && !testResult.ok && testResult.detail && (
                  <button
                    onClick={() => setExpandedError(!expandedError)}
                    className="text-xs text-text-muted hover:text-text underline"
                  >
                    {expandedError ? "Hide error" : "Show error details"}
                  </button>
                )}
              </div>

              {expandedError && testResult && !testResult.ok && testResult.detail && (
                <div className="mt-3 bg-red-bg border border-red/20 rounded-md p-3 text-xs font-mono text-red break-all">
                  {testResult.detail}
                </div>
              )}
            </div>
          )}

          <div className="mt-8 flex justify-between items-center">
            {!hasToken && (
              <button
                onClick={() => setStep(0)}
                className="text-text-dim hover:text-text text-sm px-4 py-2.5"
              >
                &larr; Back
              </button>
            )}
            <div className="ml-auto flex items-center gap-3">
              {saved && (
                <span className="text-xs text-green flex items-center gap-1">
                  <CheckIcon size={12} />
                  Saved
                </span>
              )}
              <button
                onClick={saveEnv}
                disabled={saving || !activePack || !packFillStatus(activePack).ready}
                className={`px-6 py-2.5 rounded-md text-sm font-medium transition-colors ${
                  activePack && packFillStatus(activePack).ready && !saving
                    ? "bg-accent text-white hover:bg-accent/90"
                    : "bg-bg-muted text-text-muted cursor-not-allowed"
                }`}
              >
                {saving ? "Saving..." : saved ? "Saved" : isVercel ? "Save to Vercel" : "Save .env"}
              </button>
            </div>
          </div>

          {saved && !initialPack && (
            <div className="mt-6 border border-green/20 bg-green-bg/30 rounded-lg p-4 text-sm">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-5 h-5 rounded-full bg-green text-white flex items-center justify-center">
                  <CheckIcon size={12} />
                </div>
                <p className="font-semibold text-green">All set!</p>
              </div>
              <p className="text-text-dim">
                Your MCP server is now running with {activePack?.name}. Go to{" "}
                <a href="/config" className="text-accent hover:underline font-medium">
                  /config
                </a>{" "}
                to add more packs, run tools, and view logs.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StepDot({
  num,
  active,
  done,
  label,
}: {
  num: number;
  active: boolean;
  done: boolean;
  label: string;
}) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div
        className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold border-2 transition-all ${
          active
            ? "bg-accent text-white border-accent"
            : done
              ? "bg-green text-white border-green"
              : "bg-bg border-border text-text-muted"
        }`}
      >
        {done ? <CheckIcon size={16} /> : num}
      </div>
      <p
        className={`text-[11px] font-semibold ${active ? "text-accent" : done ? "text-green" : "text-text-muted"}`}
      >
        {label}
      </p>
    </div>
  );
}
