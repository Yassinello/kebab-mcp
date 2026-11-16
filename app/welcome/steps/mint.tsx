"use client";

import { PRODUCT } from "@/core/constants/brand";
import { useCallback, useEffect, useState, type JSX } from "react";
import { useWelcomeDispatch, useWelcomeState } from "../WelcomeStateContext";
import { useMintToken } from "../hooks/useMintToken";

/**
 * MintStep — Phase 47 WIRE-01b (v2, live).
 *
 * Step 2 of the welcome wizard. Mints the instance's permanent
 * MCP_AUTH_TOKEN, displays it once, gates "Continue" behind an
 * explicit "I saved it" acknowledgment, and surfaces the auto-magic
 * env-write + redeploy state.
 *
 * JSX migrated verbatim from `renderStepToken` + its panel closures
 * (TokenGenerateExplainer / TokenDisplayPanel / TokenSaveChecklist
 * / TokenPersistencePanel) in `WelcomeShell.tsx`. State flows via
 * the reducer (`state.token`, `state.permanent`, `state.autoMagic`,
 * `state.tokenSaved`, `state.error`). `useMintToken` owns the
 * /api/welcome/init POST + busy/error lifecycle; on a successful
 * mint the step dispatches `TOKEN_MINTED`.
 *
 * The legacy WelcomeShell effect that auto-called /init when
 * `initialBootstrap && claim in {"claimer","new"}` now lives here:
 * if `initialBootstrap === true && state.token === null`, we fire a
 * one-shot mint on mount so returning users don't have to click
 * Generate to see their token again. /init is idempotent.
 *
 * The legacy /api/welcome/status 10s poll for `permanent` (Vercel
 * env-var detection) also lives here — only relevant while the step
 * is rendered, and the mint step is the only consumer of `permanent`.
 */

type StorageMode = "kv" | "file" | "static" | "kv-degraded";

export interface MintStepProps {
  /** true when re-entering /welcome mid-flow with a durable bootstrap already live */
  initialBootstrap: boolean;
  /** preview-mode short-circuit — render a read-only token panel without calling /init */
  previewMode?: boolean;
  previewToken?: string;
  previewInstanceUrl?: string;
  /** when true, block the mint (MYMCP_RECOVERY_RESET=1 foot-gun) — reducer-agnostic */
  recoveryResetActive?: boolean;
  /** Callbacks from the orchestrator step-router (back/forward navigation). */
  onBack?: () => void;
  onContinue?: () => void;
  /** Derived from state.storage mapped to the legacy `file|kv|static|null` shape. */
  storageMode: StorageMode | null;
  storageEphemeral: boolean;
}

interface StatusResponse {
  initialized: boolean;
  permanent: boolean;
  isBootstrap: boolean;
}

// Vercel doesn't expose precise team/project slugs at runtime without a
// VERCEL_TOKEN — we link to the dashboard root and let the user navigate.
const VERCEL_ENV_URL = "https://vercel.com/dashboard";
const VERCEL_DEPLOY_URL = "https://vercel.com/dashboard";

export function MintStep({
  initialBootstrap,
  previewMode = false,
  previewToken = "",
  previewInstanceUrl = "",
  recoveryResetActive = false,
  onBack,
  onContinue,
  storageMode,
  storageEphemeral,
}: MintStepProps): JSX.Element {
  const state = useWelcomeState();
  const dispatch = useWelcomeDispatch();
  const mint = useMintToken();

  // Step-local `copied` — UI-only transient flag for the "Copy to clipboard"
  // button feedback. Not a reducer field (single consumer).
  const [copied, setCopied] = useState(false);

  // Preview mode bypass: seed reducer with preview token on mount so the
  // JSX renders the "token minted" branch without calling /init.
  useEffect(() => {
    if (!previewMode) return;
    if (state.token) return;
    dispatch({
      type: "TOKEN_MINTED",
      token: previewToken || "",
      instanceUrl: previewInstanceUrl || "",
      autoMagic: null,
    });
  }, [previewMode, previewToken, previewInstanceUrl, state.token, dispatch]);

  // Auto-mint for returning users with a bootstrap already live. /init is
  // idempotent and returns the existing token on retry. Only fires when
  // we have NO token yet AND initialBootstrap flag is set AND we're not
  // in preview mode AND recovery-reset isn't blocking the mint.
  useEffect(() => {
    if (previewMode) return;
    if (recoveryResetActive) return;
    if (!initialBootstrap) return;
    if (state.token) return;
    if (mint.busy) return;
    let cancelled = false;
    void (async () => {
      const res = await mint.mint({ permanent: false });
      if (cancelled) return;
      if (res.ok && res.token) {
        dispatch({
          type: "TOKEN_MINTED",
          token: res.token,
          instanceUrl:
            res.instanceUrl ?? (typeof window !== "undefined" ? window.location.origin : ""),
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
      } else if (res.error) {
        dispatch({ type: "ERROR_SET", error: res.error });
      }
    })();
    return () => {
      cancelled = true;
    };
    // Run only on bootstrap-mount transitions; `mint` ref is stable
    // enough for this one-shot (initialBootstrap flips true → false
    // once at mount, and state.token gate prevents re-mint).
  }, [initialBootstrap, previewMode, recoveryResetActive, state.token, mint, dispatch]);

  // Poll /api/welcome/status for `permanent` flip (Vercel env-var landed).
  useEffect(() => {
    if (previewMode) return;
    if (state.permanent) return;
    const id = setInterval(async () => {
      try {
        const res = await fetch("/api/welcome/status");
        const data = (await res.json()) as StatusResponse;
        if (data.permanent) dispatch({ type: "PERMANENT_SET", permanent: true });
      } catch {
        // Ignore transient errors — next interval retries.
      }
    }, 10_000);
    return () => clearInterval(id);
  }, [state.permanent, previewMode, dispatch]);

  const onGenerate = useCallback(async () => {
    dispatch({ type: "ERROR_SET", error: null });
    const res = await mint.mint({ permanent: false });
    if (res.ok && res.token) {
      dispatch({
        type: "TOKEN_MINTED",
        token: res.token,
        instanceUrl:
          res.instanceUrl ?? (typeof window !== "undefined" ? window.location.origin : ""),
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
      dispatch({
        type: "ERROR_SET",
        error:
          res.error === "already_minted" ? "already_minted" : res.error || "Initialization failed.",
      });
    }
  }, [mint, dispatch]);

  const copyToken = useCallback(async () => {
    if (!state.token) return;
    try {
      await navigator.clipboard.writeText(state.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Ignore — older browsers / insecure origins.
    }
  }, [state.token]);

  const downloadToken = useCallback(() => {
    if (!state.token) return;
    const content = [
      `# ${PRODUCT.name} admin key: it opens your dashboard. Keep it in a password manager.`,
      "# Paste the line below into your hosting's environment variables if you want",
      "# a second copy there (optional on durable storage).",
      `MCP_AUTH_TOKEN=${state.token}`,
      "",
    ].join("\n");
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "kebab-house-admin-key.env";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [state.token]);

  const durableBackend = storageMode === "kv" || (storageMode === "file" && !storageEphemeral);
  const persistenceReady = durableBackend || state.permanent;

  const busy = mint.busy;
  const error = state.error;

  // No key yet → show the "Create" call-to-action.
  if (!state.token) {
    return (
      <section>
        <StepHeader
          title="Create your admin key"
          subtitle={`The admin key opens your ${PRODUCT.name} dashboard. Your AI clients do not use it: they sign in on their own.`}
        />

        <AdminKeyExplainer durableBackend={durableBackend} />

        {error && (
          <div className="mb-6 rounded-lg border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-300">
            {error === "already_minted"
              ? "This instance already has an admin key, created in another browser. Use the key you saved there."
              : error}
          </div>
        )}

        <StepFooter
          secondary={onBack ? { label: "← Storage", onClick: onBack } : undefined}
          primary={{
            label: busy ? "Creating…" : "Create my admin key",
            enabled: !busy && !recoveryResetActive,
            onClick: () => void onGenerate(),
          }}
        />
      </section>
    );
  }

  // Key created → save UX.
  const autoMagicSuccess =
    state.autoMagic?.autoMagic && state.autoMagic.envWritten && state.autoMagic.redeployTriggered;
  const autoMagicPartial =
    state.autoMagic?.autoMagic &&
    (!state.autoMagic.envWritten || !state.autoMagic.redeployTriggered);

  return (
    <section>
      <StepHeader
        title="Save your admin key"
        subtitle="This key opens your dashboard. Copy it into your password manager now: it is only shown here."
      />

      <TokenDisplayPanel token={state.token} copied={copied} onCopy={copyToken} />

      <TokenSaveChecklist
        tokenSaved={state.tokenSaved}
        onChange={(v) => dispatch({ type: "TOKEN_SAVED_SET", tokenSaved: v })}
      />

      {!durableBackend && !autoMagicSuccess && (
        <div className="mb-4 rounded-lg border border-amber-800 bg-amber-950/20 px-4 py-3 text-xs text-amber-100/90 leading-relaxed">
          {state.permanent
            ? "Your hosting now keeps the key. You can continue."
            : "Your storage forgets data when the server restarts. One more step keeps your key: see Advanced below."}
        </div>
      )}

      <AdvancedPanel
        autoMagicSuccess={Boolean(autoMagicSuccess)}
        autoMagicPartial={Boolean(autoMagicPartial)}
        autoMagicError={state.autoMagic?.redeployError}
        durableBackend={durableBackend}
        permanent={state.permanent}
        vercelEnvUrl={VERCEL_ENV_URL}
        vercelDeployUrl={VERCEL_DEPLOY_URL}
        onDownload={downloadToken}
      />

      <StepFooter
        secondary={onBack ? { label: "← Storage", onClick: onBack } : undefined}
        primary={{
          label: !state.tokenSaved
            ? "Confirm you saved the key"
            : !persistenceReady
              ? "Waiting for the redeploy…"
              : "Continue → Connect",
          enabled: state.tokenSaved && persistenceReady,
          onClick: onContinue,
        }}
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
}: {
  primary: { label: string; enabled: boolean; onClick?: (() => void) | undefined };
  secondary?: { label: string; onClick: () => void } | undefined;
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
      </div>
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
    </div>
  );
}

// ── Mint-step panels ──────────────────────────────────────────────────

/** Before the key exists: what it is, when you need it, where to keep it. */
function AdminKeyExplainer({ durableBackend }: { durableBackend: boolean }) {
  return (
    <div className="mb-6 rounded-lg border border-slate-800 bg-slate-900/40 p-5">
      <dl className="text-xs text-slate-400 space-y-2 leading-relaxed">
        <div>
          <dt className="font-semibold text-slate-200">What it is</dt>
          <dd>A long password for your dashboard, made for you.</dd>
        </div>
        <div>
          <dt className="font-semibold text-slate-200">When you need it</dt>
          <dd>To open your dashboard in a new browser or on another device.</dd>
        </div>
        <div>
          <dt className="font-semibold text-slate-200">Where to keep it</dt>
          <dd>
            In your password manager. You will see it once, on the next screen.
            {durableBackend
              ? ""
              : " Your storage forgets data on restart, so there is one more step after that."}
          </dd>
        </div>
      </dl>
    </div>
  );
}

/** The key + copy button. */
function TokenDisplayPanel({
  token,
  copied,
  onCopy,
}: {
  token: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="mb-6 rounded-lg border border-blue-800/70 bg-blue-950/20 p-5 space-y-4">
      <p className="text-[11px] uppercase tracking-wider text-blue-300 font-semibold">
        Your admin key
      </p>
      <code className="block break-all text-sm text-blue-200 font-mono bg-slate-950/50 border border-slate-800 rounded-md px-3 py-2.5 leading-relaxed">
        {token}
      </code>
      <button
        type="button"
        onClick={onCopy}
        className="inline-flex items-center gap-1.5 bg-blue-500 hover:bg-blue-400 text-white px-4 py-1.5 rounded-md text-xs font-semibold"
      >
        {copied ? "Copied ✓" : "Copy"}
      </button>
    </div>
  );
}

/** "I saved it" confirmation: the key is the only way into the dashboard. */
function TokenSaveChecklist({
  tokenSaved,
  onChange,
}: {
  tokenSaved: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div
      className={`mb-6 rounded-lg border p-4 ${
        tokenSaved ? "border-emerald-800 bg-emerald-950/20" : "border-amber-800 bg-amber-950/20"
      }`}
    >
      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={tokenSaved}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-0.5 h-4 w-4 cursor-pointer accent-emerald-500"
        />
        <div className="text-xs leading-relaxed">
          <p className={`font-semibold ${tokenSaved ? "text-emerald-200" : "text-amber-200"}`}>
            I saved my admin key
          </p>
          <p className="text-slate-400 mt-1">
            It is the only way to open your dashboard. A password manager (1Password, Bitwarden,
            Apple Passwords…) is the right place.
          </p>
        </div>
      </label>
    </div>
  );
}

/**
 * Advanced (collapsed): hosting environment variables, the .env file and
 * the automatic redeploy status. Needed only on storage that forgets data.
 */
function AdvancedPanel({
  autoMagicSuccess,
  autoMagicPartial,
  autoMagicError,
  durableBackend,
  permanent,
  vercelEnvUrl,
  vercelDeployUrl,
  onDownload,
}: {
  autoMagicSuccess: boolean;
  autoMagicPartial: boolean;
  autoMagicError?: string | undefined;
  durableBackend: boolean;
  permanent: boolean;
  vercelEnvUrl: string;
  vercelDeployUrl: string;
  onDownload: () => void;
}) {
  return (
    <details className="mb-6 rounded-lg border border-slate-800 bg-slate-900/20 group">
      <summary className="cursor-pointer px-4 py-3 text-xs font-semibold text-slate-400 hover:text-slate-200 flex items-center justify-between">
        <span>
          Advanced{" "}
          <span className="text-slate-600">
            · hosting settings{durableBackend ? ", optional" : ""}
          </span>
        </span>
        <span className="text-[10px] text-slate-600 group-open:hidden">expand</span>
      </summary>
      <div className="border-t border-slate-800 px-4 py-4 text-xs text-slate-400 space-y-3 leading-relaxed">
        {autoMagicSuccess ? (
          <ul className="space-y-1 text-emerald-200/90">
            <li>✓ Saved as MCP_AUTH_TOKEN in your Vercel environment variables</li>
            <li>
              {permanent ? "✓ Redeploy complete" : "⏳ Vercel is redeploying (about a minute)…"}
            </li>
          </ul>
        ) : (
          <>
            {autoMagicPartial && (
              <p className="rounded-md border border-amber-900/60 bg-amber-950/40 px-3 py-2 text-amber-200">
                The automatic setup did not finish{autoMagicError ? ` (${autoMagicError})` : ""}.
                Use the steps below.
              </p>
            )}
            <p>
              {durableBackend
                ? "Your storage already keeps the key. Adding it to your hosting's environment variables gives you a second copy. This is optional."
                : "Your storage keeps data in a temporary folder that is wiped on restart. Add the key to your hosting's environment variables so it survives."}
            </p>
            <ol className="space-y-1.5 list-decimal list-inside">
              <li>
                Add the key as <code className="font-mono text-slate-300">MCP_AUTH_TOKEN</code> →{" "}
                <a
                  href={vercelEnvUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-400 hover:text-blue-300 underline"
                >
                  Open Vercel
                </a>
              </li>
              <li>
                Redeploy from the Deployments tab →{" "}
                <a
                  href={vercelDeployUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-400 hover:text-blue-300 underline"
                >
                  Open Vercel
                </a>
              </li>
              {!durableBackend && (
                <li>
                  {permanent
                    ? "✓ Redeploy detected. You can continue."
                    : "Wait about a minute. This page notices when it is done."}
                </li>
              )}
            </ol>
          </>
        )}
        <button
          type="button"
          onClick={onDownload}
          className="inline-flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 px-3 py-1.5 rounded-md text-xs font-semibold border border-slate-700"
        >
          Download .env fragment
        </button>
      </div>
    </details>
  );
}
