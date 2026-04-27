"use client";

import { useState } from "react";
import { RateLimitsWidget } from "../rate-limits-widget";

type Phase =
  | { kind: "idle" }
  | { kind: "confirming"; action: "export" | "import"; file?: File | undefined }
  | { kind: "auth-prompt"; action: "export" | "import"; file?: File | undefined }
  | { kind: "running"; action: "export" | "import" }
  | { kind: "import-preview"; diff: ImportDiff; file: File; token: string }
  | { kind: "done"; action: "export" | "import"; message: string }
  | { kind: "error"; message: string };

interface ImportDiff {
  added: string[];
  updated: string[];
  unchanged: string[];
}

/**
 * Advanced section — backup, restore, and other power-user operations that
 * we don't want surfaced as casual buttons.
 *
 * The full .env export is gated behind:
 *   1. A confirmation modal explaining what's being exported
 *   2. A re-auth prompt (admin token) — even if the user is already
 *      authed via cookie, we ask once more before materializing every
 *      secret in plaintext. Defense against shoulder-surfing and
 *      against tab-snatching scripts that abuse an existing session.
 *
 * Per-connector .env stubs (used in static mode) are NOT gated this way —
 * they only contain values the user just typed into the form, no
 * server-side secrets.
 */
export function AdvancedSection() {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  // Updates section state
  const [patValue, setPatValue] = useState("");
  const [patRevealed, setPatRevealed] = useState(false);
  const [patSaving, setPatSaving] = useState(false);
  const [patSaved, setPatSaved] = useState(false);
  const [patError, setPatError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testRunning, setTestRunning] = useState(false);

  // Diagnostics section state
  const [cacheClearing, setCacheClearing] = useState(false);
  const [cacheResult, setCacheResult] = useState<string | null>(null);

  const clearCache = async () => {
    setCacheClearing(true);
    setCacheResult(null);
    try {
      const res = await fetch("/api/config/sandbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          toolName: "mcp_cache_evict",
          args: { scope: "all" },
          confirm: true,
        }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (data.ok) {
        setCacheResult("All caches cleared");
        setTimeout(() => setCacheResult(null), 3000);
      } else {
        setCacheResult(data.error || "Failed to clear cache");
      }
    } catch (err) {
      setCacheResult(err instanceof Error ? err.message : "Network error");
    }
    setCacheClearing(false);
  };

  const savePat = async () => {
    if (!patValue.trim()) return;
    setPatSaving(true);
    setPatError(null);
    try {
      const res = await fetch("/api/config/env", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ vars: { KEBAB_UPDATE_PAT: patValue.trim() } }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (data.ok) {
        setPatSaved(true);
        setPatValue("");
        setTimeout(() => setPatSaved(false), 2500);
      } else {
        setPatError(data.error || "Save failed");
      }
    } catch {
      setPatError("Network error");
    }
    setPatSaving(false);
  };

  const testPat = async () => {
    setTestRunning(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/config/update", { credentials: "include" });
      const data = (await res.json()) as Record<string, unknown>;
      if (data.reason === "no-token") {
        setTestResult("No token configured.");
      } else if (data.available) {
        setTestResult(
          `OK — ${(data.behind_by as number | undefined) ?? (data.behind as number | undefined) ?? 0} update(s) available.`
        );
      } else if (data.status === "identical") {
        setTestResult("OK — fork is up to date.");
      } else if (data.status === "diverged" || data.status === "ahead") {
        setTestResult(`Fork has ${data.ahead_by as number} commit(s) ahead of upstream.`);
      } else if (data.reason === "auth") {
        setTestResult("Auth error — token may be invalid or missing scope.");
      } else {
        setTestResult(data.disabled ? `Disabled: ${data.disabled as string}` : "Check complete.");
      }
    } catch {
      setTestResult("Network error");
    }
    setTestRunning(false);
  };

  const handleExportClick = () => {
    setPhase({ kind: "confirming", action: "export" });
  };

  const handleImportFile = (file: File | null) => {
    if (!file) return;
    setPhase({ kind: "confirming", action: "import", file });
  };

  const proceedAfterConfirm = (current: Phase) => {
    if (current.kind !== "confirming") return;
    setPhase({
      kind: "auth-prompt",
      action: current.action,
      file: current.file,
    });
  };

  const performAction = async (token: string, current: Phase) => {
    if (current.kind !== "auth-prompt") return;
    setPhase({ kind: "running", action: current.action });

    if (current.action === "export") {
      try {
        const res = await fetch("/api/config/env-export", {
          headers: { Authorization: `Bearer ${token}` },
          credentials: "include",
        });
        if (res.status === 401 || res.status === 403) {
          setPhase({ kind: "error", message: "Invalid admin token. Try again." });
          return;
        }
        if (!res.ok) {
          setPhase({ kind: "error", message: `Export failed (HTTP ${res.status})` });
          return;
        }
        const text = await res.text();
        const blob = new Blob([text], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `kebab-mcp-backup-${new Date().toISOString().slice(0, 10)}.env`;
        a.click();
        URL.revokeObjectURL(url);
        setPhase({
          kind: "done",
          action: "export",
          message: "Backup downloaded. Store it securely — it contains all your credentials.",
        });
      } catch (err) {
        setPhase({
          kind: "error",
          message: err instanceof Error ? err.message : "Network error",
        });
      }
      return;
    }

    // import — first do a dry-run preview, then ask for second confirmation
    if (!current.file) {
      setPhase({ kind: "error", message: "No file selected" });
      return;
    }
    try {
      const text = await current.file.text();
      const res = await fetch("/api/storage/import?dryRun=1", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "text/plain",
        },
        credentials: "include",
        body: text,
      });
      if (res.status === 401 || res.status === 403) {
        setPhase({ kind: "error", message: "Invalid admin token. Try again." });
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setPhase({
          kind: "error",
          message: body.error || `Import preview failed (HTTP ${res.status})`,
        });
        return;
      }
      const data = (await res.json()) as { diff: ImportDiff };
      setPhase({
        kind: "import-preview",
        diff: data.diff,
        file: current.file,
        token,
      });
    } catch (err) {
      setPhase({
        kind: "error",
        message: err instanceof Error ? err.message : "Network error",
      });
    }
  };

  const confirmImport = async (current: Phase) => {
    if (current.kind !== "import-preview") return;
    // Snapshot the token locally then transition phase. As soon as the next
    // setPhase fires the token field disappears from the union, so it's no
    // longer reachable via React DevTools or accidental re-render. The
    // local `token` const lives only inside this closure and is GC-eligible
    // when the function returns.
    const token = current.token;
    const file = current.file;
    setPhase({ kind: "running", action: "import" });
    try {
      const text = await file.text();
      const res = await fetch("/api/storage/import", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "text/plain",
        },
        credentials: "include",
        body: text,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setPhase({
          kind: "error",
          message: body.error || `Import failed (HTTP ${res.status})`,
        });
        return;
      }
      const data = (await res.json()) as {
        added?: number;
        updated?: number;
        unchanged?: number;
      };
      setPhase({
        kind: "done",
        action: "import",
        message: `Imported ${data.added ?? 0} new and ${data.updated ?? 0} updated key(s).`,
      });
    } catch (err) {
      setPhase({
        kind: "error",
        message: err instanceof Error ? err.message : "Network error",
      });
    }
  };

  return (
    <div className="space-y-5 max-w-2xl">
      <div className="border border-border rounded-lg p-5 space-y-3">
        <h3 className="text-sm font-semibold">Backup & migration</h3>
        <p className="text-xs text-text-dim leading-relaxed">
          Export every credential and setting as a single <code>.env</code> file for backup,
          migration between deployments, or moving between Docker and Vercel. Re-auth required.
        </p>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={handleExportClick}
            className="text-sm font-medium px-4 py-1.5 rounded-md bg-bg-muted hover:bg-border-light text-text-dim hover:text-text border border-border"
          >
            Export full backup (.env)
          </button>
          <label className="text-sm font-medium px-4 py-1.5 rounded-md bg-bg-muted hover:bg-border-light text-text-dim hover:text-text border border-border cursor-pointer">
            Restore from .env…
            <input
              type="file"
              accept=".env,text/plain"
              className="hidden"
              onChange={(e) => handleImportFile(e.target.files?.[0] ?? null)}
            />
          </label>
        </div>
      </div>

      {phase.kind === "confirming" && (
        <Modal
          title={phase.action === "export" ? "Export full backup?" : "Restore from backup?"}
          onClose={() => setPhase({ kind: "idle" })}
        >
          <p className="text-xs text-text-dim leading-relaxed">
            {phase.action === "export" ? (
              <>
                The downloaded file contains <strong>all</strong> connector credentials in
                plaintext: API keys, OAuth refresh tokens, etc. Store it in a password manager or
                encrypted vault. Don&apos;t commit it, don&apos;t email it, don&apos;t paste it into
                chat.
              </>
            ) : (
              <>
                Importing will overwrite any existing values for keys present in the file.
                You&apos;ll see a preview before changes are committed.
              </>
            )}
          </p>
          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              onClick={() => setPhase({ kind: "idle" })}
              className="text-xs font-medium px-3 py-1.5 rounded-md text-text-dim hover:text-text"
            >
              Cancel
            </button>
            <button
              onClick={() => proceedAfterConfirm(phase)}
              className="text-xs font-medium px-4 py-1.5 rounded-md bg-accent text-white hover:bg-accent/90"
            >
              I understand, continue
            </button>
          </div>
        </Modal>
      )}

      {phase.kind === "auth-prompt" && (
        <AuthPrompt
          action={phase.action}
          onSubmit={(t) => performAction(t, phase)}
          onCancel={() => setPhase({ kind: "idle" })}
        />
      )}

      {phase.kind === "running" && (
        <Modal title="Working…" onClose={() => undefined}>
          <p className="text-xs text-text-dim">
            {phase.action === "export" ? "Exporting…" : "Importing…"}
          </p>
        </Modal>
      )}

      {phase.kind === "import-preview" && (
        <Modal title="Preview import" onClose={() => setPhase({ kind: "idle" })}>
          <div className="text-xs text-text-dim space-y-1">
            <p>
              <span className="text-green font-medium">+{phase.diff.added.length}</span> new key(s)
            </p>
            <p>
              <span className="text-orange font-medium">~{phase.diff.updated.length}</span> key(s)
              will be overwritten
            </p>
            <p>
              <span className="text-text-muted">={phase.diff.unchanged.length}</span> key(s)
              unchanged (skipped)
            </p>
          </div>
          {phase.diff.added.length + phase.diff.updated.length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer text-text-dim hover:text-text">Show keys</summary>
              <ul className="mt-2 max-h-40 overflow-y-auto space-y-0.5 font-mono text-[11px]">
                {phase.diff.added.map((k) => (
                  <li key={k} className="text-green">
                    + {k}
                  </li>
                ))}
                {phase.diff.updated.map((k) => (
                  <li key={k} className="text-orange">
                    ~ {k}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              onClick={() => setPhase({ kind: "idle" })}
              className="text-xs font-medium px-3 py-1.5 rounded-md text-text-dim hover:text-text"
            >
              Cancel
            </button>
            <button
              onClick={() => confirmImport(phase)}
              disabled={phase.diff.added.length + phase.diff.updated.length === 0}
              className="text-xs font-medium px-4 py-1.5 rounded-md bg-accent text-white hover:bg-accent/90 disabled:opacity-50"
            >
              {phase.diff.added.length + phase.diff.updated.length === 0
                ? "Nothing to import"
                : "Apply changes"}
            </button>
          </div>
        </Modal>
      )}

      {phase.kind === "done" && (
        <Modal title="Done" onClose={() => setPhase({ kind: "idle" })}>
          <p className="text-xs text-green">{phase.message}</p>
          <div className="flex justify-end pt-2">
            <button
              onClick={() => setPhase({ kind: "idle" })}
              className="text-xs font-medium px-4 py-1.5 rounded-md bg-accent text-white hover:bg-accent/90"
            >
              Close
            </button>
          </div>
        </Modal>
      )}

      {phase.kind === "error" && (
        <Modal title="Failed" onClose={() => setPhase({ kind: "idle" })}>
          <p className="text-xs text-red">{phase.message}</p>
          <div className="flex justify-end pt-2">
            <button
              onClick={() => setPhase({ kind: "idle" })}
              className="text-xs font-medium px-4 py-1.5 rounded-md bg-bg-muted hover:bg-border-light text-text-dim hover:text-text border border-border"
            >
              Close
            </button>
          </div>
        </Modal>
      )}

      {/* Updates section */}
      <div className="border-t border-border pt-5 mt-5">
        <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-3">
          Updates
        </h3>
        <p className="text-xs text-text-dim mb-3">
          Configure a GitHub PAT to enable one-click upstream sync from the Overview tab. Requires{" "}
          <code className="font-mono bg-bg-muted px-1 rounded">public_repo</code> scope for public
          forks, <code className="font-mono bg-bg-muted px-1 rounded">repo</code> scope for private
          forks. Fine-grained PATs: ensure <em>Contents: read/write</em> permission on your fork.
        </p>
        <details className="mb-4 text-xs text-text-dim">
          <summary className="cursor-pointer text-text-muted hover:text-text">
            How does the update flow work?
          </summary>
          <ul className="list-disc pl-5 mt-2 space-y-1.5">
            <li>
              A daily cron at 8h UTC pre-fetches upstream status into your Upstash KV — the Overview
              banner loads instantly without a GitHub round-trip.
            </li>
            <li>
              Clicking <strong>Update now</strong> in the banner calls GitHub&apos;s{" "}
              <code className="font-mono bg-bg-muted px-1 rounded">merge-upstream</code> API. Your
              fork&apos;s <code>main</code> fast-forwards, Vercel detects the push, and redeploys
              automatically (~2 minutes).
            </li>
            <li>
              If your fork has diverged (local commits on <code>main</code>), the button is disabled
              and a manual-resolution link to GitHub is shown.
            </li>
            <li>
              The ↻ icon next to &quot;checked Xh ago&quot; forces a re-check between cron runs.
              30-second debounce to avoid API spam.
            </li>
            <li>
              Possible breaking changes (commits flagged{" "}
              <code className="font-mono bg-bg-muted px-1 rounded">feat!:</code> or{" "}
              <code className="font-mono bg-bg-muted px-1 rounded">BREAKING CHANGE:</code>) get a
              heuristic warning + link to upstream release notes.
            </li>
            <li>
              Saving a new PAT here invalidates the cache immediately — no waiting for the next cron
              run.
            </li>
            <li>
              To disable entirely, set{" "}
              <code className="font-mono bg-bg-muted px-1 rounded">KEBAB_DISABLE_UPDATE_API=1</code>{" "}
              in your Vercel env vars.
            </li>
          </ul>
        </details>

        <div className="space-y-3">
          {/* PAT input */}
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <label className="text-sm font-medium">Update token</label>
              <code className="text-[11px] text-text-muted">KEBAB_UPDATE_PAT</code>
            </div>
            <div className="flex gap-2">
              <input
                type={patRevealed ? "text" : "password"}
                placeholder="ghp_… or github_pat_…"
                value={patValue}
                onChange={(e) => setPatValue(e.target.value)}
                className="flex-1 bg-bg-muted border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent font-mono"
              />
              <button
                type="button"
                onClick={() => setPatRevealed((r) => !r)}
                className="text-xs px-2.5 py-2 rounded-md border border-border bg-bg-muted hover:bg-border-light text-text-dim transition-colors"
              >
                {patRevealed ? "Hide" : "Show"}
              </button>
            </div>
            <p className="text-xs text-text-muted mt-1">
              Stored in your Upstash KV under <code>cred:KEBAB_UPDATE_PAT</code>. Takes effect
              immediately — no redeploy required. Saving here also invalidates the update-check
              cache, so the Overview banner reflects the new auth state on next load.
            </p>
          </div>

          {/* Save + Test buttons */}
          <div className="flex items-center gap-3 flex-wrap">
            <button
              type="button"
              onClick={savePat}
              disabled={patSaving || !patValue.trim()}
              className="bg-accent text-white text-sm font-medium px-4 py-2 rounded-md hover:bg-accent/90 disabled:opacity-50 transition-colors"
            >
              {patSaving ? "Saving..." : "Save token"}
            </button>
            <button
              type="button"
              onClick={testPat}
              disabled={testRunning}
              className="text-sm font-medium px-4 py-2 rounded-md border border-border bg-bg-muted hover:bg-border-light text-text-dim hover:text-text disabled:opacity-50 transition-colors"
            >
              {testRunning ? "Testing..." : "Test connection"}
            </button>
            {patSaved && <span className="text-xs text-green">Token saved</span>}
            {patError && <span className="text-xs text-red-500">{patError}</span>}
          </div>

          {/* Test result inline */}
          {testResult && (
            <p className="text-xs text-text-dim bg-bg-muted border border-border rounded px-3 py-2 font-mono">
              {testResult}
            </p>
          )}
        </div>
      </div>

      {/* Diagnostics section */}
      <div className="border-t border-border pt-5 mt-5">
        <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-3">
          Diagnostics
        </h3>
        <p className="text-xs text-text-dim mb-4">
          Inspect active rate-limit scopes and clear server-side caches. Useful when troubleshooting
          stale state after manual env changes.
        </p>

        <div className="space-y-4">
          {/* Rate limits */}
          <RateLimitsWidget />

          {/* Cache management */}
          <div>
            <div className="flex items-center gap-3">
              <button
                onClick={clearCache}
                disabled={cacheClearing}
                className="text-xs font-medium px-3 py-2 rounded-md bg-bg-muted hover:bg-border-light text-text-dim hover:text-text border border-border transition-colors disabled:opacity-50"
              >
                {cacheClearing ? "Clearing..." : "Clear cache"}
              </button>
              {cacheResult && <span className="text-xs text-text-muted">{cacheResult}</span>}
            </div>
            <p className="text-[11px] text-text-muted mt-1.5">
              Evicts registry, KV-read, and log-buffer caches. Equivalent to{" "}
              <code className="font-mono bg-bg-muted px-1 rounded">mcp_cache_evict</code> with scope{" "}
              <code className="font-mono bg-bg-muted px-1 rounded">all</code>.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-bg border border-border rounded-lg max-w-md w-full p-5 space-y-3 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold">{title}</h3>
        {children}
      </div>
    </div>
  );
}

function AuthPrompt({
  action,
  onSubmit,
  onCancel,
}: {
  action: "export" | "import";
  onSubmit: (token: string) => void;
  onCancel: () => void;
}) {
  const [token, setToken] = useState("");
  const [showing, setShowing] = useState(false);

  return (
    <Modal title="Confirm with admin token" onClose={onCancel}>
      <p className="text-xs text-text-dim">
        Re-enter your admin token to{" "}
        {action === "export" ? "download the backup" : "apply the import"}. This is an extra check
        on top of your dashboard session.
      </p>
      <div className="flex items-center gap-2">
        <input
          type={showing ? "text" : "password"}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="paste your admin token"
          className="flex-1 bg-bg-muted border border-border rounded px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-accent/30"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter" && token) onSubmit(token);
          }}
        />
        <button
          onClick={() => setShowing((s) => !s)}
          className="text-xs text-text-muted hover:text-text px-2 py-1"
          type="button"
        >
          {showing ? "Hide" : "Show"}
        </button>
      </div>
      <div className="flex items-center justify-end gap-2 pt-2">
        <button
          onClick={onCancel}
          className="text-xs font-medium px-3 py-1.5 rounded-md text-text-dim hover:text-text"
        >
          Cancel
        </button>
        <button
          onClick={() => token && onSubmit(token)}
          disabled={!token}
          className="text-xs font-medium px-4 py-1.5 rounded-md bg-accent text-white hover:bg-accent/90 disabled:opacity-50"
        >
          Continue
        </button>
      </div>
    </Modal>
  );
}
