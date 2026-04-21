"use client";

import type { ReactNode } from "react";
import { KebabLogo } from "../components/kebab-logo";

/**
 * Welcome-flow chrome: outer layout shell, stepper, recovery footer.
 * Extracted from WelcomeShell.tsx in Phase 47 WIRE-03 to keep the
 * orchestrator at ≤ 200 LOC.
 */

export type WizardStep = 1 | 2 | 3;

// ── Outer layout: brand bar + centered content column. ────────────────

export function Shell({ children, wide }: { children: ReactNode; wide?: boolean }) {
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

// ── Wizard stepper: 1|2|3 progress indicator with reachability gates. ─

export function WizardStepper({
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

// ── Recovery footer: MYMCP_RECOVERY_RESET escape hatch. ───────────────

export function RecoveryFooter() {
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

// ── Static banners. ───────────────────────────────────────────────────

export function PreviewBanner() {
  return (
    <div className="mb-6 rounded-lg border border-purple-800 bg-purple-950/40 px-4 py-3 text-sm text-purple-200">
      <strong className="font-semibold">Preview mode</strong> — read-only rendering against your
      live instance. No state is mutated. Close this tab when done.
    </div>
  );
}

export function RecoveryResetBanner() {
  return (
    <div className="mb-6 rounded-lg border border-red-800 bg-red-950/40 px-4 py-3 text-sm text-red-200">
      <p className="font-semibold mb-1">⚠ MYMCP_RECOVERY_RESET=1 is still set</p>
      <p className="text-xs leading-relaxed text-red-200/90">
        Every cold lambda on this deployment wipes the bootstrap (it&apos;s the recovery escape
        hatch). Any token you mint right now will vanish within a few minutes, and the instance will
        silently drop back to first-run mode. <strong>Remove the env var</strong> from Vercel
        Settings → Environment Variables, redeploy, then reload this page before running through the
        wizard.
      </p>
    </div>
  );
}
