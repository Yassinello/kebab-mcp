"use client";

/**
 * Phase 52 / DEV-01 — /config → Devices tab. LOC-budgeted per DEV-06.
 * Each token in MCP_AUTH_TOKEN renders as a row with rotate/revoke/rename.
 * Root-scope gated.
 */

import { useCallback, useEffect, useState } from "react";
import { DeviceInviteModal } from "./device-invite-modal";
import { DeviceInstallSnippet } from "./device-install-snippet";

interface DeviceRow {
  tokenId: string;
  label: string;
  createdAt: string;
  lastSeenAt: string | null;
}

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
}: {
  tenantId?: string | null | undefined;
  baseUrl?: string | undefined;
}) {
  const isRoot = !tenantId;
  const [rows, setRows] = useState<DeviceRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [rotated, setRotated] = useState<{ label: string; token: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

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

  const renderRow = (r: DeviceRow) => (
    <tr key={r.tokenId} className="border-t border-border">
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
          Each row is a token in <code className="text-xs">MCP_AUTH_TOKEN</code>. Add, rotate, or
          revoke without hand-editing env vars.
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
