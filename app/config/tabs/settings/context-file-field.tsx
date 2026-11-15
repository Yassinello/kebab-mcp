"use client";

import { useEffect, useState } from "react";

type Mode = "inline" | "vault";

interface ContextState {
  mode: Mode;
  inline: string;
  vaultPath: string;
}

/**
 * Dual-mode context file editor.
 *
 * - `inline`: persists the markdown directly in the KV store under
 *   `mymcp:context:inline`. Always available.
 * - `vault`: persists a vault path under `MYMCP_CONTEXT_PATH` env var.
 *   Only enabled when the Memory Vault connector is active (it is by default).
 */
export function ContextFileField({
  vaultEnabled,
  initialPath,
}: {
  vaultEnabled: boolean;
  initialPath: string;
}) {
  const [state, setState] = useState<ContextState>({
    mode: "inline",
    inline: "",
    vaultPath: initialPath,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load current state from server
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/config/context", { credentials: "include" });
        if (!res.ok) {
          if (!cancelled) {
            setLoading(false);
          }
          return;
        }
        const data = (await res.json()) as ContextState;
        if (!cancelled) {
          // Force inline if vault disabled even when server returned vault mode
          const mode: Mode = !vaultEnabled && data.mode === "vault" ? "inline" : data.mode;
          setState({
            mode,
            inline: data.inline ?? "",
            vaultPath: data.vaultPath ?? initialPath,
          });
          setLoading(false);
        }
      } catch {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vaultEnabled, initialPath]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/config/context", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(state),
      });
      const data = await res.json();
      if (data.ok) {
        setSavedFlash(true);
        // Auto-clear after 2.5s — previously used a timestamp comparison
        // that only cleared on next render (so the banner stuck if the
        // user didn't interact). Explicit timer is simpler.
        setTimeout(() => setSavedFlash(false), 2500);
      } else {
        setError(data.error || "Save failed");
      }
    } catch {
      setError("Network error");
    }
    setSaving(false);
  };

  if (loading) {
    return <div className="text-xs text-text-muted">Loading…</div>;
  }

  return (
    <div className="space-y-3">
      {/* Mode toggle */}
      <div
        className="inline-flex border border-border rounded-md overflow-hidden text-xs"
        role="tablist"
      >
        <button
          type="button"
          onClick={() => setState((s) => ({ ...s, mode: "inline" }))}
          className={`px-3 py-1.5 transition-colors ${
            state.mode === "inline"
              ? "bg-accent text-white"
              : "bg-bg-muted text-text-dim hover:text-text"
          }`}
        >
          Inline markdown
        </button>
        <button
          type="button"
          onClick={() => vaultEnabled && setState((s) => ({ ...s, mode: "vault" }))}
          disabled={!vaultEnabled}
          title={
            vaultEnabled
              ? "Pick a markdown note from your memory vault"
              : "Enable the Memory Vault connector to use this mode"
          }
          className={`px-3 py-1.5 transition-colors ${
            state.mode === "vault"
              ? "bg-accent text-white"
              : "bg-bg-muted text-text-dim hover:text-text"
          } ${!vaultEnabled ? "opacity-50 cursor-not-allowed" : ""}`}
        >
          Pick from vault
        </button>
      </div>

      {state.mode === "inline" ? (
        <textarea
          value={state.inline}
          onChange={(e) => setState((s) => ({ ...s, inline: e.target.value }))}
          rows={10}
          placeholder="# About me&#10;&#10;Markdown that describes you, your role, current projects, preferences."
          className="w-full bg-bg-muted border border-border rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
        />
      ) : (
        <div className="space-y-2">
          <input
            type="text"
            value={state.vaultPath}
            onChange={(e) => setState((s) => ({ ...s, vaultPath: e.target.value }))}
            placeholder="System/context.md"
            className="w-full bg-bg-muted border border-border rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
          />
          <p className="text-[11px] text-text-muted">
            Path inside your vault, relative to the vault root. Example:{" "}
            <code className="font-mono">System/context.md</code>.
          </p>
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="bg-bg border border-border hover:bg-bg-muted text-text text-xs font-medium px-3 py-1.5 rounded-md disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save context"}
        </button>
        {savedFlash && <span className="text-xs text-green">Saved</span>}
        {error && <span className="text-xs text-red-500">{error}</span>}
      </div>
    </div>
  );
}
