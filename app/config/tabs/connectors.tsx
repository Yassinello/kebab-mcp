"use client";

import { useState, useEffect, useCallback } from "react";
import type { ConnectorSummary } from "../tabs";
import { PACKS, CredentialInput, normalizeGitHubRepo } from "../pack-defs";
import { renderMarkdown } from "@/core/markdown-lite";
import { EnvStubBlock } from "./env-stub-block";
import { ApiConnectionsSection } from "./api-connections-section";

type StorageMode = "kv" | "file" | "static" | "kv-degraded" | null;

export function ConnectorsTab({ connectors }: { connectors: ConnectorSummary[] }) {
  const [envVars, setEnvVars] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<
    Record<string, { ok: boolean; message: string; detail?: string }>
  >({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState<string | null>(null);
  const [savedBackend, setSavedBackend] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<Record<string, string>>({});
  const [storageMode, setStorageMode] = useState<StorageMode>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [storageEphemeral, setStorageEphemeral] = useState(false);

  // Load current env on mount
  useEffect(() => {
    fetch("/api/config/env", { credentials: "include" })
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) setEnvVars(data.vars || {});
      })
      .finally(() => setLoading(false));
  }, []);

  // Load storage mode so we can branch the save UX (disable in static, show
  // KV-degraded warning, ephemeral warning, etc). Lightweight call — counts
  // skipped.
  useEffect(() => {
    fetch("/api/storage/status?counts=0", { credentials: "include" })
      .then((r) => r.json())
      .then((data) => {
        setStorageMode(data.mode ?? null);
        setStorageError(data.error ?? null);
        setStorageEphemeral(Boolean(data.ephemeral));
      })
      .catch(() => {
        // Network error: keep mode null. Save button is enabled (server has
        // the final say) but we won't render the stub helper or the
        // KV-degraded badge — both rely on a known mode value.
      });
  }, []);

  // Static mode: saves are disabled, we render a per-connector .env stub
  // helper instead. kv-degraded also blocks. Null mode (network error during
  // detect) keeps saves enabled — server-side validation still runs.
  // Ephemeral (/tmp on Vercel) does NOT disable saves — they technically
  // work, just don't persist. We show a prominent warning banner instead.
  const savesDisabled = storageMode === "static" || storageMode === "kv-degraded";

  const getValue = useCallback(
    (key: string): string => {
      if (key in edits) return edits[key] ?? "";
      return envVars[key] || "";
    },
    [edits, envVars]
  );

  const updateEdit = (key: string, value: string) => {
    setEdits((p) => ({ ...p, [key]: value }));
  };

  const testPack = async (packId: string) => {
    setTesting(packId);
    setTestResults((p) => ({ ...p, [packId]: { ok: false, message: "Testing..." } }));
    const packDef = PACKS.find((p) => p.id === packId);
    if (!packDef) return;
    const creds: Record<string, string> = {};
    for (const v of packDef.vars) {
      const val = getValue(v.key);
      if (val && !val.includes("•")) creds[v.key] = val;
    }
    try {
      const res = await fetch("/api/setup/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ pack: packId, credentials: creds }),
      });
      const data = await res.json();
      setTestResults((p) => ({
        ...p,
        [packId]: {
          ok: data.ok ?? false,
          message: data.message || data.error || "Unknown error",
          detail: data.detail,
        },
      }));
    } catch {
      setTestResults((p) => ({
        ...p,
        [packId]: { ok: false, message: "Network error" },
      }));
    }
    setTesting(null);
  };

  const savePack = async (packId: string) => {
    setSavingId(packId);
    setSaveError((p) => ({ ...p, [packId]: "" }));
    const packDef = PACKS.find((p) => p.id === packId);
    if (!packDef) return;
    const vars: Record<string, string> = {};
    for (const v of packDef.vars) {
      const edited = edits[v.key];
      if (edited !== undefined && edited !== "" && !edited.includes("\u2022")) {
        vars[v.key] = v.key === "GITHUB_REPO" ? normalizeGitHubRepo(edited) : edited;
      }
    }
    if (Object.keys(vars).length === 0) {
      setSavingId(null);
      return;
    }
    try {
      const res = await fetch("/api/config/env", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ vars }),
      });
      const data = await res.json();
      if (data.ok) {
        setEnvVars((p) => ({ ...p, ...vars }));
        setEdits((p) => {
          const next = { ...p };
          for (const k of Object.keys(vars)) delete next[k];
          return next;
        });
        // Toast label reflects actual durability. The review surfaced a
        // critical bug: in ephemeral mode the save returns
        // storageBackend="filesystem" and the old code showed a green
        // "Saved" toast — contradicting the amber ephemeral banner above
        // and tricking the user into thinking creds persisted.
        const backendLabel = data.ephemeral
          ? "Saved (temporary — will vanish on cold start)"
          : data.storageBackend === "upstash"
            ? "Saved to Upstash"
            : data.storageBackend === "vercel-api"
              ? "Saved to Vercel"
              : "Saved";
        setSavedFlash(packId);
        setSavedBackend(backendLabel);
        setTimeout(() => {
          setSavedFlash(null);
          setSavedBackend(null);
        }, 3000);
        // After a successful save, the server-side registry will see the
        // new env vars and flip `enabled: true` for connectors whose
        // required vars are now all present. The client still holds the
        // pre-save server snapshot, so the toggle would still show OFF
        // and the "Setup needed" badge would persist until the next page
        // load. Force a reload after a brief delay so the user sees the
        // "Saved" toast first, then lands on the freshly-gated state.
        // Skipped in ephemeral mode (no point reloading — the var won't
        // survive the next cold start anyway and the user has bigger
        // problems to read in the amber banner).
        if (!data.ephemeral) {
          setTimeout(() => {
            window.location.reload();
          }, 800);
        }
        // Sync ephemeral flag — if the save landed in ephemeral storage
        // but state still said non-ephemeral (e.g. race between detect
        // cache and actual save), update so the banner appears.
        if (typeof data.ephemeral === "boolean") {
          setStorageEphemeral(data.ephemeral);
        }
        // If the user just saved UPSTASH_REDIS_REST_URL/TOKEN, the
        // detection cache was cleared server-side but our client still
        // holds the old mode. Refetch so the amber banner disappears
        // and the badge flips to green without a page reload.
        const savedKeys = Object.keys(vars);
        if (
          savedKeys.includes("UPSTASH_REDIS_REST_URL") ||
          savedKeys.includes("UPSTASH_REDIS_REST_TOKEN")
        ) {
          try {
            const statusRes = await fetch("/api/storage/status?force=1&counts=0", {
              credentials: "include",
            });
            if (statusRes.ok) {
              const s = (await statusRes.json()) as {
                mode?: StorageMode;
                ephemeral?: boolean;
                error?: string;
              };
              setStorageMode(s.mode ?? null);
              setStorageEphemeral(Boolean(s.ephemeral));
              setStorageError(s.error ?? null);
            }
          } catch {
            // Silent — next page load will re-detect
          }
        }
      } else {
        // Server reported the mode if relevant — sync local state so the
        // stub helper appears without a manual recheck.
        if (data.mode === "static" || data.mode === "kv-degraded") {
          setStorageMode(data.mode);
        }
        if (typeof data.ephemeral === "boolean") {
          setStorageEphemeral(data.ephemeral);
        }
        setSaveError((p) => ({ ...p, [packId]: data.error || "Save failed" }));
      }
    } catch {
      setSaveError((p) => ({ ...p, [packId]: "Network error — check your connection" }));
    }
    setSavingId(null);
  };

  const togglePack = async (packId: string, enable: boolean) => {
    if (savesDisabled) {
      // Mirror the Save button behavior: surface a clear error rather than
      // letting the toggle visually flip and silently fail server-side.
      setSaveError((p) => ({
        ...p,
        [packId]:
          storageMode === "static"
            ? "Static mode — toggle this connector via env vars (MYMCP_DISABLE_<id>) and redeploy."
            : `KV unreachable${storageError ? ` — ${storageError}` : ""} — toggle blocked until KV recovers.`,
      }));
      // Make sure the card is open so the error is visible.
      setExpanded(packId);
      return;
    }
    const key = `MYMCP_DISABLE_${packId.toUpperCase()}`;
    const vars = { [key]: enable ? "" : "true" };
    try {
      const res = await fetch("/api/config/env", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ vars }),
      });
      const data = await res.json();
      if (data.ok) {
        setEnvVars((p) => ({ ...p, ...vars }));
        // Reload to re-fetch registry state
        window.location.reload();
      } else {
        // Non-ok with mode hint → sync local state, surface error inline.
        if (data.mode === "static" || data.mode === "kv-degraded") {
          setStorageMode(data.mode);
        }
        setSaveError((p) => ({
          ...p,
          [packId]: data.error || "Failed to toggle connector",
        }));
        setExpanded(packId);
      }
    } catch {
      setSaveError((p) => ({ ...p, [packId]: "Failed to toggle connector" }));
    }
  };

  if (loading) {
    return <p className="text-sm text-text-muted">Loading connectors...</p>;
  }

  // Hide:
  // - core connectors (skills, admin) — framework plumbing, not user-
  //   configurable integrations.
  // - api-connections — technically a pack in the registry, but the only
  //   way to interact with it is via the dedicated <ApiConnectionsSection />
  //   below. Showing a placeholder card here too made users wonder which
  //   surface was authoritative and how the two related. The section below
  //   is the single source of truth for creating and managing connections.
  const HIDDEN_PACK_IDS = new Set(["api-connections"]);
  const visibleConnectors = connectors.filter((c) => !c.core && !HIDDEN_PACK_IDS.has(c.id));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm text-text-dim">
          Click a connector to configure credentials, test, and toggle on or off.
        </p>
        <span className="text-xs text-text-dim">
          Expand a connector below to configure credentials
        </span>
      </div>

      {/* Ephemeral /tmp warning — saves succeed server-side but vanish on
          cold start. Not a "disabled" state (button still works) but a
          prominent caution so users on Vercel without Upstash know what
          they're in for. Goes away automatically once Upstash is set up. */}
      {storageMode === "file" && storageEphemeral && (
        <div className="mb-4 border border-orange/40 rounded-lg p-4 bg-orange-bg/40">
          <p className="text-sm font-semibold text-orange mb-1">
            ⚠ Saves here won&apos;t survive cold starts
          </p>
          <p className="text-xs text-text-dim leading-relaxed">
            This instance is running on Vercel without Upstash. Credentials go to{" "}
            <code className="font-mono">/tmp</code>, which Vercel recycles every 15–30 min.{" "}
            <a href="/config?tab=storage" className="text-accent underline underline-offset-2">
              Set up Upstash →
            </a>{" "}
            to keep them permanently.
          </p>
        </div>
      )}

      {visibleConnectors.map((pack) => {
        const packDef = PACKS.find((p) => p.id === pack.id);
        const isOpen = expanded === pack.id;
        const test = testResults[pack.id];
        // "Configured" = active, or inactive for a reason other than missing env vars.
        // A connector that's missing creds should be treated as not-yet-configured
        // so the toggle acts as a "Setup" affordance instead of a silent no-op.
        const isConfigured = pack.enabled || !pack.reason.startsWith("missing env");

        const handleCardClick = () => {
          setExpanded(isOpen ? null : pack.id);
        };

        return (
          <div
            key={pack.id}
            className={`border rounded-lg overflow-hidden transition-all ${
              pack.enabled ? "border-accent/30" : "border-border"
            } ${isOpen ? "shadow-sm" : ""}`}
          >
            <div
              role="button"
              tabIndex={0}
              onClick={handleCardClick}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  handleCardClick();
                }
              }}
              className="flex items-center gap-3 px-3 sm:px-5 py-4 cursor-pointer hover:bg-bg-muted/40 transition-colors"
            >
              <div
                className={`w-9 h-9 rounded-lg flex items-center justify-center font-bold text-sm ${
                  pack.enabled
                    ? "bg-accent text-white"
                    : "bg-bg-muted text-text-muted border border-border-light"
                }`}
              >
                {pack.label.charAt(0)}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-semibold text-sm">{pack.label}</p>
                  <span
                    className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${
                      pack.enabled
                        ? "text-green bg-green-bg"
                        : isConfigured
                          ? "text-text-muted bg-bg-muted"
                          : "text-accent bg-accent/10"
                    }`}
                  >
                    {pack.enabled ? "Active" : isConfigured ? "Inactive" : "Setup needed"}
                  </span>
                  <span className="text-[11px] text-text-muted">{pack.toolCount} tools</span>
                  {savedFlash === pack.id && (
                    <span
                      className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${
                        storageEphemeral ? "text-orange bg-orange-bg" : "text-green bg-green-bg"
                      }`}
                    >
                      {savedBackend || "Saved"}
                    </span>
                  )}
                </div>
                <p className="text-xs text-text-dim mt-0.5 truncate">
                  {pack.enabled ? pack.description : `${pack.description} — ${pack.reason}`}
                </p>
              </div>

              {(() => {
                // Compute the list of missing required env vars and translate
                // them to human labels (from the setup wizard's per-var labels)
                // so a non-developer tooltip is actually useful. Fall back to
                // the raw key name if we don't have a mapping for it.
                const missingVars = pack.requiredEnvVars.filter((k) => {
                  const v = envVars[k] ?? "";
                  return v === "" || v === undefined;
                });
                const labelFor = (key: string): string => {
                  const def = packDef?.vars.find((v) => v.key === key);
                  return def?.label || key;
                };
                const missingLabels = missingVars.map(labelFor);
                const disabledTooltip = missingLabels.length
                  ? `Missing credentials: ${missingLabels.join(", ")} — click to open the configuration form`
                  : "Add credentials before enabling — click to open the configuration form";
                return (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!isConfigured) {
                        // L7: clicking a disabled toggle expands the card to
                        // reveal the credential form instead of silently
                        // swallowing the click.
                        setExpanded(pack.id);
                        return;
                      }
                      togglePack(pack.id, !pack.enabled);
                    }}
                    className={`w-11 h-6 rounded-full transition-colors relative shrink-0 ${
                      pack.enabled
                        ? "bg-accent"
                        : isConfigured
                          ? "bg-bg-muted border border-border"
                          : "bg-bg-muted border border-border opacity-60"
                    }`}
                    title={
                      !isConfigured
                        ? disabledTooltip
                        : pack.enabled
                          ? "Disable connector"
                          : "Enable connector"
                    }
                    aria-label={
                      !isConfigured
                        ? "Toggle disabled — credentials missing. Click to configure."
                        : pack.enabled
                          ? "Disable connector"
                          : "Enable connector"
                    }
                  >
                    <div
                      className={`w-4 h-4 rounded-full bg-white shadow-sm absolute top-1 transition-all ${
                        pack.enabled ? "left-6" : "left-1"
                      }`}
                    />
                  </button>
                );
              })()}
            </div>

            <div
              className={`overflow-hidden transition-all duration-200 ease-out ${
                isOpen ? "max-h-[4000px] opacity-100" : "max-h-0 opacity-0"
              }`}
            >
              {packDef ? (
                <div className="border-t border-border bg-bg px-3 sm:px-5 py-4 space-y-4">
                  {pack.guide ? (
                    <details className="group">
                      <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wide text-text-muted hover:text-text select-none list-none flex items-center gap-1.5">
                        <span className="inline-block transition-transform group-open:rotate-90">
                          ▶
                        </span>
                        Credential guide
                      </summary>
                      <div className="mt-3">
                        <PackGuide markdown={pack.guide} />
                      </div>
                    </details>
                  ) : (
                    <p className="text-xs text-text-muted italic">
                      No guide available yet — see the README for setup instructions.
                    </p>
                  )}
                  {packDef.vars.map((v) => (
                    <div key={v.key}>
                      <div className="flex items-center gap-1.5 mb-1.5">
                        <label className="text-sm font-medium">{v.label}</label>
                        <code className="text-[11px] text-text-muted">{v.key}</code>
                        {v.optional && (
                          <span className="text-[11px] text-text-muted bg-bg-muted px-1.5 py-0.5 rounded">
                            optional
                          </span>
                        )}
                      </div>
                      <CredentialInput
                        v={v}
                        value={getValue(v.key)}
                        onChange={(val) => updateEdit(v.key, val)}
                      />
                    </div>
                  ))}
                  <div className="flex items-center gap-3 pt-2 flex-wrap">
                    <button
                      onClick={() => savePack(pack.id)}
                      disabled={savingId === pack.id || savesDisabled}
                      title={
                        savesDisabled
                          ? storageMode === "static"
                            ? "Static mode — saves disabled. Use the env stub helper below."
                            : "KV unreachable — saves blocked to prevent data loss."
                          : undefined
                      }
                      className="bg-accent text-white text-sm font-medium px-4 py-1.5 rounded-md hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {savingId === pack.id ? "Saving..." : "Save"}
                    </button>
                    <button
                      onClick={() => testPack(pack.id)}
                      disabled={testing === pack.id}
                      className="text-sm font-medium px-4 py-1.5 rounded-md bg-bg-muted hover:bg-border-light text-text-dim hover:text-text disabled:opacity-60"
                    >
                      {testing === pack.id ? "Testing..." : "Test connection"}
                    </button>
                    {test && test.message !== "Testing..." && (
                      <span
                        className={`text-xs font-medium px-2 py-1 rounded-full ${test.ok ? "text-green bg-green-bg" : "text-red bg-red-bg"}`}
                      >
                        {test.ok ? "✓ " : "✗ "}
                        {test.message}
                      </span>
                    )}
                    {savesDisabled && (
                      <span className="text-[11px] text-orange">
                        {storageMode === "static"
                          ? "Static mode (env-vars only)"
                          : `KV unreachable${storageError ? ` — ${storageError}` : ""}`}
                      </span>
                    )}
                  </div>
                  {storageMode === "static" && (
                    <EnvStubBlock
                      packId={pack.id}
                      packLabel={pack.label}
                      vars={packDef.vars.map((v) => {
                        const raw = getValue(v.key);
                        const masked = typeof raw === "string" && raw.includes("\u2022");
                        return {
                          key: v.key,
                          label: v.label,
                          value: masked ? "" : raw,
                          masked,
                          placeholder: `your-${v.key.toLowerCase().replace(/_/g, "-")}`,
                        };
                      })}
                    />
                  )}
                  {saveError[pack.id] && (
                    <div className="bg-red-bg border border-red/20 rounded-md p-3 text-xs text-red">
                      <p className="font-semibold mb-1">Save failed</p>
                      <p className="break-words">{saveError[pack.id]}</p>
                    </div>
                  )}
                  {test && !test.ok && (test.detail || test.message) && (
                    <details className="bg-red-bg border border-red/20 rounded-md p-3 group">
                      <summary className="cursor-pointer text-xs font-semibold text-red select-none list-none flex items-center gap-1.5">
                        <span className="inline-block transition-transform group-open:rotate-90">
                          ▶
                        </span>
                        Show error details
                      </summary>
                      <pre className="mt-2 text-[11px] font-mono text-red break-all whitespace-pre-wrap">
                        {test.detail || test.message}
                      </pre>
                    </details>
                  )}
                  {pack.tools.length > 0 && (
                    <details className="pt-3 border-t border-border group">
                      <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wide text-text-muted hover:text-text select-none list-none flex items-center gap-1.5">
                        <span className="inline-block transition-transform group-open:rotate-90">
                          ▶
                        </span>
                        Tools provided ({pack.tools.length})
                      </summary>
                      <ul className="mt-2 space-y-1.5">
                        {pack.tools.map((t) => (
                          <li key={t.name} className="text-xs">
                            <code className="text-[11px] font-mono text-text">{t.name}</code>
                            {t.deprecated && (
                              <span className="ml-1.5 text-[10px] text-orange bg-orange-bg px-1 rounded">
                                deprecated
                              </span>
                            )}
                            {t.destructive && (
                              <span className="ml-1.5 text-[10px] text-red bg-red-bg px-1 rounded">
                                write
                              </span>
                            )}
                            <span className="text-text-dim ml-2">{t.description}</span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              ) : (
                <div className="border-t border-border bg-bg px-3 sm:px-5 py-4">
                  <p className="text-xs text-text-muted italic">
                    No configuration form registered for this connector.
                  </p>
                </div>
              )}
            </div>
          </div>
        );
      })}
      <ApiConnectionsSection />
    </div>
  );
}

/**
 * Per-connector credential guide.
 *
 * Previously this had its own hand-rolled regex-based markdown renderer
 * (no link-scheme validation, drifting from src/core/markdown-lite.ts).
 * Now delegates to the shared renderer so the security surface is a
 * single audited code path.
 */
function PackGuide({ markdown }: { markdown: string }) {
  return (
    <div className="rounded-md border border-border bg-bg-muted/40 px-4 py-3 space-y-2">
      <div
        className="text-xs text-text-dim leading-relaxed space-y-2"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(markdown) }}
      />
    </div>
  );
}
