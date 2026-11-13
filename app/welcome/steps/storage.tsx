"use client";

import { PRODUCT } from "@/core/constants/brand";
import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { useWelcomeDispatch, useWelcomeState } from "../WelcomeStateContext";

/**
 * StorageStep — Phase 47 WIRE-01a (v2, live).
 *
 * Step 1 of the welcome wizard. Detects the storage backend
 * (Upstash / filesystem / memory), surfaces the "Add Upstash"
 * call-to-action, polls for mode transitions when the user is in
 * the middle of an Upstash-integration setup, and lets the user
 * acknowledge non-ideal modes (ephemeral /tmp, static env-only).
 *
 * JSX migrated verbatim from the legacy `renderStepStorage` /
 * `WelcomeStorageStep` / `StorageStatusLine` / `UpstashPrimaryCta` /
 * `UpstashCheckPanel` / `AdvancedOption` / `StorageBackendsExplainer`
 * closures in `WelcomeShell.tsx` (Phase 45 body). Reducer dispatches
 * replace the legacy useState setters for wizard-level fields
 * (`ack`, `step`). Transient UI-only state (storageStatus fetch
 * lifecycle, upstash-check countdown, last-check outcome) lives in
 * step-local useState — single consumer, no reducer value.
 */

// ── Types ─────────────────────────────────────────────────────────────

export type StorageMode = "kv" | "file" | "static" | "kv-degraded";

export interface StorageStatus {
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

type AckValue = "static" | "ephemeral" | null;

type LastCheckOutcome =
  | { kind: "idle" }
  | { kind: "no-change"; at: number }
  | { kind: "mode-changed"; from: StorageMode; to: StorageMode; at: number }
  | { kind: "timeout"; at: number };

// ── Cookie / localStorage helpers for ack persistence ─────────────────
//
// v3 ack cookie: `mymcp.storage.ack.v3` with semantic values "static"|"ephemeral".
// v2 ack cookie: `mymcp.storage.ack` — purged on v3 mount so users see the new UX.

const ACK_COOKIE = "mymcp.storage.ack.v3";
const LEGACY_ACK_COOKIE = "mymcp.storage.ack";

function deleteCookie(name: string): void {
  if (typeof document === "undefined") return;
  document.cookie = `${name}=; path=/; max-age=0; samesite=lax`;
}

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

function clearAck(): void {
  deleteCookie(ACK_COOKIE);
  try {
    window.localStorage.removeItem(ACK_COOKIE);
  } catch {
    // ignore
  }
}

// ── StorageStep ───────────────────────────────────────────────────────

export function StorageStep({ onContinue }: { onContinue?: () => void }): JSX.Element {
  const state = useWelcomeState();
  const dispatch = useWelcomeDispatch();

  // Step-local state (single consumer, not reducer fields — see INVENTORY).
  const [storageStatus, setStorageStatus] = useState<StorageStatus | null>(null);
  const [storageChecking, setStorageChecking] = useState(false);
  const [storageFailures, setStorageFailures] = useState(0);
  const [upstashCheckActive, setUpstashCheckActive] = useState(false);
  const [upstashCheckSecondsLeft, setUpstashCheckSecondsLeft] = useState(0);
  const [lastCheckOutcome, setLastCheckOutcome] = useState<LastCheckOutcome>({ kind: "idle" });

  // ack mirrors reducer; kept in step-local useState to reflect the mount
  // hydrate (cookie read) before the reducer gets the ACK_SET dispatch.
  const ack = state.ack;
  const ackPersisted = state.ackPersisted;

  // Hydrate ack + purge legacy v2 on mount.
  useEffect(() => {
    purgeLegacyAck();
    const v = readAck();
    if (v !== null) {
      dispatch({ type: "ACK_SET", value: v, persisted: true });
    }
  }, [dispatch]);

  // Auto-clear ack when mode flips to healthy.
  useEffect(() => {
    if (!storageStatus) return;
    const healthyMode =
      storageStatus.mode === "kv" || (storageStatus.mode === "file" && !storageStatus.ephemeral);
    if (healthyMode && ack !== null) {
      clearAck();
      dispatch({ type: "ACK_SET", value: null, persisted: true });
    }
  }, [storageStatus, ack, dispatch]);

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
      setStorageFailures((n) => n + 1);
    } finally {
      setStorageChecking(false);
    }
  }, []);

  // Initial load + reload on token change.
  useEffect(() => {
    void loadStorageStatus(false);
  }, [loadStorageStatus, state.token]);

  // Auto-retry on failure while we have no status yet. Backs off 3s → 6s.
  useEffect(() => {
    if (storageStatus) return;
    if (storageFailures === 0) return;
    if (storageFailures >= 3) return;
    const delayMs = storageFailures === 1 ? 3000 : 6000;
    const id = setTimeout(() => void loadStorageStatus(true), delayMs);
    return () => clearTimeout(id);
  }, [storageStatus, storageFailures, loadStorageStatus]);

  // Ambient 20s poll while in transient (non-settled) modes.
  useEffect(() => {
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

  // Active Upstash-setup polling: 1 Hz countdown + 5s poll + timeout.
  useEffect(() => {
    if (!upstashCheckActive) return;
    const id = setInterval(() => {
      setUpstashCheckSecondsLeft((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(id);
  }, [upstashCheckActive]);

  useEffect(() => {
    if (!upstashCheckActive) return;
    const id = setInterval(() => loadStorageStatus(true), 5000);
    return () => clearInterval(id);
  }, [upstashCheckActive, loadStorageStatus]);

  useEffect(() => {
    if (!upstashCheckActive) return;
    if (upstashCheckSecondsLeft > 0) return;
    setUpstashCheckActive(false);
    setLastCheckOutcome((prev) =>
      prev.kind === "mode-changed" && prev.to === "kv" ? prev : { kind: "timeout", at: Date.now() }
    );
  }, [upstashCheckSecondsLeft, upstashCheckActive]);

  // Mode-transition detection. Uses ref-mirror so toggling the upstash
  // active loop doesn't spuriously re-fire the no-change branch.
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
      setLastCheckOutcome({ kind: "no-change", at: Date.now() });
    }
    prevModeRef.current = curr;
  }, [storageStatus]);

  const startUpstashCheck = useCallback(() => {
    setLastCheckOutcome({ kind: "idle" });
    setUpstashCheckSecondsLeft(120);
    setUpstashCheckActive(true);
  }, []);

  const stopUpstashCheck = useCallback(() => {
    setUpstashCheckActive(false);
  }, []);

  const acknowledge = useCallback(
    (value: "static" | "ephemeral") => {
      const { persisted } = writeAck(value);
      dispatch({ type: "ACK_SET", value, persisted });
    },
    [dispatch]
  );

  // Bridge storageStatus into the reducer's WizardStorageSummary so other
  // steps / predicates can read it without consuming the hook themselves.
  // `durable` is stricter than `healthy`: it reflects cross-cold-start
  // persistence (kv OR non-ephemeral file) and drives the mint + test
  // persistenceReady gates.
  useEffect(() => {
    if (!storageStatus) return;
    const reducerMode: "upstash" | "filesystem" | "memory" =
      storageStatus.mode === "kv"
        ? "upstash"
        : storageStatus.mode === "file"
          ? "filesystem"
          : "memory";
    const durable =
      storageStatus.mode === "kv" || (storageStatus.mode === "file" && !storageStatus.ephemeral);
    const healthy =
      durable ||
      (storageStatus.mode === "file" && Boolean(storageStatus.ephemeral) && ack === "ephemeral") ||
      (storageStatus.mode === "static" && ack === "static");
    if (
      state.storage.healthy !== healthy ||
      state.storage.mode !== reducerMode ||
      state.storage.durable !== durable
    ) {
      dispatch({
        type: "STORAGE_UPDATED",
        storage: { healthy, mode: reducerMode, durable },
      });
    }
  }, [
    storageStatus,
    ack,
    dispatch,
    state.storage.healthy,
    state.storage.mode,
    state.storage.durable,
  ]);

  // Derived flags (match legacy WelcomeShell semantics).
  const detectionTrapped = storageStatus === null && storageFailures >= 3;
  const storageReady =
    storageStatus?.mode === "kv" ||
    (storageStatus?.mode === "file" && !storageStatus.ephemeral) ||
    (storageStatus?.mode === "file" && storageStatus.ephemeral && ack === "ephemeral") ||
    (storageStatus?.mode === "static" && ack === "static") ||
    detectionTrapped;

  const ackMismatch = Boolean(
    ack !== null &&
    storageStatus &&
    !(storageStatus.mode === "kv") &&
    !(storageStatus.mode === "file" && !storageStatus.ephemeral) &&
    !(storageStatus.mode === "file" && storageStatus.ephemeral && ack === "ephemeral") &&
    !(storageStatus.mode === "static" && ack === "static")
  );

  const handleContinue = useCallback(() => {
    dispatch({ type: "STEP_SET", step: "mint" });
    onContinue?.();
  }, [dispatch, onContinue]);

  return (
    <section>
      <StepHeader
        title="Where your data lives"
        subtitle={`Pick where ${PRODUCT.name} saves your credentials, skills, and context. You can change this later from the dashboard.`}
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
          enabled: Boolean(storageReady),
          onClick: handleContinue,
        }}
      />
    </section>
  );
}

// ── Shared step chrome (used by this step's internal renders) ─────────

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
  primary: {
    label: string;
    enabled: boolean;
    onClick?: (() => void) | undefined;
    href?: string | undefined;
  };
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

// ── Upstash check panel ───────────────────────────────────────────────

function UpstashCheckPanel({
  secondsLeft,
  onStop,
  lastCheckOutcome,
}: {
  secondsLeft: number;
  onStop: () => void;
  lastCheckOutcome: LastCheckOutcome;
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

// ── WelcomeStorageStep (chooser cards) ────────────────────────────────

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
  onUpstashSetupStart: () => void;
  upstashCheckActive: boolean;
}) {
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
  return (
    <div className="rounded-md border border-amber-800 bg-amber-950/30 px-4 py-2.5 text-sm text-amber-200 flex items-center gap-2">
      <span aria-hidden>⚠</span>
      <span>Read-only filesystem — no persistent storage configured yet</span>
    </div>
  );
}

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
