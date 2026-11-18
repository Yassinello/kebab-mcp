"use client";

/**
 * Phase 52 / DEV-01 — /config → Devices tab. LOC-budgeted per DEV-06.
 * Each token in MCP_AUTH_TOKEN renders as a row with rotate/revoke/rename.
 * Root-scope gated.
 */

import { useCallback, useEffect, useState } from "react";
import { OutlineIcon } from "../../components/outline-icon";
import {
  ListSection,
  RowChevron,
  RowList,
  RowMeta,
  StatusDot,
  type RowTone,
} from "../../components/list-rows";
import { DeviceInviteModal } from "./device-invite-modal";
import { DeviceInstallSnippet } from "./device-install-snippet";

interface DeviceRow {
  tokenId: string;
  label: string;
  createdAt: string;
  lastSeenAt: string | null;
  /** v0.20 per-token connector allowlist. null = all connectors (full access). */
  connectors: string[] | null;
  /** Skills v2 — skill tag scope. null = every skill. */
  skillTags?: string[] | null;
  /** Kebab House — profile served by my_context. null = default. */
  profile?: string | null;
  /** Audit 2026-11 — what the device may do with tools that change things. */
  access?: "read" | "memory" | "full";
  /** Signed-in app (OAuth) or a device key created here. */
  kind?: "token" | "oauth";
}

const SMALL_BTN =
  "px-3 py-1.5 text-[13px] font-medium rounded-lg border border-border bg-bg text-text-dim hover:bg-bg-muted hover:text-text disabled:opacity-50";

/** Seen in the last 30 days = Active; never = Not seen yet; else Idle. */
function deviceStatus(r: { lastSeenAt: string | null }): { tone: RowTone; label: string } {
  if (!r.lastSeenAt) return { tone: "off", label: "Not seen yet" };
  const t = Date.parse(r.lastSeenAt);
  if (Number.isFinite(t) && Date.now() - t < 30 * 86_400_000)
    return { tone: "ok", label: "Active" };
  return { tone: "off", label: "Idle" };
}

/** Short scope for the row's right side. */
function scopeShort(r: { connectors: string[] | null; skillTags?: string[] | null }): string {
  if (r.connectors === null) return r.skillTags ? "All connectors · some skills" : "All connectors";
  if (r.connectors.length === 0) return "Skills only";
  return `${r.connectors.length} connector${r.connectors.length === 1 ? "" : "s"}`;
}

/** Audit 2026-11 — access levels, as the owner reads them. */
const ACCESS_OPTIONS: { value: "read" | "memory" | "full"; label: string }[] = [
  { value: "read", label: "Read only" },
  { value: "memory", label: "Read + profile and notes" },
  { value: "full", label: "Everything" },
];

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

  // Connectors the operator can pick from. Scope-exempt core connectors
  // (skills) are always in scope, so they never appear in the picker.
  // SEC-03: `admin` is core but must be granted explicitly to a scoped token.
  const pickable = connectors.filter((c) => !c.core || c.id === "admin");

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
  const saveScope = async (
    tokenId: string,
    connectorIds: string[] | null,
    skillTags: string[] | null,
    profile: string | null
  ) => {
    setBusy(tokenId);
    await mutate({
      url: "/api/admin/devices",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "set-connectors", tokenId, connectors: connectorIds }),
    });
    await mutate({
      url: "/api/admin/devices",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "set-skill-tags", tokenId, skillTags }),
    });
    await mutate({
      url: "/api/admin/devices",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "set-profile", tokenId, profile }),
    });
    setBusy(null);
    setScopeEditId(null);
  };

  const saveAccess = async (tokenId: string, access: string) => {
    setBusy(tokenId);
    await mutate({
      url: "/api/admin/devices",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "set-access", tokenId, access }),
    });
    setBusy(null);
  };

  const scopeSummary = (r: DeviceRow): string => {
    const conn =
      r.connectors === null
        ? "All connectors"
        : r.connectors.length === 0
          ? "None (skills only)"
          : `${r.connectors.length} connector${r.connectors.length === 1 ? "" : "s"}`;
    const tags = r.skillTags;
    const prof = r.profile ? ` · profile: ${r.profile}` : "";
    if (!tags) return `${conn}${prof}`;
    return `${conn} · skills: ${tags.length ? tags.map((t) => `#${t}`).join(" ") : "none"}${prof}`;
  };

  const renderRow = (r: DeviceRow) => {
    const open = scopeEditId === r.tokenId;
    const status = deviceStatus(r);
    const detailsId = `device-${r.tokenId}-details`;
    const toggle = () => setScopeEditId(open ? null : r.tokenId);
    return (
      <li key={r.tokenId} className="border-b border-border">
        <div
          onClick={toggle}
          className="flex flex-wrap items-center gap-x-4 gap-y-2 px-1 sm:px-2 py-4 cursor-pointer"
        >
          <span className="text-text-dim shrink-0 self-start mt-0.5">
            <OutlineIcon name={r.kind === "oauth" ? "plug" : "devices"} size={20} />
          </span>
          <div className="flex-1 min-w-[11rem]">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {editingId === r.tokenId ? (
                <input
                  autoFocus
                  aria-label={`New name for ${r.label}`}
                  value={editValue}
                  maxLength={40}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void commitRename(r.tokenId);
                    if (e.key === "Escape") setEditingId(null);
                  }}
                  onBlur={() => void commitRename(r.tokenId)}
                  className="px-2 py-1 bg-bg border border-border rounded-md text-sm w-48"
                />
              ) : (
                <p className="text-[15px] font-medium text-text">{r.label}</p>
              )}
              <StatusDot tone={status.tone} label={status.label} />
            </div>
            <p className="text-[13px] text-text-dim mt-0.5">
              {r.kind === "oauth" ? "Signed in" : "Device key"}{" "}
              <code className="font-mono text-[12px]">{r.tokenId}</code> · last seen{" "}
              {fmtRelative(r.lastSeenAt)}
              {fmtDate(r.createdAt) !== "—" && ` · added ${fmtDate(r.createdAt)}`}
            </p>
          </div>
          <div
            className="ml-auto flex items-center gap-3 shrink-0"
            onClick={(e) => e.stopPropagation()}
            role="presentation"
          >
            <RowMeta>{scopeShort(r)}</RowMeta>
            <select
              aria-label={`What ${r.label} can do`}
              title="What this device can do"
              value={r.access ?? "full"}
              disabled={busy === r.tokenId}
              onChange={(e) => void saveAccess(r.tokenId, e.target.value)}
              className="bg-bg border border-border rounded-lg px-2 py-1 text-[13px] text-text"
            >
              {ACCESS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <RowChevron open={open} onClick={toggle} label={r.label} controls={detailsId} />
          </div>
        </div>
        {open && (
          <div id={detailsId} className="pl-1 sm:pl-11 pr-1 sm:pr-2 pb-6 space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] text-text-dim mr-2">{scopeSummary(r)}</span>
              <button
                type="button"
                disabled={busy === r.tokenId}
                onClick={() => startRename(r)}
                className={SMALL_BTN}
              >
                Rename
              </button>
              <button
                type="button"
                disabled={busy === r.tokenId}
                onClick={() => void onRotate(r)}
                className={SMALL_BTN}
              >
                Rotate
              </button>
              <button
                type="button"
                disabled={busy === r.tokenId}
                onClick={() => void onRevoke(r)}
                className="px-3 py-1.5 text-[13px] font-medium rounded-lg border border-red/30 text-red hover:bg-red-bg disabled:opacity-50"
              >
                Revoke
              </button>
            </div>
            <ScopeEditor
              row={r}
              isEditing={open}
              pickable={pickable}
              busy={busy === r.tokenId}
              onSave={saveScope}
              onCancel={() => setScopeEditId(null)}
            />
          </div>
        )}
      </li>
    );
  };

  return (
    <div>
      <ListSection
        id="devices-title"
        title="AI clients and devices"
        description="The ones that signed in (Claude, ChatGPT, Cursor…) and the device keys you created. Open a row to choose what it sees, rename, rotate or revoke it."
        actions={
          <button
            type="button"
            onClick={() => setInviteOpen(true)}
            className="px-3 py-1.5 text-sm font-medium rounded-lg bg-accent text-white hover:bg-accent/90 whitespace-nowrap"
          >
            + Add device
          </button>
        }
      >
        {error && error !== "root_only" && (
          <div
            role="alert"
            className="mb-3 rounded-lg border border-red/20 bg-red-bg text-red px-3 py-2 text-xs"
          >
            {error}
          </div>
        )}
        {!rows && !error && <p className="text-sm text-text-muted">Loading devices…</p>}
        {rows && rows.length === 0 && (
          <p className="border-t border-b border-border py-8 text-sm text-text-dim">
            No AI client yet. Connect one from your client (Claude: Settings → Connectors → Add
            custom connector, with your Kebab House URL), or use <strong>Add device</strong> to
            create a key for a client that cannot sign in.
          </p>
        )}
        {rows && rows.length > 0 && <RowList>{rows.map(renderRow)}</RowList>}
      </ListSection>
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
 * Inline editor shown in an open device row: connector scope ("All
 * connectors" clears it to null; otherwise the checked subset is saved as
 * the token's allowlist), skill tags and profile. Core connectors are
 * always in scope and never shown here.
 */
function ScopeEditor({
  row,
  isEditing,
  pickable,
  busy,
  onSave,
  onCancel,
}: {
  row: DeviceRow;
  isEditing: boolean;
  pickable: ScopeConnector[];
  busy: boolean;
  onSave: (
    tokenId: string,
    connectors: string[] | null,
    skillTags: string[] | null,
    profile: string | null
  ) => void | Promise<void>;
  onCancel: () => void;
}) {
  // Local draft: "all" = full access (null); "subset" = the checked set.
  const [mode, setMode] = useState<"all" | "subset">(row.connectors === null ? "all" : "subset");
  const [selected, setSelected] = useState<Set<string>>(new Set(row.connectors ?? []));
  // Skills v2: "" = every skill (no tag scope).
  const [skillTagsDraft, setSkillTagsDraft] = useState((row.skillTags ?? []).join(", "));
  // Kebab House: profile served by my_context ("" = default).
  const [profileDraft, setProfileDraft] = useState(row.profile ?? "");
  const [profileNames, setProfileNames] = useState<string[]>([]);
  useEffect(() => {
    if (!isEditing) return;
    let cancelled = false;
    // fire-and-forget OK: profile list for the picker; failure keeps "default" only
    void fetch("/api/config/profiles", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : { profiles: [] }))
      .then((d: { profiles?: { name: string }[] }) => {
        if (cancelled) return;
        setProfileNames((d.profiles ?? []).map((p) => p.name).filter((n) => n !== "default"));
      })
      .catch(() => {
        // fire-and-forget OK: the picker falls back to "default" only
      });
    return () => {
      cancelled = true;
    };
  }, [isEditing]);

  // Preset ids that actually exist in the current connector set (a preset
  // for a connector that isn't configured would be a dead checkbox).
  const pickableIds = new Set(pickable.map((c) => c.id));
  const teamPresetIds = TEAM_PRESET_IDS.filter((id) => pickableIds.has(id));

  // Re-sync the draft whenever the picker (re)opens for this row.
  useEffect(() => {
    if (isEditing) {
      setMode(row.connectors === null ? "all" : "subset");
      setSelected(new Set(row.connectors ?? []));
      setSkillTagsDraft((row.skillTags ?? []).join(", "));
      setProfileDraft(row.profile ?? "");
    }
  }, [isEditing, row.connectors, row.skillTags, row.profile]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const save = () => {
    const tags = skillTagsDraft
      .split(/[,\s]+/)
      .map((t) => t.replace(/^#/, "").trim())
      .filter(Boolean);
    const skillTags = tags.length ? tags : null;
    const profile = profileDraft ? profileDraft : null;
    if (mode === "all") return void onSave(row.tokenId, null, skillTags, profile);
    return void onSave(row.tokenId, Array.from(selected), skillTags, profile);
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg bg-bg-muted px-4 py-4">
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
              <label key={c.id} className="flex items-center gap-1.5 text-[11px] cursor-pointer">
                <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
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
        Core tools (skills, profile) are always available and not listed here.
      </p>
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium" htmlFor={`skill-tags-${row.tokenId}`}>
          Skill tags visible to this token
        </label>
        <input
          id={`skill-tags-${row.tokenId}`}
          value={skillTagsDraft}
          onChange={(e) => setSkillTagsDraft(e.target.value)}
          placeholder="empty = every skill · e.g. perso, cadens"
          className="px-2 py-1 bg-bg border border-border rounded text-xs max-w-sm"
        />
        <p className="text-[11px] text-text-muted">
          Only skills tagged with one of these appear in this client (skills_list, skill_load,
          prompts, native bundle).
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium" htmlFor={`profile-${row.tokenId}`}>
          Profile served by my_context
        </label>
        <select
          id={`profile-${row.tokenId}`}
          value={profileDraft}
          onChange={(e) => setProfileDraft(e.target.value)}
          className="px-2 py-1 bg-bg border border-border rounded text-xs max-w-sm"
        >
          <option value="">default</option>
          {profileNames.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
          {profileDraft && !profileNames.includes(profileDraft) && (
            <option value={profileDraft}>{profileDraft} (missing)</option>
          )}
        </select>
        <p className="text-[11px] text-text-muted">
          One profile per hat: create them in Settings → Profiles.
        </p>
      </div>
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
  );
}
