"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { ConnectorSummary } from "../tabs";
import { PACKS, CredentialInput, normalizeGitHubRepo } from "../pack-defs";
import { renderMarkdown } from "@/core/markdown-lite";
import { EnvStubBlock } from "./env-stub-block";
import { ApiConnectionsSection } from "./api-connections-section";
import { LinkedinConnectButton } from "./linkedin-connect-button";
import { VaultBackendPanel } from "./vault-backend-panel";
import { UnipileAccountSelector } from "./unipile-account-selector";
import { MultiAccountSelector } from "./multi-account-selector";
import { OutlineIcon } from "../../components/outline-icon";
import { UnderlineTabs, TabPanel, useSubTab } from "../../components/page-tabs";
import { ListSection, RowChevron, RowList, RowMeta, StatusDot } from "../../components/list-rows";

type StorageMode = "kv" | "file" | "static" | "kv-degraded" | null;

/**
 * Packs that never get a card here: api-connections is managed by
 * <ApiConnectionsSection /> below (a placeholder card made users wonder
 * which surface was authoritative). Core packs are hidden too.
 */
const HIDDEN_PACK_IDS = new Set(["api-connections"]);

/** How long a card stays highlighted after a deep link. */
const DEEP_LINK_HIGHLIGHT_MS = 2500;

type ConnectorStatus = "active" | "setup" | "off";

/**
 * Active = turned on; Needs setup = credentials missing; Off = set up but
 * turned off (or blocked for another reason, shown in the row details).
 */
function connectorStatus(c: ConnectorSummary): ConnectorStatus {
  if (c.enabled) return "active";
  return c.reason.startsWith("missing env") ? "setup" : "off";
}

const STATUS_LABEL: Record<ConnectorStatus, string> = {
  active: "Active",
  setup: "Needs setup",
  off: "Off",
};

const VIEWS = ["all", "active", "setup"] as const;
type ConnectorView = (typeof VIEWS)[number];

const VIEW_COPY: Record<ConnectorView, { title: string; text: string; empty: string }> = {
  all: {
    title: "Connectors",
    text: "The services your AI clients can use. Open a row to add credentials, test it or read what it does.",
    empty: "No connector is available on this instance.",
  },
  active: {
    title: "Active connectors",
    text: "Turned on: their tools are available to every connected AI client.",
    empty: "No connector is on yet. Pick one under Needs setup.",
  },
  setup: {
    title: "Connectors that need setup",
    text: "Add their credentials to turn them on. Your AI client can also send you here during setup.",
    empty: "Nothing to set up: every connector has its credentials.",
  },
};

/** Outline icon per connector; generic package icon otherwise. */
const CONNECTOR_ICONS: Record<string, string> = {
  google: "mail",
  gmail: "mail",
  slack: "chat",
  notion: "file",
  vault: "notebook",
  github: "github",
  linear: "layers",
  airtable: "database",
  browser: "globe",
  paywall: "globe",
  webhook: "webhook",
  apify: "search",
  unipile: "chat",
  composio: "link",
  calendar: "calendar",
  "custom-tools": "wand",
};

function connectorIcon(id: string): string {
  return CONNECTOR_ICONS[id] ?? "package";
}

export function ConnectorsTab({ connectors }: { connectors: ConnectorSummary[] }) {
  const router = useRouter();
  // Contract 1: /config?tab=connectors&connector=<packId> (links sent by the
  // AI client during setup) scrolls to that card, highlights it and opens
  // its credential form. An unknown id leaves the tab as usual.
  const deepLinkId = useSearchParams()?.get("connector") ?? null;
  // Redesign 2026-11: All · Active · Needs setup. A connector deep link
  // always lands on "All" so the row is there to open.
  const [view, setView] = useSubTab<ConnectorView>(VIEWS, "all", {
    initial: deepLinkId ? "all" : null,
    clear: ["connector"],
  });
  const [arrivedId, setArrivedId] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const deepLinkHandled = useRef(false);
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
  // Tracks the last successfully saved pack so we can detect when the
  // RSC refresh brings back `enabled: true` and collapse / celebrate the
  // card. User-reported 2026-04-29: after saving Browser/Paywall the
  // toggle stayed off and the card stayed open with no visible
  // confirmation that anything had landed. The id is cleared by the
  // post-save effect once we've reacted to the freshly-gated state.
  const [recentlySavedId, setRecentlySavedId] = useState<string | null>(null);

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

  // Post-save reactivity: when the RSC refresh brings back the freshly-
  // gated connector list, collapse the card we just saved and surface a
  // clear "Connected" toast for 4s. If the connector did NOT flip to
  // enabled (creds saved but custom-active predicate still rejects, e.g.
  // paywall with both MEDIUM_SID and SUBSTACK_SID empty), keep the card
  // open and surface a hint instead of leaving the user wondering.
  useEffect(() => {
    if (!recentlySavedId) return;
    const pack = connectors.find((c) => c.id === recentlySavedId);
    if (!pack) return;
    if (pack.enabled) {
      // Connector flipped on — collapse + clear any prior error.
      setExpanded((cur) => (cur === recentlySavedId ? null : cur));
      setSaveError((p) => ({ ...p, [recentlySavedId]: "" }));
    } else if (!pack.reason.startsWith("missing env")) {
      // Creds saved but the custom-active predicate or another reason still
      // blocks. Surface that reason inline so the user knows why the toggle
      // stayed off (paywall: needs at least one source cookie; webhook:
      // needs MYMCP_WEBHOOKS list, etc.).
      setSaveError((p) => ({
        ...p,
        [recentlySavedId]: `Saved, but the connector is still inactive: ${pack.reason}`,
      }));
    } else {
      // Still missing required vars — happens when the user partially
      // filled the form (e.g. only 1 of 3 Browser keys). Tell them
      // exactly which.
      setSaveError((p) => ({
        ...p,
        [recentlySavedId]: `Saved, but more credentials are needed: ${pack.reason}`,
      }));
    }
    setRecentlySavedId(null);
  }, [connectors, recentlySavedId]);

  useEffect(() => {
    if (loading || deepLinkHandled.current || !deepLinkId) return;
    deepLinkHandled.current = true;
    const pack = connectors.find(
      (c) => c.id === deepLinkId && !c.core && !HIDDEN_PACK_IDS.has(c.id)
    );
    if (!pack) return;
    if (PACKS.some((d) => d.id === pack.id)) setExpanded(pack.id);
    setArrivedId(pack.id);
    setHighlightId(pack.id);
  }, [loading, deepLinkId, connectors]);

  // Scroll once the card is rendered (and opened), after the deep link.
  useEffect(() => {
    if (!arrivedId) return;
    document
      .getElementById(`connector-${arrivedId}`)
      ?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }, [arrivedId]);

  // The highlight is brief; the "say done" note stays.
  useEffect(() => {
    if (!highlightId) return;
    const t = setTimeout(() => setHighlightId(null), DEEP_LINK_HIGHLIGHT_MS);
    return () => clearTimeout(t);
  }, [highlightId]);

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
    if (!packDef) {
      setSavingId(null);
      return;
    }
    const vars: Record<string, string> = {};
    for (const v of packDef.vars) {
      const edited = edits[v.key];
      if (edited !== undefined && edited !== "" && !edited.includes("\u2022")) {
        vars[v.key] = v.key === "GITHUB_REPO" ? normalizeGitHubRepo(edited) : edited;
      }
    }
    if (Object.keys(vars).length === 0) {
      // Silent-return bug (user-reported 2026-04-29): the card already
      // shows masked bullets for every saved value, so the user re-clicks
      // Save expecting it to "commit" or re-validate. We had no edits to
      // submit, returned without feedback, and the toggle stayed off —
      // making the save button feel broken. Surface explicit feedback so
      // the user knows nothing was sent and why.
      const pack = visibleConnectors.find((c) => c.id === packId);
      const alreadyConfigured = pack?.enabled || (pack && !pack.reason.startsWith("missing env"));
      setSaveError((p) => ({
        ...p,
        [packId]: alreadyConfigured
          ? "No changes to save — credentials are already saved. Edit a field above to update."
          : "Fill in at least one credential field before saving.",
      }));
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
        // 5s instead of 3s — the 3s window was easy to miss (user reported
        // 2026-04-29 they saw "no feedback at all" after Save). 5s is long
        // enough to register but short enough that it doesn't linger
        // through the next save.
        setTimeout(() => {
          setSavedFlash(null);
          setSavedBackend(null);
        }, 5000);
        // After a successful save, the server-side registry will see the
        // new env vars and flip `enabled: true` for connectors whose
        // required vars are now all present. The client still holds the
        // pre-save server snapshot, so the toggle would still show OFF
        // and the "Setup needed" badge would persist until the next page
        // load. Use Next's RSC refresh so the segment re-renders against
        // the freshly-gated registry while the existing DOM stays mounted
        // (no white "Loading connectors..." flash — Bug B, 2026-04-28).
        // Skipped in ephemeral mode (no point refreshing — the var won't
        // survive the next cold start anyway and the user has bigger
        // problems to read in the amber banner).
        if (!data.ephemeral) {
          // Mark this pack as "just saved" so the post-refresh effect
          // can react to the freshly-gated state (collapse if active,
          // surface inactive reason if not).
          setRecentlySavedId(packId);
          setTimeout(() => {
            router.refresh();
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
        // Re-fetch registry state via RSC refresh — keeps the existing
        // DOM mounted while the server segment re-renders with the
        // freshly-gated connector list (Bug B, 2026-04-28).
        router.refresh();
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
  const visibleConnectors = connectors.filter((c) => !c.core && !HIDDEN_PACK_IDS.has(c.id));
  const counts = { all: visibleConnectors.length, active: 0, setup: 0 };
  for (const c of visibleConnectors) {
    const status = connectorStatus(c);
    if (status === "active") counts.active++;
    if (status === "setup") counts.setup++;
  }
  const shown =
    view === "all"
      ? visibleConnectors
      : visibleConnectors.filter((c) => connectorStatus(c) === view);
  const section = VIEW_COPY[view];

  return (
    <div>
      <UnderlineTabs
        label="Connector filters"
        idBase="connectors"
        value={view}
        onChange={setView}
        tabs={[
          { id: "all", label: "All", count: counts.all },
          { id: "active", label: "Active", count: counts.active },
          { id: "setup", label: "Needs setup", count: counts.setup },
        ]}
      />
      <TabPanel idBase="connectors" value={view}>
        {/* Ephemeral /tmp warning — saves succeed server-side but vanish on
          cold start. Not a "disabled" state (button still works) but a
          prominent caution so users on Vercel without Upstash know what
          they're in for. Goes away automatically once Upstash is set up. */}
        {storageMode === "file" && storageEphemeral && (
          <div className="mb-6 border border-orange/40 rounded-lg p-4 bg-orange-bg/40">
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

        <ListSection id="connectors-list-title" title={section.title} description={section.text}>
          {shown.length === 0 ? (
            <p className="border-t border-border py-8 text-sm text-text-dim">{section.empty}</p>
          ) : (
            <RowList>
              {shown.map((pack) => {
                const packDef = PACKS.find((p) => p.id === pack.id);
                const isOpen = expanded === pack.id;
                const test = testResults[pack.id];
                const status = connectorStatus(pack);
                // "Configured" = active, or inactive for a reason other than missing env vars.
                // A connector that's missing creds should be treated as not-yet-configured
                // so the toggle acts as a "Setup" affordance instead of a silent no-op.
                const isConfigured = status !== "setup";
                const detailsId = `connector-${pack.id}-details`;

                // Phase 76: slack/notion are configured through the multi-account
                // selector (the primary path) rather than a single legacy token
                // field — but only when the KV-backed account store is available.
                // In static mode the store is unreachable, so we fall back to the
                // legacy fields + EnvStubBlock.
                const useMultiAccountUI =
                  (pack.id === "slack" || pack.id === "notion" || pack.id === "google") &&
                  storageMode !== "static";

                const toggleRow = () => {
                  setExpanded(isOpen ? null : pack.id);
                };

                // Missing required env vars, as the setup wizard's labels, for
                // the toggle's tooltip. Falls back to the raw key name.
                const missingLabels = pack.requiredEnvVars
                  .filter((k) => (envVars[k] ?? "") === "")
                  .map((key) => packDef?.vars.find((v) => v.key === key)?.label || key);
                const disabledTooltip = missingLabels.length
                  ? `Missing credentials: ${missingLabels.join(", ")} — click to open the configuration form`
                  : "Add credentials before enabling — click to open the configuration form";

                return (
                  <li
                    key={pack.id}
                    id={`connector-${pack.id}`}
                    data-highlighted={highlightId === pack.id ? "true" : undefined}
                    className={`border-b border-border scroll-mt-24 transition-colors duration-500 ${
                      highlightId === pack.id
                        ? "bg-accent/5 ring-2 ring-inset ring-accent/40 rounded-lg"
                        : ""
                    }`}
                  >
                    <div
                      onClick={toggleRow}
                      className="flex flex-wrap items-center gap-x-4 gap-y-2 px-1 sm:px-2 py-4 cursor-pointer"
                    >
                      <span className="text-text-dim shrink-0 self-start mt-0.5">
                        <OutlineIcon name={connectorIcon(pack.id)} size={20} />
                      </span>
                      <div className="flex-1 min-w-[11rem]">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          <p className="text-[15px] font-medium text-text">{pack.label}</p>
                          <StatusDot
                            tone={status === "active" ? "ok" : status === "setup" ? "warn" : "off"}
                            label={STATUS_LABEL[status]}
                          />
                          {savedFlash === pack.id && (
                            <span
                              role="status"
                              className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${
                                storageEphemeral
                                  ? "text-orange bg-orange-bg"
                                  : "text-green bg-green-bg"
                              }`}
                            >
                              {savedBackend || "Saved"}
                            </span>
                          )}
                        </div>
                        <p className="text-[13px] text-text-dim mt-0.5 line-clamp-2 md:line-clamp-none md:truncate">
                          {pack.description}
                        </p>
                      </div>
                      <div className="ml-auto flex items-center gap-3 sm:gap-4 shrink-0">
                        {/* Tool count: only meaningful when the pack is actually
                            contributing tools to the registry. */}
                        {pack.enabled && <RowMeta>{pack.toolCount} tools</RowMeta>}
                        <button
                          type="button"
                          role="switch"
                          aria-checked={pack.enabled}
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
                          className={`w-11 h-6 rounded-full transition-colors relative shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                            pack.enabled
                              ? "bg-accent"
                              : isConfigured
                                ? "bg-border"
                                : "bg-border-light border border-border"
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
                          <span
                            className={`w-4 h-4 rounded-full bg-white shadow-sm absolute top-1 transition-all ${
                              pack.enabled ? "left-6" : "left-1"
                            }`}
                          />
                        </button>
                        <RowChevron
                          open={isOpen}
                          onClick={toggleRow}
                          label={pack.label}
                          controls={detailsId}
                        />
                      </div>
                    </div>

                    {arrivedId === pack.id && (
                      <p
                        role="note"
                        className="mx-1 sm:ml-11 sm:mr-2 mb-3 rounded-md bg-accent/5 border border-accent/20 px-3 py-2 text-xs text-text"
                      >
                        When you&rsquo;re done, go back to your AI conversation and say
                        &ldquo;done&rdquo;.
                      </p>
                    )}

                    <div
                      id={detailsId}
                      inert={!isOpen}
                      className={`overflow-hidden transition-all duration-200 ease-out ${
                        isOpen ? "max-h-[4000px] opacity-100" : "max-h-0 opacity-0"
                      }`}
                    >
                      <div className="pl-1 sm:pl-11 pr-1 sm:pr-2 pb-6 space-y-4">
                        {!pack.enabled && pack.reason && (
                          <p className="text-xs text-text-dim">
                            <span className="font-medium text-text">Why it is off:</span>{" "}
                            {pack.reason}
                          </p>
                        )}
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
                        {packDef ? (
                          <>
                            {/* Phase 76: Slack/Notion are configured via the
                        multi-account selector below (the primary path), so we
                        hide the legacy single-token field + Save/Test. The
                        exception is static mode, where the multi-account store
                        (KV-only) is unavailable — there we keep the legacy
                        fields + EnvStubBlock as the only way to configure. */}
                            {!useMultiAccountUI && (
                              <>
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
                              </>
                            )}
                            {pack.id === "vault" && pack.enabled && isOpen && <VaultBackendPanel />}
                            {pack.id === "browser" && pack.enabled && (
                              <LinkedinConnectButton
                                currentContextId={getValue("BROWSERBASE_CONTEXT_LINKEDIN")}
                                onSaved={(id) => {
                                  setEnvVars((p) => ({ ...p, BROWSERBASE_CONTEXT_LINKEDIN: id }));
                                }}
                              />
                            )}
                            {pack.id === "unipile" && pack.enabled && (
                              <UnipileAccountSelector
                                values={{
                                  UNIPILE_LINKEDIN_ACCOUNT_ID: getValue(
                                    "UNIPILE_LINKEDIN_ACCOUNT_ID"
                                  ),
                                  UNIPILE_WHATSAPP_ACCOUNT_ID: getValue(
                                    "UNIPILE_WHATSAPP_ACCOUNT_ID"
                                  ),
                                }}
                                onSaved={(key, value) => {
                                  setEnvVars((p) => ({ ...p, [key]: value }));
                                }}
                              />
                            )}
                            {/* Phase 76: multi-account selector is the PRIMARY config
                        path for slack/notion — shown even on a disabled card so
                        the first account can be connected here (adding it gates
                        the connector active). KV-only, so suppressed in static
                        mode (legacy fields + EnvStubBlock handle that case). */}
                            {useMultiAccountUI &&
                              (pack.id === "slack" ||
                                pack.id === "notion" ||
                                pack.id === "google") && (
                                <MultiAccountSelector
                                  connector={pack.id}
                                  onAccountsChanged={() => router.refresh()}
                                />
                              )}
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
                            {saveError[pack.id] &&
                              (() => {
                                // Differentiate informational messages (no-op save,
                                // partial config, custom-active still inactive) from
                                // hard failures. The post-save effect surfaces benign
                                // hints through the same channel; rendering them in
                                // red with "Save failed" headline would mislead the
                                // user into thinking something broke.
                                const msg = saveError[pack.id] || "";
                                const isBenign =
                                  msg.startsWith("No changes to save") ||
                                  msg.startsWith("Fill in at least one") ||
                                  msg.startsWith("Saved, but");
                                return (
                                  <div
                                    className={
                                      isBenign
                                        ? "bg-bg-muted border border-border rounded-md p-3 text-xs text-text-dim"
                                        : "bg-red-bg border border-red/20 rounded-md p-3 text-xs text-red"
                                    }
                                  >
                                    <p className="font-semibold mb-1">
                                      {isBenign ? "Heads up" : "Save failed"}
                                    </p>
                                    <p className="break-words">{msg}</p>
                                  </div>
                                );
                              })()}
                            {test &&
                              !test.ok &&
                              test.message !== "Testing..." &&
                              (test.detail || test.message) && (
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
                          </>
                        ) : (
                          <p className="text-xs text-text-muted italic">
                            No credential form needed for this connector — the guide above covers
                            all the setup it needs.
                          </p>
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
                    </div>
                  </li>
                );
              })}
            </RowList>
          )}
        </ListSection>
        {view === "all" && <ApiConnectionsSection />}
      </TabPanel>
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
