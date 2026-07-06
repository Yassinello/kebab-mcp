"use client";

/**
 * Phase 52 / DEV-01 — /config → Devices tab. LOC-budgeted per DEV-06.
 * Each token in MCP_AUTH_TOKEN renders as a row with rotate/revoke/rename.
 * Root-scope gated.
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { DeviceInviteModal } from "./device-invite-modal";
import { DeviceInstallSnippet } from "./device-install-snippet";

interface DeviceRow {
  tokenId: string;
  label: string;
  createdAt: string;
  lastSeenAt: string | null;
  /** v0.20 per-token connector allowlist. null = all connectors (full access). */
  connectors: string[] | null;
}

/** Minimal connector descriptor the scope picker needs. */
export interface ScopeConnector {
  id: string;
  label: string;
  core?: boolean | undefined;
  toolCount?: number | undefined;
}

/**
 * Connectors pre-selected by the "Team scope" preset — the typical
 * delegated set (scraping / outreach) an operator hands to autonomous
 * agents. Filtered against what's actually available before use.
 */
const TEAM_PRESET_IDS = ["apify", "unipile"];

function fmtRelative(iso: string | null): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const d = Date.now() - t;
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

function fmtDate(iso: string): string {
  if (iso === "unknown") return "—";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : "—";
}

function RootOnly({ msg }: { msg: string }) {
  return (
    <div className="rounded-lg border border-border bg-bg-muted p-6">
      <h2 className="text-lg font-semibold">Root admin only</h2>
      <p className="text-sm text-text-dim mt-2">{msg}</p>
    </div>
  );
}

export function DevicesTab({
  tenantId,
  baseUrl,
  connectors = [],
}: {
  tenantId?: string | null | undefined;
  baseUrl?: string | undefined;
  /**
   * All known connectors, used to populate the per-token scope picker.
   * Core connectors are always in scope and hidden from the picker.
   */
  connectors?: ScopeConnector[] | undefined;
}) {
  const isRoot = !tenantId;
  const [rows, setRows] = useState<DeviceRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [rotated, setRotated] = useState<{ label: string; token: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [scopeEditId, setScopeEditId] = useState<string | null>(null);

  // Connectors the operator can pick from (core connectors are always in
  // scope, so they never appear in the picker).
  const pickable = connectors.filter((c) => !c.core);

  const resolvedBaseUrl = baseUrl || (typeof window !== "undefined" ? window.location.origin : "");

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/admin/devices");
      if (res.status === 403) {
        const body = await res.json();
        setError(body.error === "root_only" ? "root_only" : "forbidden");
        return;
      }
      if (!res.ok) return setError(`Failed to load devices (HTTP ${res.status})`);
      const body = await res.json();
      setRows(body.devices || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    }
  }, []);

  useEffect(() => {
    if (isRoot) void load();
  }, [isRoot, load]);

  if (!isRoot) return <RootOnly msg="Device management is restricted to the root operator." />;
  if (error === "root_only")
    return <RootOnly msg="Server returned root-only. Open /config without a tenant header." />;

  const mutate = async (
    init: RequestInit & { url: string },
    ok?: (b: Record<string, unknown>) => void
  ) => {
    const { url, ...rest } = init;
    const res = await fetch(url, rest);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return setError(body.error || `HTTP ${res.status}`);
    ok?.(body);
    await load();
  };

  const startRename = (r: DeviceRow) => {
    setEditingId(r.tokenId);
    setEditValue(r.label === "unnamed" ? "" : r.label);
  };
  const commitRename = async (tokenId: string) => {
    const label = editValue.trim();
    if (!label) return setEditingId(null);
    setBusy(tokenId);
    await mutate({
      url: "/api/admin/devices",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "rename", tokenId, label }),
    });
    setBusy(null);
    setEditingId(null);
  };
  const onRotate = async (r: DeviceRow) => {
    if (!confirm(`Rotate "${r.label}"? Old token stops working immediately.`)) return;
    setBusy(r.tokenId);
    await mutate(
      {
        url: "/api/admin/devices",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "rotate", tokenId: r.tokenId }),
      },
      (body) => {
        if (typeof body.newToken === "string") setRotated({ label: r.label, token: body.newToken });
      }
    );
    setBusy(null);
  };
  const onRevoke = async (r: DeviceRow) => {
    if (!confirm(`Revoke "${r.label}"?`)) return;
    setBusy(r.tokenId);
    await mutate({
      url: `/api/admin/devices?tokenId=${encodeURIComponent(r.tokenId)}`,
      method: "DELETE",
    });
    setBusy(null);
  };
  const saveScope = async (tokenId: string, connectorIds: string[] | null) => {
    setBusy(tokenId);
    await mutate({
      url: "/api/admin/devices",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "set-connectors", tokenId, connectors: connectorIds }),
    });
    setBusy(null);
    setScopeEditId(null);
  };

  const scopeSummary = (r: DeviceRow): string => {
    if (r.connectors === null) return "All connectors";
    if (r.connectors.length === 0) return "None (core only)";
    return `${r.connectors.length} connector${r.connectors.length === 1 ? "" : "s"}`;
  };

  const renderRow = (r: DeviceRow) => (
    <ScopeRowGroup
      key={r.tokenId}
      row={r}
      isEditing={scopeEditId === r.tokenId}
      pickable={pickable}
      busy={busy === r.tokenId}
      onSave={saveScope}
      onCancel={() => setScopeEditId(null)}
    >
      {renderMainRow(r)}
    </ScopeRowGroup>
  );

  const renderMainRow = (r: DeviceRow) => (
    <tr className="border-t border-border">
      <td className="px-3 py-2">
        {editingId === r.tokenId ? (
          <input
            autoFocus
            value={editValue}
            maxLength={40}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commitRename(r.tokenId);
              if (e.key === "Escape") setEditingId(null);
            }}
            onBlur={() => void commitRename(r.tokenId)}
            className="px-2 py-1 bg-bg-muted border border-border rounded text-xs w-40"
          />
        ) : (
          <button type="button" onClick={() => startRename(r)} className="hover:underline">
            {r.label}
          </button>
        )}
      </td>
      <td className="px-3 py-2 font-mono text-[11px] text-text-dim">{r.tokenId}</td>
      <td className="px-3 py-2">
        <button
          type="button"
          onClick={() => setScopeEditId(scopeEditId === r.tokenId ? null : r.tokenId)}
          className="hover:underline text-left"
          title="Scope this token to a subset of connectors"
        >
          {scopeSummary(r)}
        </button>
      </td>
      <td className="px-3 py-2">{fmtRelative(r.lastSeenAt)}</td>
      <td className="px-3 py-2">{fmtDate(r.createdAt)}</td>
      <td className="px-3 py-2 text-right whitespace-nowrap">
        <button
          type="button"
          disabled={busy === r.tokenId}
          onClick={() => void onRotate(r)}
          className="px-2 py-1 text-[11px] mr-1 rounded border border-border hover:bg-bg-muted"
        >
          Rotate
        </button>
        <button
          type="button"
          disabled={busy === r.tokenId}
          onClick={() => void onRevoke(r)}
          className="px-2 py-1 text-[11px] rounded border border-red-800 text-red-400 hover:bg-red-950/40"
        >
          Revoke
        </button>
      </td>
    </tr>
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-text-dim">
          Each row is a token in <code className="text-xs">MCP_AUTH_TOKEN</code>. Add, rotate,
          revoke, or scope a token to a subset of connectors — without hand-editing env vars.
        </p>
        <button
          type="button"
          onClick={() => setInviteOpen(true)}
          className="px-3 py-1.5 text-xs rounded bg-accent text-white hover:bg-accent/90"
        >
          + Add device
        </button>
      </div>
      {error && error !== "root_only" && (
        <div className="mb-3 rounded border border-red-800 bg-red-950/40 text-red-300 px-3 py-2 text-xs">
          {error}
        </div>
      )}
      {!rows && !error && <p className="text-xs text-text-muted">Loading devices…</p>}
      {rows && rows.length === 0 && (
        <div className="rounded border border-border bg-bg-muted p-6 text-sm text-text-dim">
          No devices yet. Run the welcome flow, then use <strong>Add device</strong> to invite more.
        </div>
      )}
      {rows && rows.length > 0 && (
        <div className="border border-border rounded overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-bg-muted text-text-dim">
              <tr>
                <th className="text-left px-3 py-2 font-medium">Label</th>
                <th className="text-left px-3 py-2 font-medium">Token ID</th>
                <th className="text-left px-3 py-2 font-medium">Scope</th>
                <th className="text-left px-3 py-2 font-medium">Last seen</th>
                <th className="text-left px-3 py-2 font-medium">Created</th>
                <th className="text-right px-3 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>{rows.map(renderRow)}</tbody>
          </table>
        </div>
      )}
      {inviteOpen && (
        <DeviceInviteModal
          baseUrl={resolvedBaseUrl}
          onClose={() => {
            setInviteOpen(false);
            // fire-and-forget OK: UI refresh after invite modal close
            void load();
          }}
        />
      )}
      {rotated && (
        <DeviceInstallSnippet
          label={rotated.label}
          token={rotated.token}
          baseUrl={resolvedBaseUrl}
          onClose={() => setRotated(null)}
        />
      )}
    </div>
  );
}

/**
 * Wraps a device's main row and, when `isEditing`, renders an inline
 * connector-scope picker row beneath it. "All connectors" clears the scope
 * (null); otherwise the checked subset is saved as the token's allowlist.
 * Core connectors are always in scope and never shown here.
 */
function ScopeRowGroup({
  row,
  isEditing,
  pickable,
  busy,
  onSave,
  onCancel,
  children,
}: {
  row: DeviceRow;
  isEditing: boolean;
  pickable: ScopeConnector[];
  busy: boolean;
  onSave: (tokenId: string, connectors: string[] | null) => void | Promise<void>;
  onCancel: () => void;
  children: ReactNode;
}) {
  // Local draft: "all" = full access (null); "subset" = the checked set.
  const [mode, setMode] = useState<"all" | "subset">(row.connectors === null ? "all" : "subset");
  const [selected, setSelected] = useState<Set<string>>(new Set(row.connectors ?? []));

  // Preset ids that actually exist in the current connector set (a preset
  // for a connector that isn't configured would be a dead checkbox).
  const pickableIds = new Set(pickable.map((c) => c.id));
  const teamPresetIds = TEAM_PRESET_IDS.filter((id) => pickableIds.has(id));

  // Re-sync the draft whenever the picker (re)opens for this row.
  useEffect(() => {
    if (isEditing) {
      setMode(row.connectors === null ? "all" : "subset");
      setSelected(new Set(row.connectors ?? []));
    }
  }, [isEditing, row.connectors]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const save = () => {
    if (mode === "all") return void onSave(row.tokenId, null);
    return void onSave(row.tokenId, Array.from(selected));
  };

  return (
    <>
      {children}
      {isEditing && (
        <tr className="border-t border-border bg-bg-muted/40">
          <td colSpan={6} className="px-3 py-3">
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-4 text-xs">
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name={`scope-${row.tokenId}`}
                    checked={mode === "all"}
                    onChange={() => setMode("all")}
                  />
                  All connectors (full access)
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name={`scope-${row.tokenId}`}
                    checked={mode === "subset"}
                    onChange={() => setMode("subset")}
                  />
                  Only selected connectors
                </label>
              </div>
              {mode === "subset" && (
                <>
                  {teamPresetIds.length > 0 && (
                    <div className="flex items-center gap-2 text-[11px]">
                      <span className="text-text-muted">Quick preset:</span>
                      <button
                        type="button"
                        onClick={() => setSelected(new Set(teamPresetIds))}
                        className="px-2 py-0.5 rounded border border-border hover:bg-bg-muted"
                        title="Select the typical team connectors (scraping / outreach)"
                      >
                        Team scope ({teamPresetIds.length})
                      </button>
                    </div>
                  )}
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                    {pickable.length === 0 && (
                      <p className="text-[11px] text-text-muted col-span-full">
                        No configurable connectors available.
                      </p>
                    )}
                    {pickable.map((c) => (
                      <label
                        key={c.id}
                        className="flex items-center gap-1.5 text-[11px] cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={selected.has(c.id)}
                          onChange={() => toggle(c.id)}
                        />
                        <span>
                          {c.label}
                          {typeof c.toolCount === "number" && (
                            <span className="text-text-muted"> ({c.toolCount})</span>
                          )}
                        </span>
                      </label>
                    ))}
                  </div>
                </>
              )}
              <p className="text-[11px] text-text-muted">
                Core tools (admin, skills) are always available and not listed here.
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={save}
                  className="px-2.5 py-1 text-[11px] rounded bg-accent text-white hover:bg-accent/90 disabled:opacity-50"
                >
                  Save scope
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={onCancel}
                  className="px-2.5 py-1 text-[11px] rounded border border-border hover:bg-bg-muted"
                >
                  Cancel
                </button>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
