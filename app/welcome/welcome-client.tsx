"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { KebabLogo } from "../components/kebab-logo";
import { McpClientSnippets } from "../components/mcp-client-snippets";

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

interface WelcomeClientProps {
  initialBootstrap: boolean;
  /**
   * True when MYMCP_RECOVERY_RESET=1 is set on the deployment. Surfaces a
   * blocking banner at the top of the wizard — minting a token in this
   * state hands the user a doomed credential, since every cold lambda
   * wipes the bootstrap.
   */
  recoveryResetActive?: boolean;
  previewMode?: boolean;
  previewToken?: string;
  previewInstanceUrl?: string;
}

type StorageMode = "kv" | "file" | "static" | "kv-degraded";

interface StorageStatus {
  mode: StorageMode;
  reason: string;
  dataDir: string | null;
  kvUrl: string | null;
  error: string | null;
  /** True only for file mode on Vercel /tmp — saves vanish on cold start. */
  ephemeral?: boolean;
  /** ISO timestamp from the server — used by the UI to show "last checked X seconds ago". */
  detectedAt?: string;
}

type WizardStep = 1 | 2 | 3;

type AckValue = "static" | "ephemeral" | null;
/**
 * Cookie name is versioned. v2 used `mymcp.storage.ack` with boolean "1"
 * (always meant static-mode ack, because v2 didn't differentiate
 * ephemeral). v3 uses `mymcp.storage.ack.v3` with semantic values. V2
 * cookies are explicitly NOT honored post-upgrade: the v2 → v3 UX is
 * materially different (3-card educational view, ephemeral-aware), so
 * users deserve to see the new flow once. The old cookie is also
 * cleared on first v3 mount to avoid ambiguity.
 */
const ACK_COOKIE = "mymcp.storage.ack.v3";
const LEGACY_ACK_COOKIE = "mymcp.storage.ack";

function deleteCookie(name: string): void {
  if (typeof document === "undefined") return;
  document.cookie = `${name}=; path=/; max-age=0; samesite=lax`;
}

/**
 * Persist the user's acknowledgment of a non-ideal storage mode.
 *
 *   - "static" → user explicitly chose env-vars-only (no runtime saves).
 *   - "ephemeral" → user knows Vercel /tmp is temporary and accepts it.
 *
 * Scoped to the MODE it was given in: if the instance later flips to a
 * different non-ideal mode, the user is re-prompted because it's a
 * different decision. Cookie + localStorage for durability under strict
 * browser privacy settings (Brave shields, Safari ITP).
 */
function readAck(): AckValue {
  if (typeof document === "undefined") return null;
  for (const raw of document.cookie.split(";")) {
    const c = raw.trim();
    if (c.startsWith(`${ACK_COOKIE}=`)) {
      const value = c.slice(ACK_COOKIE.length + 1);
      if (value === "static" || value === "ephemeral") return value;
    }
  }
  try {
    const ls = window.localStorage.getItem(ACK_COOKIE);
    if (ls === "static" || ls === "ephemeral") return ls as AckValue;
  } catch {
    // localStorage blocked — fine, cookie is the source of truth
  }
  return null;
}

/**
 * Clear any legacy v2 cookie / localStorage key so it can't silently gate
 * a user on v3 who was v2-acked before the UX overhaul.
 */
function purgeLegacyAck(): void {
  deleteCookie(LEGACY_ACK_COOKIE);
  try {
    window.localStorage.removeItem(LEGACY_ACK_COOKIE);
  } catch {
    // ignore
  }
}

function writeAck(value: "static" | "ephemeral"): { persisted: boolean } {
  if (typeof document === "undefined") return { persisted: false };
  const isHttps = typeof window !== "undefined" && window.location.protocol === "https:";
  const secureFlag = isHttps ? "; Secure" : "";
  // Shorter TTL than v2 (30 days instead of 1 year). Storage modes change
  // more often than users expect — an instance moved between deploys, a
  // user set up Upstash and forgot. Forcing a re-confirm once a month
  // catches stale acks that misrepresent the current decision.
  document.cookie = `${ACK_COOKIE}=${value}; path=/; max-age=2592000; samesite=lax${secureFlag}`;
  const cookieOk = document.cookie.split(";").some((c) => c.trim() === `${ACK_COOKIE}=${value}`);
  let storageOk: boolean;
  try {
    window.localStorage.setItem(ACK_COOKIE, value);
    storageOk = window.localStorage.getItem(ACK_COOKIE) === value;
  } catch {
    storageOk = false;
  }
  return { persisted: cookieOk || storageOk };
}

/** Remove the current ack. Called when the user transitions to a healthy mode. */
function clearAck(): void {
  deleteCookie(ACK_COOKIE);
  try {
    window.localStorage.removeItem(ACK_COOKIE);
  } catch {
    // ignore
  }
}

export default function WelcomeClient({
  initialBootstrap,
  recoveryResetActive = false,
  previewMode = false,
  previewToken = "",
  previewInstanceUrl = "",
}: WelcomeClientProps) {
  const [claim, setClaim] = useState<ClaimStatus>(previewMode ? "claimer" : "loading");
  const [token, setToken] = useState<string | null>(previewMode ? previewToken : null);
  const [instanceUrl, setInstanceUrl] = useState<string>(previewMode ? previewInstanceUrl : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [permanent, setPermanent] = useState(previewMode);
  const [autoMagicState, setAutoMagicState] = useState<AutoMagicState | null>(null);
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "ok" | "fail">("idle");
  const [testError, setTestError] = useState<string | null>(null);
  const [skipTest, setSkipTest] = useState(false);
  const [storageStatus, setStorageStatus] = useState<StorageStatus | null>(null);
  const [storageChecking, setStorageChecking] = useState(false);
  const [ack, setAck] = useState<AckValue>(null);
  const [ackPersisted, setAckPersisted] = useState(true);
  // Token save confirmation — gates step 2 "Continue" button. Defaults to
  // true when the user is re-entering an already-bootstrapped instance
  // (initialBootstrap) so returning users aren't re-prompted to re-ack a
  // token they saved weeks ago. Fresh users (first mint in this session)
  // must explicitly check the box.
  const [tokenSaved, setTokenSaved] = useState<boolean>(initialBootstrap);
  // Wizard state — step 1 = Storage, step 2 = Auth token, step 3 = Connect.
  // Storage first because the token is minted into whatever storage is
  // active: if user sets up Upstash BEFORE minting, the token lands in KV
  // (durable across cold starts). If they mint before storage is ready,
  // the token lives in /tmp only and vanishes with the next container
  // recycle — the fragility that motivated the v4 flow reorder.
  const [step, setStep] = useState<WizardStep>(1);
  /**
   * Active "Upstash setup in progress" mode. Triggered when the user clicks
   * "I added Upstash — recheck" in step 2. While true, we auto-poll the
   * detection endpoint every 5s for 120s instead of the ambient 20s rhythm,
   * showing a visible countdown so the user knows we're actively checking
   * for Vercel's redeploy to land. Without this, the user clicked "recheck"
   * once, saw nothing change, and assumed the button was broken.
   */
  const [upstashCheckActive, setUpstashCheckActive] = useState(false);
  const [upstashCheckSecondsLeft, setUpstashCheckSecondsLeft] = useState(0);
  const [lastCheckOutcome, setLastCheckOutcome] = useState<
    | { kind: "idle" }
    | { kind: "no-change"; at: number }
    | { kind: "mode-changed"; from: StorageMode; to: StorageMode; at: number }
    | { kind: "timeout"; at: number }
  >({ kind: "idle" });

  // Hydrate ack flag from cookie/localStorage on mount (avoid SSR mismatch by
  // reading post-mount). Also nuke any leftover v2 cookie — v3 has a
  // materially different UX and a v2-acked user should see it at least once.
  useEffect(() => {
    purgeLegacyAck();
    setAck(readAck());
  }, []);

  // Auto-clear ack when the mode transitions to a healthy state. If the
  // user acks ephemeral, then sets up Upstash (mode becomes kv), then later
  // removes Upstash and drops to static, we want them re-prompted — not
  // silently ready because of a stale ephemeral ack from six months ago.
  useEffect(() => {
    if (!storageStatus) return;
    const healthyMode =
      storageStatus.mode === "kv" || (storageStatus.mode === "file" && !storageStatus.ephemeral);
    if (healthyMode && ack !== null) {
      clearAck();
      setAck(null);
    }
  }, [storageStatus, ack]);

  // Step 1: claim the instance. If we re-enter with bootstrap already active
  // (user came back to /welcome before the redeploy), auto-call init so we
  // can re-display the token without forcing them to click again. /init is
  // idempotent and returns the existing token.
  useEffect(() => {
    if (previewMode) return;
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
  }, [initialBootstrap, previewMode]);

  // Poll status to detect "permanent" state (env var set in Vercel + redeployed).
  useEffect(() => {
    if (previewMode) return;
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
  }, [permanent, previewMode]);

  // Load the unified storage mode (kv / file / static / kv-degraded).
  // This replaces the legacy isolated "Upstash configured?" check and feeds
  // the welcome storage step + the MCP-client step list.
  const [storageFailures, setStorageFailures] = useState(0);
  const loadStorageStatus = useCallback(async (force = false) => {
    setStorageChecking(true);
    try {
      const res = await fetch(`/api/storage/status${force ? "?force=1" : ""}`, {
        credentials: "include",
      });
      if (!res.ok) {
        setStorageFailures((n) => n + 1);
        return;
      }
      const data = (await res.json()) as StorageStatus;
      setStorageStatus(data);
      setStorageFailures(0);
    } catch {
      // Count failures so the UI can offer a "continue anyway" escape
      // hatch after repeated detection errors (network partition, 500
      // loop). Without this, a user with a flaky network is stuck on
      // Welcome with the Continue button permanently disabled.
      setStorageFailures((n) => n + 1);
    } finally {
      setStorageChecking(false);
    }
  }, []);

  // Initial load on mount, refresh after token issued (so we re-fetch with
  // bearer cookie set by /init), and auto-refresh every 20s while the page
  // is open and the user hasn't yet reached a settled mode.
  useEffect(() => {
    void loadStorageStatus(false);
  }, [loadStorageStatus, token]);

  // Auto-retry on failure while we have no status yet. Without this, the
  // initial fetch fires once and — if it hits a cold lambda that hasn't
  // rehydrated the claim — the user is stuck on "Detecting your storage…"
  // forever (polling below only starts once storageStatus is set, and the
  // `detectionTrapped` escape hatch requires ≥3 failures to surface its
  // Recheck button). Backs off 3s → 6s → stop, so the user sees the escape
  // hatch within ~10s of a persistent failure rather than never.
  useEffect(() => {
    if (storageStatus) return;
    if (storageFailures === 0) return;
    if (storageFailures >= 3) return;
    const delayMs = storageFailures === 1 ? 3000 : 6000;
    const id = setTimeout(() => void loadStorageStatus(true), delayMs);
    return () => clearTimeout(id);
  }, [storageStatus, storageFailures, loadStorageStatus]);

  useEffect(() => {
    // Ambient polling — 20s rhythm while in transient (non-settled) modes.
    // The active "Upstash setup in progress" mode owns its own faster poll
    // (5s, see effect below) so when both are conditional-true we'd skip
    // this one to avoid duplicate fetches.
    if (upstashCheckActive) return;
    if (!storageStatus) return;
    const { mode, ephemeral } = storageStatus;
    if (mode === "kv") return;
    if (mode === "file" && !ephemeral) return;
    if (mode === "file" && ephemeral && ack === "ephemeral") return;
    if (mode === "static" && ack === "static") return;
    const id = setInterval(() => loadStorageStatus(true), 20_000);
    return () => clearInterval(id);
  }, [storageStatus, ack, loadStorageStatus, upstashCheckActive]);

  // Active Upstash-setup polling — split across three single-purpose
  // effects to avoid React setState-in-updater anti-patterns and to keep
  // each concern testable in isolation.
  //
  // Effect 1: 1 Hz countdown decrement. Pure state update, no side effects.
  // Effect 2: 5 s polling cadence — separate setInterval, fires the fetch.
  // Effect 3: timeout watcher — when countdown hits 0, close the loop.
  //
  // Why three effects: previously a single setInterval(1000ms) tried to do
  // all three jobs inside a setState updater function (`setSecondsLeft(prev
  // => { ... fire side-effects ... })`). React updaters must be pure and
  // can be invoked twice under StrictMode/concurrent rendering, which would
  // double-fire timeout/poll side-effects. Splitting separates the pure
  // tick from the side-effect-bearing reactions.
  useEffect(() => {
    if (!upstashCheckActive) return;
    const id = setInterval(() => {
      setUpstashCheckSecondsLeft((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(id);
  }, [upstashCheckActive]);

  useEffect(() => {
    if (!upstashCheckActive) return;
    // Poll cadence — 5s. The first fetch fires at t=5s, NOT immediately.
    // Vercel takes 60+ seconds to redeploy after Upstash integration; an
    // immediate fetch gives no useful information and (combined with the
    // mode-change effect below) caused a spurious "Upstash not detected
    // yet" flash at t=~0.5s, making the user think the button was broken.
    const id = setInterval(() => loadStorageStatus(true), 5000);
    return () => clearInterval(id);
  }, [upstashCheckActive, loadStorageStatus]);

  useEffect(() => {
    if (!upstashCheckActive) return;
    if (upstashCheckSecondsLeft > 0) return;
    // Timeout — close the loop. Use a functional setState so a successful
    // mode-change that landed in the SAME render batch isn't overwritten
    // by the timeout outcome. Order matters: clear active flag first so
    // subsequent effects don't keep firing.
    setUpstashCheckActive(false);
    setLastCheckOutcome((prev) =>
      prev.kind === "mode-changed" && prev.to === "kv" ? prev : { kind: "timeout", at: Date.now() }
    );
  }, [upstashCheckSecondsLeft, upstashCheckActive]);

  // Detect mode transition (e.g., file-ephemeral → kv after Upstash setup
  // completes). Depends ONLY on `storageStatus` so the effect fires only
  // when a fetch actually completed (storageStatus reference changes).
  // We read `upstashCheckActive` via a ref to avoid spurious re-runs when
  // the user toggles the active loop — a previous version depended on
  // both, which caused the no-change branch to fire the instant
  // startUpstashCheck flipped the flag, even though no fetch had landed.
  const prevModeRef = useRef<StorageMode | null>(null);
  const upstashActiveRef = useRef(upstashCheckActive);
  useEffect(() => {
    upstashActiveRef.current = upstashCheckActive;
  }, [upstashCheckActive]);
  useEffect(() => {
    if (!storageStatus) return;
    const prev = prevModeRef.current;
    const curr = storageStatus.mode;
    if (prev === null) {
      // First load — record current mode but don't surface any outcome.
    } else if (prev !== curr) {
      setLastCheckOutcome({ kind: "mode-changed", from: prev, to: curr, at: Date.now() });
      if (upstashActiveRef.current && curr === "kv") {
        setUpstashCheckActive(false);
      }
    } else if (upstashActiveRef.current) {
      // Same mode after a fetch during active upstash setup — surface
      // "still waiting" so the user knows we DID just check.
      setLastCheckOutcome({ kind: "no-change", at: Date.now() });
    }
    prevModeRef.current = curr;
  }, [storageStatus]);

  const startUpstashCheck = useCallback(() => {
    // Reset outcome so any stale "no-change" or "timeout" from a previous
    // session disappears. The first poll fires at t=5s — no immediate
    // fetch, because Vercel takes 60+ seconds to redeploy after Upstash
    // integration and an immediate fetch was producing a confusing "not
    // detected yet" flash at t=0.5s.
    setLastCheckOutcome({ kind: "idle" });
    setUpstashCheckSecondsLeft(120);
    setUpstashCheckActive(true);
  }, []);

  const stopUpstashCheck = useCallback(() => {
    setUpstashCheckActive(false);
  }, []);

  // No auto-skip step 1: removed because it could yank the token mid-read
  // for users on a fast Vercel deploy. Re-entering users who already have
  // a permanent token are routed to /config via the "already-initialized"
  // claim branch (line ~507) and never see the wizard at all, so manual
  // Continue on step 1 is the right behavior for the only path that
  // reaches it (first-time setup).

  const acknowledge = useCallback((value: "static" | "ephemeral") => {
    const { persisted } = writeAck(value);
    setAckPersisted(persisted);
    setAck(value);
  }, []);

  // "Ready" = user has a durable storage strategy. KV always ready. File
  // only ready when non-ephemeral OR when user explicitly acked ephemeral.
  // Static only ready when acked. Degraded never ready. Also: if we've
  // failed to detect the mode 3+ times in a row, treat as ready so the
  // user isn't trapped on welcome by a flaky network — server-side saves
  // still validate independently.
  const detectionTrapped = storageStatus === null && storageFailures >= 3;
  const storageReady =
    storageStatus?.mode === "kv" ||
    (storageStatus?.mode === "file" && !storageStatus.ephemeral) ||
    (storageStatus?.mode === "file" && storageStatus.ephemeral && ack === "ephemeral") ||
    (storageStatus?.mode === "static" && ack === "static") ||
    detectionTrapped;

  // Ack/mode mismatch: an existing ack stored for a different non-ideal
  // mode (e.g. user acked "static" in a previous session, instance later
  // flipped to file-ephemeral). storageReady will correctly gate them, but
  // we owe them a hint explaining why the "Continue" button is greyed out
  // despite a previous ack.
  const ackMismatch = Boolean(
    ack !== null &&
    storageStatus &&
    !(storageStatus.mode === "kv") &&
    !(storageStatus.mode === "file" && !storageStatus.ephemeral) &&
    !(storageStatus.mode === "file" && storageStatus.ephemeral && ack === "ephemeral") &&
    !(storageStatus.mode === "static" && ack === "static")
  );

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

  const runMcpTest = useCallback(async () => {
    if (!token) return;
    setTestStatus("testing");
    setTestError(null);
    try {
      const res = await fetch("/api/welcome/test-mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (data.ok) {
        setTestStatus("ok");
      } else {
        setTestStatus("fail");
        setTestError(data.error || "MCP test failed");
      }
    } catch {
      setTestStatus("fail");
      setTestError("Network error");
    }
  }, [token]);

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

  // Emit a small .env snippet the user can drop into a password-manager
  // note, a local .env, or a secrets vault. Name is scoped so it doesn't
  // collide with other tokens if they're saving several at once.
  const downloadToken = useCallback(() => {
    if (!token) return;
    const content = [
      "# Kebab MCP auth token — save this in a password manager",
      "# and paste it into your MCP client's Authorization header.",
      `MCP_AUTH_TOKEN=${token}`,
      "",
    ].join("\n");
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "kebab-mcp-token.env";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
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

  // Persistence gate. Durable backends (KV, persistent file) store the
  // token in the actual storage layer, not in Vercel env vars — so
  // `permanent` (the status flag for "token landed in real env vars")
  // never flips on no-auto-magic deploys, yet the instance is fully
  // durable. Treat durable-backend + minted-token as equivalent to
  // permanent for UI gating: step-2 Continue unlocks on mint, step-3
  // Test MCP is callable immediately, no 15-minute bootstrap-TTL wait.
  const durableBackend =
    storageStatus?.mode === "kv" || (storageStatus?.mode === "file" && !storageStatus.ephemeral);
  const persistenceReady = permanent || durableBackend;

  // claim === "new" or "claimer" — render the 3-step wizard.
  // ── 3-step wizard ──────────────────────────────────────────────────
  // Step 1: Storage (detect + optional Upstash install).
  // Step 2: Auth token (mint on click + save UX + ack).
  // Step 3: Connect (snippet, MCP test, optional starter skill).
  //
  // The storage-first order means the token gets minted into the chosen
  // backend: Upstash → durable across cold starts; durable file → also
  // persistent; ack'd ephemeral → user was warned it won't survive. The
  // prior order (token first, storage second) created a window where
  // freshly-minted tokens lived only in lambda-local /tmp and silently
  // vanished on Vercel's container recycle, trapping users in a
  // "locked out of my own instance" state.
  return (
    <Shell wide>
      {previewMode && (
        <div className="mb-6 rounded-lg border border-purple-800 bg-purple-950/40 px-4 py-3 text-sm text-purple-200">
          <strong className="font-semibold">Preview mode</strong> — read-only rendering against your
          live instance. No state is mutated. Close this tab when done.
        </div>
      )}

      {recoveryResetActive && (
        <div className="mb-6 rounded-lg border border-red-800 bg-red-950/40 px-4 py-3 text-sm text-red-200">
          <p className="font-semibold mb-1">⚠ MYMCP_RECOVERY_RESET=1 is still set</p>
          <p className="text-xs leading-relaxed text-red-200/90">
            Every cold lambda on this deployment wipes the bootstrap (it&apos;s the recovery escape
            hatch). Any token you mint right now will vanish within a few minutes, and the instance
            will silently drop back to first-run mode. <strong>Remove the env var</strong> from
            Vercel Settings → Environment Variables, redeploy, then reload this page before running
            through the wizard.
          </p>
        </div>
      )}

      <WizardStepper
        current={step}
        storageReady={Boolean(storageReady)}
        tokenSavedConfirmed={Boolean(token) && tokenSaved && persistenceReady}
        testOk={testStatus === "ok"}
        onGoTo={(target) => {
          // Forward navigation requires the prior step's gate to be met.
          // Backward navigation is always allowed (revisit storage, or
          // re-view the token once it's been shown).
          if (target < step) {
            setStep(target);
            return;
          }
          if (target === 2 && storageReady) setStep(2);
          else if (target === 3 && storageReady && tokenSaved && persistenceReady) setStep(3);
        }}
      />

      <div className="mt-8">
        {step === 1 &&
          renderStepStorage({
            storageStatus,
            storageChecking,
            ack,
            ackMismatch,
            ackPersisted,
            detectionTrapped,
            upstashCheckActive,
            upstashCheckSecondsLeft,
            lastCheckOutcome,
            startUpstashCheck,
            stopUpstashCheck,
            loadStorageStatus,
            acknowledge,
            onContinue: () => setStep(2),
            storageReady: Boolean(storageReady),
          })}

        {step === 2 &&
          renderStepToken({
            token,
            copied,
            copyToken,
            downloadToken,
            busy,
            error,
            initialize,
            tokenSaved,
            setTokenSaved,
            storageMode: storageStatus?.mode ?? null,
            storageEphemeral: Boolean(storageStatus?.ephemeral),
            permanent,
            autoMagicState,
            vercelEnvUrl,
            vercelDeployUrl,
            onBack: () => setStep(1),
            onContinue: () => setStep(3),
          })}

        {step === 3 &&
          renderStepConnect({
            token,
            instanceUrl,
            persistenceReady,
            testStatus,
            testError,
            runMcpTest,
            skipTest,
            setSkipTest,
            onBack: () => setStep(2),
          })}
      </div>

      <RecoveryFooter />
    </Shell>
  );
}

// ── Step renderers ─────────────────────────────────────────────────────
// These are plain functions (not React components) called from the main
// render. Pulling them out keeps the WelcomeClient body focused on state
// and routing; the visual structure of each step lives in its own block.

function renderStepToken(props: {
  token: string | null;
  copied: boolean;
  copyToken: () => void;
  downloadToken: () => void;
  busy: boolean;
  error: string | null;
  initialize: () => Promise<void>;
  tokenSaved: boolean;
  setTokenSaved: (v: boolean) => void;
  storageMode: StorageMode | null;
  storageEphemeral: boolean;
  permanent: boolean;
  autoMagicState: AutoMagicState | null;
  vercelEnvUrl: string;
  vercelDeployUrl: string;
  onBack: () => void;
  onContinue: () => void;
}) {
  const {
    token,
    copied,
    copyToken,
    downloadToken,
    busy,
    error,
    initialize,
    tokenSaved,
    setTokenSaved,
    storageMode,
    storageEphemeral,
    permanent,
    autoMagicState,
    vercelEnvUrl,
    vercelDeployUrl,
    onBack,
    onContinue,
  } = props;

  // No token yet → show the "Generate" call-to-action. This branch covers
  // fresh users who've just finished step 1 (storage) and are now ready to
  // mint into the chosen backend.
  if (!token) {
    return (
      <section>
        <StepHeader
          title="Generate your auth token"
          subtitle="Your AI client uses this token as a bearer credential on every request. It's the only way to authenticate against this instance."
        />

        <TokenGenerateExplainer storageMode={storageMode} storageEphemeral={storageEphemeral} />

        {error && (
          <div className="mb-6 rounded-lg border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}

        <StepFooter
          secondary={{ label: "← Storage", onClick: onBack }}
          primary={{
            label: busy ? "Generating…" : "Generate my token",
            enabled: !busy,
            onClick: () => void initialize(),
          }}
        />
      </section>
    );
  }

  // Token minted → save UX. Continue is gated on tokenSaved plus a
  // persistence check that depends on the backend:
  //   - Durable backend (KV / durable file): bootstrap-to-KV handled by
  //     first-run.ts makes the token survive cold starts on its own, so
  //     we don't need to wait for `permanent` (= Vercel env-var presence).
  //     Once the token is in React state, the mint succeeded and KV
  //     persistence fires asynchronously.
  //   - Ephemeral backend (/tmp): no durable persistence, so the user
  //     MUST paste the token into Vercel env vars and trigger a redeploy.
  //     Wait for `permanent` (i.e. the status poll detects MCP_AUTH_TOKEN
  //     is set at the platform level).
  const autoMagicSuccess =
    autoMagicState?.autoMagic && autoMagicState.envWritten && autoMagicState.redeployTriggered;
  const autoMagicPartial =
    autoMagicState?.autoMagic && (!autoMagicState.envWritten || !autoMagicState.redeployTriggered);
  const durableBackend = storageMode === "kv" || (storageMode === "file" && !storageEphemeral);
  const persistenceReady = durableBackend || permanent;

  return (
    <section>
      <StepHeader
        title="Save your auth token"
        subtitle="You'll see this token once. Copy it to a password manager and confirm below."
      />

      <TokenDisplayPanel
        token={token}
        copied={copied}
        onCopy={copyToken}
        onDownload={downloadToken}
      />

      <TokenSaveChecklist
        tokenSaved={tokenSaved}
        onChange={setTokenSaved}
        durableBackend={durableBackend}
      />

      <TokenPersistencePanel
        autoMagicSuccess={Boolean(autoMagicSuccess)}
        autoMagicPartial={Boolean(autoMagicPartial)}
        autoMagicError={autoMagicState?.redeployError}
        durableBackend={durableBackend}
        permanent={permanent}
        vercelEnvUrl={vercelEnvUrl}
        vercelDeployUrl={vercelDeployUrl}
      />

      <StepFooter
        secondary={{ label: "← Storage", onClick: onBack }}
        primary={{
          label: !tokenSaved
            ? "Confirm you saved the token"
            : !persistenceReady
              ? "Waiting for Vercel redeploy…"
              : "Continue → Connect",
          enabled: tokenSaved && persistenceReady,
          onClick: onContinue,
        }}
      />
    </section>
  );
}

/** Pre-mint explainer: what the token is for, how it's persisted. */
function TokenGenerateExplainer({
  storageMode,
  storageEphemeral,
}: {
  storageMode: StorageMode | null;
  storageEphemeral: boolean;
}) {
  const durable = storageMode === "kv" || (storageMode === "file" && !storageEphemeral);
  return (
    <div className="mb-6 rounded-lg border border-slate-800 bg-slate-900/40 p-5 space-y-3">
      <p className="text-sm font-semibold text-white">What happens when you click Generate</p>
      <ul className="text-xs text-slate-400 space-y-1.5 list-disc list-inside leading-relaxed">
        <li>
          We mint a 64-char random token and return it to your browser{" "}
          <strong className="text-slate-300">once</strong>.
        </li>
        {durable ? (
          <li>
            Because your storage is durable ({storageMode === "kv" ? "Upstash" : "local disk"}), the
            token is also written to your backend — it survives cold starts without any manual step.
          </li>
        ) : (
          <li>
            Because you&apos;re on ephemeral storage, the token lives in the serverless{" "}
            <code className="font-mono">/tmp</code> only. You&apos;ll need to paste it into your
            Vercel env vars to keep the instance alive across restarts.
          </li>
        )}
        <li>Next screen shows the token — you MUST copy it to a password manager.</li>
      </ul>
    </div>
  );
}

/** Token display: big monospace + copy + download. */
function TokenDisplayPanel({
  token,
  copied,
  onCopy,
  onDownload,
}: {
  token: string;
  copied: boolean;
  onCopy: () => void;
  onDownload: () => void;
}) {
  return (
    <div className="mb-6 rounded-lg border border-blue-800/70 bg-blue-950/20 p-5 space-y-4">
      <p className="text-[11px] uppercase tracking-wider text-blue-300 font-semibold">
        Your permanent token · shown once
      </p>
      <code className="block break-all text-sm text-blue-200 font-mono bg-slate-950/50 border border-slate-800 rounded-md px-3 py-2.5 leading-relaxed">
        {token}
      </code>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onCopy}
          className="inline-flex items-center gap-1.5 bg-blue-500 hover:bg-blue-400 text-white px-4 py-1.5 rounded-md text-xs font-semibold"
        >
          {copied ? "Copied ✓" : "Copy to clipboard"}
        </button>
        <button
          type="button"
          onClick={onDownload}
          className="inline-flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 px-4 py-1.5 rounded-md text-xs font-semibold border border-slate-700"
        >
          Download .env fragment
        </button>
      </div>
    </div>
  );
}

/** Forced "I saved it" acknowledgment before the Continue button unlocks. */
function TokenSaveChecklist({
  tokenSaved,
  onChange,
  durableBackend,
}: {
  tokenSaved: boolean;
  onChange: (v: boolean) => void;
  durableBackend: boolean;
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
            I saved this token in a password manager
          </p>
          <p className="text-slate-400 mt-1">
            {durableBackend
              ? "Good options: 1Password, Bitwarden, Apple Keychain, KeePass. The instance keeps a copy, but your MCP clients still need one."
              : "Good options: 1Password, Bitwarden, Apple Keychain, KeePass. This is your ONLY copy — the instance forgets it on restart unless you paste it into Vercel env vars below."}
          </p>
        </div>
      </label>
    </div>
  );
}

/** Persistence status panel: auto-magic outcome + manual fallback steps. */
function TokenPersistencePanel({
  autoMagicSuccess,
  autoMagicPartial,
  autoMagicError,
  durableBackend,
  permanent,
  vercelEnvUrl,
  vercelDeployUrl,
}: {
  autoMagicSuccess: boolean;
  autoMagicPartial: boolean;
  autoMagicError?: string;
  durableBackend: boolean;
  permanent: boolean;
  vercelEnvUrl: string;
  vercelDeployUrl: string;
}) {
  if (autoMagicSuccess) {
    return (
      <div className="mb-6 rounded-lg border border-emerald-800 bg-emerald-950/40 p-4">
        <p className="text-sm font-semibold text-emerald-300 mb-2">
          ✓ Token deployed automatically
        </p>
        <ul className="text-xs text-emerald-200/90 space-y-1">
          <li>✓ Generated and saved</li>
          <li>✓ Written to your Vercel env vars</li>
          <li>
            {permanent
              ? "✓ Redeploy complete — instance is live"
              : "⏳ Vercel is redeploying (~60s)…"}
          </li>
        </ul>
      </div>
    );
  }

  if (durableBackend) {
    return (
      <details className="mb-6 rounded-lg border border-slate-800 bg-slate-900/20 group">
        <summary className="cursor-pointer px-4 py-3 text-xs font-semibold text-slate-400 hover:text-slate-200 flex items-center justify-between">
          <span>
            Also paste into Vercel env vars <span className="text-slate-600">· optional</span>
          </span>
          <span className="text-[10px] text-slate-600 group-open:hidden">expand</span>
        </summary>
        <div className="border-t border-slate-800 px-4 py-4 text-xs text-slate-400 space-y-2 leading-relaxed">
          <p>
            Because your storage is durable, the token survives cold starts automatically — no
            manual step required. Pasting it into Vercel env vars adds a second layer (useful if you
            ever clear the KV store). Entirely optional.
          </p>
          <ol className="space-y-1 list-decimal list-inside">
            <li>
              Add <code className="font-mono text-slate-300">MCP_AUTH_TOKEN</code> →{" "}
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
              Redeploy →{" "}
              <a
                href={vercelDeployUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-400 hover:text-blue-300 underline"
              >
                Open Vercel
              </a>
            </li>
          </ol>
        </div>
      </details>
    );
  }

  // Ephemeral / static — the user MUST paste into Vercel env vars or the
  // instance will become inaccessible on the next cold start.
  return (
    <div className="mb-6 rounded-lg border border-amber-800 bg-amber-950/20 p-4 space-y-3">
      {autoMagicPartial && (
        <div className="rounded-md border border-amber-900/60 bg-amber-950/40 px-3 py-2 text-xs text-amber-200">
          Auto-deploy partially failed{autoMagicError ? ` (${autoMagicError})` : ""}. Use the manual
          steps below.
        </div>
      )}
      <p className="text-sm font-semibold text-amber-200">
        ⚠ Paste this token into Vercel env vars
      </p>
      <p className="text-xs text-amber-100/80 leading-relaxed">
        Your storage is ephemeral — the token lives in <code className="font-mono">/tmp</code> and
        will vanish on the next cold start unless you persist it as an env var.
      </p>
      <ol className="space-y-1.5 text-xs text-slate-300 list-decimal list-inside">
        <li>
          Add this token to Vercel as <code className="text-blue-300">MCP_AUTH_TOKEN</code> →{" "}
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
          Trigger a redeploy from the Deployments tab →{" "}
          <a
            href={vercelDeployUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-400 hover:text-blue-300 underline"
          >
            Open Vercel
          </a>
        </li>
        <li>
          {permanent
            ? "✓ Redeploy detected — your instance is now live"
            : "Wait ~60s. We'll detect when it's live."}
        </li>
      </ol>
    </div>
  );
}

function renderStepStorage(props: {
  storageStatus: StorageStatus | null;
  storageChecking: boolean;
  ack: AckValue;
  ackMismatch: boolean;
  ackPersisted: boolean;
  detectionTrapped: boolean;
  upstashCheckActive: boolean;
  upstashCheckSecondsLeft: number;
  lastCheckOutcome:
    | { kind: "idle" }
    | { kind: "no-change"; at: number }
    | { kind: "mode-changed"; from: StorageMode; to: StorageMode; at: number }
    | { kind: "timeout"; at: number };
  startUpstashCheck: () => void;
  stopUpstashCheck: () => void;
  loadStorageStatus: (force: boolean) => Promise<void>;
  acknowledge: (value: "static" | "ephemeral") => void;
  onContinue: () => void;
  storageReady: boolean;
}) {
  const {
    storageStatus,
    storageChecking,
    ack,
    ackMismatch,
    ackPersisted,
    detectionTrapped,
    upstashCheckActive,
    upstashCheckSecondsLeft,
    lastCheckOutcome,
    startUpstashCheck,
    stopUpstashCheck,
    loadStorageStatus,
    acknowledge,
    onContinue,
    storageReady,
  } = props;

  return (
    <section>
      <StepHeader
        title="Where your data lives"
        subtitle="Pick where Kebab MCP saves your credentials, skills, and context. You can change this later from the dashboard."
      />

      {/* Mode-change celebration — shows briefly after Upstash setup completes */}
      {lastCheckOutcome.kind === "mode-changed" && lastCheckOutcome.to === "kv" && (
        <div className="mb-4 rounded-lg border border-emerald-700 bg-emerald-950/50 px-4 py-3">
          <p className="text-sm font-semibold text-emerald-200">
            🎉 Upstash detected — your storage is now persistent
          </p>
          <p className="text-[11px] text-emerald-300/80 mt-1">
            Saves from the dashboard will survive cold starts and redeploys. You can continue.
          </p>
        </div>
      )}

      {/* Active upstash setup — visible countdown so the user knows we're checking */}
      {upstashCheckActive && (
        <UpstashCheckPanel
          secondsLeft={upstashCheckSecondsLeft}
          onStop={stopUpstashCheck}
          lastCheckOutcome={lastCheckOutcome}
        />
      )}

      {/* Timeout — happens when 120s elapsed without detecting Upstash */}
      {!upstashCheckActive && lastCheckOutcome.kind === "timeout" && (
        <div className="mb-4 rounded-lg border border-amber-900/60 bg-amber-950/30 p-4">
          <p className="text-sm font-semibold text-amber-200 mb-1">
            Still no Upstash detected after 2 minutes
          </p>
          <ul className="text-[11px] text-amber-200/90 list-disc list-inside space-y-0.5 mb-3">
            <li>
              Confirm the integration was added to <strong>this specific project</strong> in Vercel
            </li>
            <li>
              Check{" "}
              <a
                href="https://vercel.com/dashboard"
                target="_blank"
                rel="noopener noreferrer"
                className="underline text-blue-400"
              >
                Vercel → Deployments
              </a>{" "}
              — the redeploy may have failed
            </li>
            <li>Try a manual recheck below, or pick a different storage option</li>
          </ul>
          <button
            type="button"
            onClick={startUpstashCheck}
            className="text-xs font-medium px-3 py-1.5 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-200"
          >
            Retry Upstash check
          </button>
        </div>
      )}

      {/* Ack mismatch — user previously acked a different mode */}
      {storageStatus && ackMismatch && (
        <div className="mb-4 rounded-lg border border-amber-900/60 bg-amber-950/30 px-4 py-3 text-xs text-amber-200">
          <strong className="font-semibold">Your previous choice needs re-confirming.</strong> This
          instance&apos;s storage changed since you last acked — pick an option from the cards below
          to continue.
        </div>
      )}

      {storageStatus ? (
        <WelcomeStorageStep
          status={storageStatus}
          checking={storageChecking}
          ack={ack}
          onRecheck={() => loadStorageStatus(true)}
          onAcknowledge={acknowledge}
          onUpstashSetupStart={startUpstashCheck}
          upstashCheckActive={upstashCheckActive}
        />
      ) : (
        <div className="mb-6 rounded-lg border border-slate-800 bg-slate-900/40 p-5 text-sm text-slate-400">
          Detecting your storage…
        </div>
      )}

      {ack !== null && !ackPersisted && (
        <div className="mb-4 rounded-lg border border-orange-900/60 bg-orange-950/30 px-4 py-3 text-xs text-orange-200">
          <strong className="font-semibold">Your browser blocked our cookie.</strong> Your choice
          will not persist across reloads — re-confirm if you come back, or unblock cookies for this
          origin.
        </div>
      )}

      {detectionTrapped && (
        <div className="mb-4 rounded-lg border border-amber-900/60 bg-amber-950/30 p-4 text-xs text-amber-200">
          <p className="font-semibold mb-1">Storage detection failed</p>
          <p className="leading-relaxed mb-2">
            We couldn&apos;t reach <code className="font-mono">/api/storage/status</code> after
            several tries. Continue is unblocked so a flaky network doesn&apos;t trap you here.
          </p>
          <button
            type="button"
            onClick={() => void loadStorageStatus(true)}
            disabled={storageChecking}
            className="bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 px-3 py-1.5 rounded-md text-xs font-semibold"
          >
            {storageChecking ? "Rechecking…" : "Retry detection"}
          </button>
        </div>
      )}

      <StepFooter
        primary={{
          label: storageReady ? "Continue → Auth token" : "Pick or acknowledge a storage option",
          enabled: storageReady,
          onClick: onContinue,
        }}
      />
    </section>
  );
}

function renderStepConnect(props: {
  token: string | null;
  instanceUrl: string;
  persistenceReady: boolean;
  testStatus: "idle" | "testing" | "ok" | "fail";
  testError: string | null;
  runMcpTest: () => void;
  skipTest: boolean;
  setSkipTest: (v: boolean) => void;
  onBack: () => void;
}) {
  const {
    token,
    instanceUrl,
    persistenceReady,
    testStatus,
    testError,
    runMcpTest,
    skipTest,
    setSkipTest,
    onBack,
  } = props;
  // persistenceReady means "token is durable" — either permanent (Vercel
  // env var via auto-magic) OR KV/file-backed (survives cold starts on
  // its own). Both are safe to hand off to an MCP client. skipTest only
  // bypasses the probe, not the persistence gate.
  const canContinue = persistenceReady && (testStatus === "ok" || skipTest);

  return (
    <section>
      <StepHeader
        title="Connect your AI client"
        subtitle="Add Kebab MCP to your client's MCP server config, then verify it works."
      />

      {token && <TokenUsagePanel token={token} instanceUrl={instanceUrl} />}
      <MultiClientNote />

      <TestMcpPanel
        persistenceReady={persistenceReady}
        testStatus={testStatus}
        testError={testError}
        runMcpTest={runMcpTest}
      />

      {token && <StarterSkillsPanel />}

      <StepFooter
        secondary={{ label: "← Auth token", onClick: onBack }}
        primary={{
          label: canContinue ? "Open dashboard →" : "Test your MCP connection first",
          enabled: canContinue,
          // Pass the token as `?token=` so the middleware sets the
          // `mymcp_admin_token` cookie on the first hit. Without this,
          // /config is admin-gated and returns 401 the moment we land
          // — the user finishes welcome only to be told "Unauthorized".
          // The middleware redirects to a cookied URL after validating,
          // so the token is in the address bar for one request tops.
          href: canContinue && token ? `/config?token=${encodeURIComponent(token)}` : undefined,
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

// ── Wizard chrome ──────────────────────────────────────────────────────

function WizardStepper({
  current,
  storageReady,
  tokenSavedConfirmed,
  testOk,
  onGoTo,
}: {
  current: WizardStep;
  storageReady: boolean;
  tokenSavedConfirmed: boolean;
  testOk: boolean;
  onGoTo: (step: WizardStep) => void;
}) {
  const steps: { n: WizardStep; label: string; done: boolean }[] = [
    { n: 1, label: "Storage", done: storageReady },
    { n: 2, label: "Auth token", done: tokenSavedConfirmed },
    { n: 3, label: "Connect", done: testOk },
  ];
  return (
    <ol className="flex items-center gap-2 sm:gap-3 flex-wrap" aria-label="Setup progress">
      {steps.map((s, i) => {
        const isCurrent = current === s.n;
        const reachable =
          s.n === 1 ||
          (s.n === 2 && storageReady) ||
          (s.n === 3 && storageReady && tokenSavedConfirmed) ||
          s.n < current; // backward always allowed
        return (
          <li key={s.n} className="flex items-center gap-2 sm:gap-3">
            <button
              type="button"
              onClick={() => reachable && onGoTo(s.n)}
              disabled={!reachable}
              aria-current={isCurrent ? "step" : undefined}
              className={`flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${
                isCurrent
                  ? "bg-blue-500/20 text-blue-200 ring-1 ring-blue-500/40"
                  : s.done
                    ? "text-emerald-300 hover:bg-emerald-950/40"
                    : reachable
                      ? "text-slate-300 hover:bg-slate-800/60"
                      : "text-slate-600 cursor-not-allowed"
              }`}
            >
              <span
                aria-hidden
                className={`flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold ${
                  s.done
                    ? "bg-emerald-500 text-white"
                    : isCurrent
                      ? "bg-blue-500 text-white"
                      : "bg-slate-800 text-slate-400"
                }`}
              >
                {s.done ? "✓" : s.n}
              </span>
              <span>{s.label}</span>
            </button>
            {i < steps.length - 1 && (
              <span aria-hidden className="text-slate-700 text-xs">
                ›
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

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
  primary: { label: string; enabled: boolean; onClick?: () => void; href?: string };
  secondary?: { label: string; onClick: () => void };
  tertiary?: { label: string; onClick: () => void };
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

/**
 * Active "I added Upstash — checking…" panel. Shows a visible countdown
 * + optional last-outcome message, with an explicit "Stop checking" escape
 * hatch. Closes the v3.5 UX gap where clicking recheck appeared to do
 * nothing — now the user has continuous, obvious feedback.
 */
function UpstashCheckPanel({
  secondsLeft,
  onStop,
  lastCheckOutcome,
}: {
  secondsLeft: number;
  onStop: () => void;
  lastCheckOutcome:
    | { kind: "idle" }
    | { kind: "no-change"; at: number }
    | { kind: "mode-changed"; from: StorageMode; to: StorageMode; at: number }
    | { kind: "timeout"; at: number };
}) {
  const elapsed = 120 - secondsLeft;
  const pct = Math.min(100, Math.max(0, (elapsed / 120) * 100));
  return (
    <div className="mb-4 rounded-lg border border-blue-900/60 bg-blue-950/30 p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-blue-200">
          Detecting Upstash setup… ({Math.floor(secondsLeft / 60)}m {secondsLeft % 60}s left)
        </p>
        <button
          type="button"
          onClick={onStop}
          className="text-[11px] text-slate-400 hover:text-slate-200 underline"
        >
          Stop checking
        </button>
      </div>
      <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
        <div
          className="h-full bg-blue-500 transition-all duration-1000"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-[11px] text-slate-400 leading-relaxed">
        Vercel typically takes 60–90s to redeploy after the Upstash integration lands. We&apos;re
        rechecking every 5s.
        {lastCheckOutcome.kind === "no-change" && (
          <>
            {" "}
            Last check: {new Date(lastCheckOutcome.at).toLocaleTimeString()} — Upstash not detected
            yet.
          </>
        )}
      </p>
    </div>
  );
}

/**
 * Storage step panel (v4) — one decision, one primary path.
 *
 * Prior design (v3) was a 3-card grid (Upstash / Local file / Env vars only)
 * that conflated two questions: "what's currently detected" and "what
 * should you choose". Both rendered at the same visual weight, the
 * detected card got highlighted as if pre-selected, and the badge pileup
 * (RECOMMENDED green + TEMPORARY amber + current emerald + a separate
 * warning banner) produced a Christmas-tree effect with no dominant
 * signal. Users read the highlighted "temporary" card as the default —
 * directly contradicting the banner telling them not to use it.
 *
 * New hierarchy:
 *   1. Status line — one sentence, detection outcome, neutral or amber
 *   2. Primary CTA — "Set up Upstash" hero, only when the current mode
 *      isn't already durable (kv or file+persistent)
 *   3. Advanced disclosure — ack buttons for users who explicitly want
 *      to stay on /tmp (testing) or env-vars-only (infra-as-code), plus
 *      a pedagogical "how the backends differ" reference
 *
 * Mode-specific behavior:
 *   kv              → ✓ status, no CTA, continue enabled
 *   file (durable)  → ✓ status (Docker/dev disk), no CTA
 *   file (ephemeral)→ ⚠ status, Upstash CTA, advanced: ack "keep /tmp"
 *   static          → ⚠ status, Upstash CTA, advanced: ack "env vars only"
 *   kv-degraded     → red error panel (retained from prior impl)
 */
function WelcomeStorageStep({
  status,
  checking,
  ack,
  onRecheck,
  onAcknowledge,
  onUpstashSetupStart,
  upstashCheckActive,
}: {
  status: StorageStatus;
  checking: boolean;
  ack: AckValue;
  onRecheck: () => void;
  onAcknowledge: (value: "static" | "ephemeral") => void;
  /** Called when the user clicks "Already installed — detect" — kicks off the active check loop. */
  onUpstashSetupStart: () => void;
  /** Whether the active upstash setup loop is currently running. */
  upstashCheckActive: boolean;
}) {
  // KV configured but unreachable — infra is broken, don't let the user
  // pick anything; just surface the error and offer retry.
  if (status.mode === "kv-degraded") {
    return (
      <div className="mb-6 rounded-lg border border-red-900/60 bg-red-950/40 p-5">
        <p className="text-sm font-semibold text-red-300 mb-1">KV configured but unreachable</p>
        <p className="text-[11px] text-slate-400 leading-relaxed mb-3">
          We don&apos;t silently downgrade to file storage during a temporary KV outage — that would
          cause data loss when Upstash recovers. Check that your Upstash database is online and your
          token is valid, then click recheck.
        </p>
        {status.error && (
          <p className="text-[11px] font-mono text-red-200 bg-red-950/60 p-2 rounded mb-3">
            {status.error}
          </p>
        )}
        <button
          type="button"
          onClick={onRecheck}
          disabled={checking}
          className="bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 px-4 py-2 rounded-md text-xs font-semibold"
        >
          {checking ? "Rechecking…" : "Retry detection"}
        </button>
      </div>
    );
  }

  const isKv = status.mode === "kv";
  const isFileDurable = status.mode === "file" && !status.ephemeral;
  const isEphemeral = status.mode === "file" && Boolean(status.ephemeral);
  const isStatic = status.mode === "static";
  // Durable backends need no user action. We still render an advanced
  // disclosure so power users can see the other backends, but there's no
  // CTA to push — status line alone is enough.
  const isSettled = isKv || isFileDurable;

  return (
    <div className="mb-8 space-y-4">
      <StorageStatusLine status={status} />

      {!isSettled && (
        <UpstashPrimaryCta
          onUpstashSetupStart={onUpstashSetupStart}
          checking={checking}
          upstashCheckActive={upstashCheckActive}
        />
      )}

      {/* Open-by-default once the user has acknowledged their fallback
          choice, so they can see the "Acknowledged" state rather than
          wondering where the button went. */}
      <details
        className="rounded-lg border border-slate-800 bg-slate-900/20 group"
        open={ack !== null}
      >
        <summary className="cursor-pointer px-4 py-3 text-xs font-semibold text-slate-400 hover:text-slate-200 flex items-center justify-between">
          <span>Other storage options</span>
          <span className="text-[10px] text-slate-600 group-open:hidden">expand</span>
        </summary>
        <div className="border-t border-slate-800 px-4 py-4 space-y-3">
          {isEphemeral && (
            <AdvancedOption
              title="Keep /tmp — testing only"
              description="Vercel recycles the container (and wipes /tmp) every 15–30 min of inactivity. Credentials saved from the dashboard silently disappear. Only pick this if you're actively poking around."
              tone="warning"
              buttonLabel={
                ack === "ephemeral"
                  ? "Acknowledged — saves are temporary"
                  : "I understand — keep temporary storage"
              }
              onClick={() => onAcknowledge("ephemeral")}
              disabled={ack === "ephemeral"}
            />
          )}
          {isStatic && (
            <AdvancedOption
              title="Env vars only — no runtime saves"
              description="Set credentials at deploy time in Vercel's env vars. Dashboard saves are disabled (you get .env stub helpers instead). Fits infra-as-code workflows."
              tone="neutral"
              buttonLabel={
                ack === "static" ? "Acknowledged — env-vars only" : "Continue env-vars only"
              }
              onClick={() => onAcknowledge("static")}
              disabled={ack === "static"}
            />
          )}
          <StorageBackendsExplainer />
        </div>
      </details>
    </div>
  );
}

/** One-line status — the detected state, tone matches severity. */
function StorageStatusLine({ status }: { status: StorageStatus }) {
  if (status.mode === "kv") {
    return (
      <div className="rounded-md border border-emerald-800 bg-emerald-950/40 px-4 py-2.5 text-sm text-emerald-300 flex items-center gap-2">
        <span aria-hidden>✓</span>
        <span>
          Upstash connected
          {status.kvUrl && (
            <>
              {" · "}
              <code className="font-mono text-[11px] text-emerald-200/80">{status.kvUrl}</code>
            </>
          )}
        </span>
      </div>
    );
  }
  if (status.mode === "file" && !status.ephemeral) {
    return (
      <div className="rounded-md border border-emerald-800 bg-emerald-950/40 px-4 py-2.5 text-sm text-emerald-300 flex items-center gap-2">
        <span aria-hidden>✓</span>
        <span>
          Writing to local disk{" "}
          {status.dataDir && (
            <>
              (<code className="font-mono text-[11px] text-emerald-200/80">{status.dataDir}</code>)
            </>
          )}{" "}
          — persists across restarts
        </span>
      </div>
    );
  }
  if (status.mode === "file" && status.ephemeral) {
    return (
      <div className="rounded-md border border-amber-800 bg-amber-950/30 px-4 py-2.5 text-sm text-amber-200 flex items-start gap-2">
        <span aria-hidden>⚠</span>
        <span>
          Your data won&apos;t survive restarts — Vercel wipes{" "}
          <code className="font-mono text-[11px]">/tmp</code> every 15–30 min of inactivity
        </span>
      </div>
    );
  }
  // static
  return (
    <div className="rounded-md border border-amber-800 bg-amber-950/30 px-4 py-2.5 text-sm text-amber-200 flex items-center gap-2">
      <span aria-hidden>⚠</span>
      <span>Read-only filesystem — no persistent storage configured yet</span>
    </div>
  );
}

/**
 * Primary CTA: guide the user to install Upstash. The outbound link is
 * the setup action; the secondary button kicks off a 120s poll loop for
 * users who've already installed it (or just clicked the link and are
 * waiting for Vercel to finish the automatic redeploy).
 */
function UpstashPrimaryCta({
  onUpstashSetupStart,
  checking,
  upstashCheckActive,
}: {
  onUpstashSetupStart: () => void;
  checking: boolean;
  upstashCheckActive: boolean;
}) {
  return (
    <div className="rounded-lg border border-blue-800/70 bg-blue-950/20 p-5 space-y-4">
      <div>
        <p className="text-base font-semibold text-white mb-1">Set up Upstash Redis</p>
        <p className="text-sm text-slate-400 leading-relaxed">
          Free tier, ~2-minute install. Saves survive restarts and redeploys on any host.
        </p>
      </div>
      <div className="flex flex-col sm:flex-row gap-3">
        <a
          href="https://vercel.com/integrations/upstash"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center justify-center gap-1.5 bg-blue-500 hover:bg-blue-400 text-white px-4 py-2 rounded-md text-sm font-semibold"
        >
          Add Upstash integration <span aria-hidden>↗</span>
        </a>
        <button
          type="button"
          onClick={onUpstashSetupStart}
          disabled={upstashCheckActive || checking}
          className="inline-flex items-center justify-center bg-slate-800 hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed text-slate-200 px-4 py-2 rounded-md text-sm font-semibold"
        >
          {upstashCheckActive
            ? "Auto-detecting…"
            : checking
              ? "Rechecking…"
              : "Already installed — detect"}
        </button>
      </div>
      <p className="text-[11px] text-slate-500 leading-relaxed">
        After you add the integration, Vercel redeploys with{" "}
        <code className="font-mono">UPSTASH_REDIS_REST_URL</code> /{" "}
        <code className="font-mono">_TOKEN</code>. We poll for ~120s and pick it up automatically.
      </p>
    </div>
  );
}

/** Ack card inside the advanced disclosure. */
function AdvancedOption({
  title,
  description,
  tone,
  buttonLabel,
  onClick,
  disabled,
}: {
  title: string;
  description: string;
  tone: "warning" | "neutral";
  buttonLabel: string;
  onClick: () => void;
  disabled: boolean;
}) {
  const border = tone === "warning" ? "border-amber-900/60" : "border-slate-800";
  const titleColor = tone === "warning" ? "text-amber-200" : "text-slate-200";
  const btnClass =
    tone === "warning"
      ? "bg-slate-800 hover:bg-slate-700 text-amber-200 border border-amber-900/60"
      : "bg-slate-800 hover:bg-slate-700 text-slate-200";
  return (
    <div className={`rounded-md border ${border} bg-slate-950/40 p-4 space-y-2`}>
      <p className={`text-sm font-semibold ${titleColor}`}>{title}</p>
      <p className="text-[11px] text-slate-400 leading-relaxed">{description}</p>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={`${btnClass} disabled:opacity-60 px-3 py-1.5 rounded-md text-xs font-semibold`}
      >
        {buttonLabel}
      </button>
    </div>
  );
}

/** Reference card: plain-language summary of the three backends. */
function StorageBackendsExplainer() {
  return (
    <div className="rounded-md border border-slate-800 bg-slate-950/30 p-4 space-y-2 text-[11px] text-slate-500 leading-relaxed">
      <p className="text-slate-400 font-semibold text-xs mb-1">How the backends differ</p>
      <p>
        <strong className="text-slate-300">Upstash (Redis):</strong> hosted key-value store. Saves
        from the dashboard hit it instantly. Works on Vercel, Docker, anywhere. Free tier covers
        personal use.
      </p>
      <p>
        <strong className="text-slate-300">Local file:</strong> writes{" "}
        <code className="font-mono">./data/kv.json</code> + <code className="font-mono">.env</code>.
        Auto-selected when the host has a durable filesystem (Docker with a mounted volume, local
        dev). Not for multi-instance deploys — each has its own file.
      </p>
      <p>
        <strong className="text-slate-300">Env vars only:</strong> no runtime persistence.
        Credentials live in the deploy environment and get read at startup. Change = redeploy.
      </p>
    </div>
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
      {/* Brand bar: logo + name pinned top-left so the product identity is
          visible throughout the wizard flow. Full-width so the mark anchors
          to the viewport edge instead of shifting with each step's narrow
          content column. */}
      <header className="border-b border-slate-900/80 px-6 py-4">
        <div className="flex items-center gap-2.5 text-white">
          <KebabLogo size={26} className="text-amber-400" />
          <span className="font-mono text-lg font-bold tracking-tight">Kebab MCP</span>
        </div>
      </header>
      {/* The wizard layout needs more horizontal room for the 3-card storage
          chooser; max-w-3xl gives enough breathing room without becoming a
          wide-and-thin desktop layout that's hard to scan. The narrow
          variant (max-w-xl) is kept for early-flow pages like "Generate
          token" where there's only one CTA to focus on. */}
      <div className={`mx-auto px-6 py-12 sm:py-16 ${wide ? "max-w-3xl" : "max-w-xl"}`}>
        <p className="text-xs font-mono text-blue-400 mb-4 tracking-wider uppercase">
          First-run setup
        </p>
        {children}
      </div>
    </div>
  );
}
