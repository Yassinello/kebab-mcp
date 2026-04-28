"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { InfoTooltip } from "./settings/info-tooltip";
import { ImportSkillModal } from "./skills-import-modal";
import { SkillComposer } from "./skill-composer";
import { toClaudeSkillFile } from "@/connectors/skills/lib/export-claude";

interface SkillArgument {
  name: string;
  description?: string;
  required?: boolean;
}

interface SkillSourceInline {
  type: "inline";
}
interface SkillSourceRemote {
  type: "remote";
  url: string;
  cachedContent?: string;
  cachedAt?: string;
  lastError?: string;
}
type SkillSource = SkillSourceInline | SkillSourceRemote;

interface SkillSyncState {
  target: string;
  lastSyncedHash: string;
  lastSyncedAt: string;
  lastSyncStatus: "ok" | "error";
  lastSyncError?: string;
}

interface Skill {
  id: string;
  name: string;
  description: string;
  content: string;
  arguments: SkillArgument[];
  toolsAllowed?: string[];
  source: SkillSource;
  syncState?: Record<string, SkillSyncState>;
  createdAt: string;
  updatedAt: string;
}

interface SyncTarget {
  name: string;
  path: string;
}

interface AvailableTool {
  name: string;
  connector: string;
  description: string;
}

interface DraftState {
  editingId: string | null; // null = creating new
  name: string;
  description: string;
  mode: "inline" | "remote";
  content: string;
  url: string;
  arguments: SkillArgument[];
  toolsAllowed: string[];
}

const emptyDraft = (): DraftState => ({
  editingId: null,
  name: "",
  description: "",
  mode: "inline",
  content: "",
  url: "",
  arguments: [],
  toolsAllowed: [],
});

interface SkillVersionSummary {
  version: number;
  savedAt: string;
  name: string;
  description: string;
  contentPreview: string;
}

export function SkillsTab() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [versionMap, setVersionMap] = useState<Record<string, number>>({});
  const [historyOpen, setHistoryOpen] = useState<string | null>(null);
  const [historyData, setHistoryData] = useState<SkillVersionSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const [syncTargets, setSyncTargets] = useState<SyncTarget[]>([]);
  const [availableTools, setAvailableTools] = useState<AvailableTool[]>([]);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [syncingAll, setSyncingAll] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("kebab.skills.helpOpen");
      if (saved !== null) setHelpOpen(saved === "1");
    } catch {
      /* localStorage unavailable — keep default */
    }
  }, []);

  const toggleHelp = () => {
    setHelpOpen((v) => {
      const next = !v;
      try {
        localStorage.setItem("kebab.skills.helpOpen", next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  const loadVersions = useCallback(async (skillIds: string[]) => {
    const map: Record<string, number> = {};
    await Promise.all(
      skillIds.map(async (id) => {
        try {
          const res = await fetch(`/api/config/skill-versions?id=${id}`, {
            credentials: "include",
          });
          const data = await res.json();
          if (data.ok) map[id] = data.currentVersion || 0;
        } catch {
          /* ignore */
        }
      })
    );
    setVersionMap((prev) => ({ ...prev, ...map }));
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/config/skills", { credentials: "include" });
      const data = await res.json();
      if (data.ok) {
        const skillList = data.skills || [];
        setSkills(skillList);
        loadVersions(skillList.map((s: Skill) => s.id));
      }
    } finally {
      setLoading(false);
    }
  }, [loadVersions]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    // Load sync targets + available tool list once on mount.
    fetch("/api/config/skills-sync-targets", { credentials: "include" })
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) setSyncTargets(d.targets || []);
      })
      .catch(() => {
        /* ignore — non-critical */
      });
    fetch("/api/config/available-tools", { credentials: "include" })
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) setAvailableTools(d.tools || []);
      })
      .catch(() => {
        /* ignore — non-critical */
      });
  }, []);

  const startCreate = () => {
    setDraft(emptyDraft());
    setError(null);
  };

  const startEdit = (skill: Skill) => {
    setDraft({
      editingId: skill.id,
      name: skill.name,
      description: skill.description,
      mode: skill.source.type,
      content: skill.content,
      url: skill.source.type === "remote" ? skill.source.url : "",
      arguments: skill.arguments.map((a) => ({ ...a })),
      toolsAllowed: [...(skill.toolsAllowed ?? [])],
    });
    setError(null);
  };

  const cancelDraft = () => {
    setDraft(null);
    setError(null);
  };

  const updateDraftArg = (idx: number, patch: Partial<SkillArgument>) => {
    setDraft((d) =>
      d
        ? {
            ...d,
            arguments: d.arguments.map((a, i) => (i === idx ? { ...a, ...patch } : a)),
          }
        : d
    );
  };

  const addArg = () => {
    setDraft((d) =>
      d
        ? {
            ...d,
            arguments: [...d.arguments, { name: "", description: "", required: false }],
          }
        : d
    );
  };

  const removeArg = (idx: number) => {
    setDraft((d) => (d ? { ...d, arguments: d.arguments.filter((_, i) => i !== idx) } : d));
  };

  const saveDraft = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    const payload = {
      name: draft.name.trim(),
      description: draft.description.trim(),
      content: draft.mode === "inline" ? draft.content : "",
      arguments: draft.arguments
        .filter((a) => a.name.trim())
        .map((a) => ({
          name: a.name.trim(),
          description: a.description || "",
          required: !!a.required,
        })),
      toolsAllowed: draft.toolsAllowed.filter((t) => t.trim().length > 0),
      source:
        draft.mode === "inline"
          ? { type: "inline" as const }
          : { type: "remote" as const, url: draft.url.trim() },
    };
    if (!payload.name) {
      setError("Name is required");
      setSaving(false);
      return;
    }
    if (draft.mode === "remote" && !payload.source.type) {
      setError("Remote URL is required");
      setSaving(false);
      return;
    }
    try {
      const url = draft.editingId ? `/api/config/skills/${draft.editingId}` : "/api/config/skills";
      const method = draft.editingId ? "PATCH" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error || "Save failed");
      } else {
        setDraft(null);
        setFlash(draft.editingId ? "Saved" : "Created");
        setTimeout(() => setFlash(null), 2000);
        await reload();
      }
    } catch {
      setError("Network error");
    }
    setSaving(false);
  };

  const deleteSkill = async (id: string) => {
    if (!confirm("Delete this skill? This cannot be undone.")) return;
    try {
      const res = await fetch(`/api/config/skills/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      const data = await res.json();
      if (data.ok) await reload();
      else alert(data.error || "Delete failed");
    } catch {
      alert("Network error");
    }
  };

  const refreshSkill = async (id: string) => {
    setRefreshing(id);
    try {
      const res = await fetch(`/api/config/skills/${id}/refresh`, {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json();
      if (data.ok) await reload();
      else alert(data.error || "Refresh failed");
    } catch {
      alert("Network error");
    }
    setRefreshing(null);
  };

  const exportSkill = (id: string) => {
    window.location.href = `/api/config/skills/${id}/export`;
  };

  const syncSkill = async (id: string, targetName?: string) => {
    setSyncing(id);
    try {
      const res = await fetch(`/api/config/skills/${id}/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(targetName ? { target: targetName } : { all: true }),
      });
      const data = await res.json();
      if (data.ok) {
        setFlash(`Synced to ${data.results.map((r: { target: string }) => r.target).join(", ")}`);
        setTimeout(() => setFlash(null), 2500);
        await reload();
      } else {
        const failed = (data.results || [])
          .filter((r: { ok: boolean }) => !r.ok)
          .map((r: { target: string; error?: string }) => `${r.target}: ${r.error ?? "error"}`);
        alert(failed.join("\n") || data.error || "Sync failed");
      }
    } catch {
      alert("Network error");
    }
    setSyncing(null);
  };

  const syncAllSkills = async () => {
    if (syncTargets.length === 0) {
      alert("No sync targets configured. Set KEBAB_SKILLS_SYNC_TARGETS env var.");
      return;
    }
    setSyncingAll(true);
    const failed: string[] = [];
    for (const skill of skills) {
      try {
        const res = await fetch(`/api/config/skills/${skill.id}/sync`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ all: true }),
        });
        const data = await res.json();
        if (!data.ok) failed.push(skill.id);
      } catch {
        failed.push(skill.id);
      }
    }
    setSyncingAll(false);
    if (failed.length > 0) {
      alert(`Sync failed for: ${failed.join(", ")}`);
    } else {
      setFlash(`Synced ${skills.length} skills`);
      setTimeout(() => setFlash(null), 2500);
    }
    await reload();
  };

  /** Compute a simple client-side drift signal: has the skill been updated
   * after its last sync? We use updatedAt vs lastSyncedAt because the
   * server-side hash comparison requires extra round-trips. */
  const computeDrift = (skill: Skill): { stale: boolean; targets: string[] } => {
    const state = skill.syncState ?? {};
    const staleTargets: string[] = [];
    for (const [targetName, s] of Object.entries(state)) {
      if (s.lastSyncStatus !== "ok") continue;
      if (new Date(skill.updatedAt).getTime() > new Date(s.lastSyncedAt).getTime()) {
        staleTargets.push(targetName);
      }
    }
    return { stale: staleTargets.length > 0, targets: staleTargets };
  };

  /** Client-side export to Claude Desktop .skill format (JSON). */
  const exportClaudeSkill = (skill: Skill) => {
    const payload = toClaudeSkillFile(skill);
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${skill.id}.skill`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const toggleHistory = async (skillId: string) => {
    if (historyOpen === skillId) {
      setHistoryOpen(null);
      setHistoryData([]);
      return;
    }
    setHistoryOpen(skillId);
    setHistoryLoading(true);
    try {
      const res = await fetch(`/api/config/skill-versions?id=${skillId}`, {
        credentials: "include",
      });
      const data = await res.json();
      if (data.ok) setHistoryData(data.versions || []);
      else setHistoryData([]);
    } catch {
      setHistoryData([]);
    }
    setHistoryLoading(false);
  };

  const rollbackTo = async (skillId: string, version: number) => {
    if (
      !confirm(
        `Rollback to version ${version}? A new version will be created with the old content.`
      )
    )
      return;
    setRollingBack(true);
    try {
      const res = await fetch("/api/config/skill-rollback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ id: skillId, version }),
      });
      const data = await res.json();
      if (data.ok) {
        setFlash("Rolled back");
        setTimeout(() => setFlash(null), 2000);
        setHistoryOpen(null);
        await reload();
      } else {
        alert(data.error || "Rollback failed");
      }
    } catch {
      alert("Network error");
    }
    setRollingBack(false);
  };

  if (loading) {
    return <p className="text-sm text-text-muted">Loading skills...</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-text">Skills</h2>
        <div className="flex items-center gap-2">
          {flash && (
            <span className="text-[11px] font-medium text-green bg-green-bg px-2 py-0.5 rounded-full">
              {flash}
            </span>
          )}
          {!draft && !composerOpen && (
            <>
              {syncTargets.length > 0 && skills.length > 0 && (
                <button
                  onClick={syncAllSkills}
                  disabled={syncingAll}
                  className="text-xs font-medium text-text-dim hover:text-text px-3 py-1.5 border border-border rounded-md disabled:opacity-60"
                  title={`Sync all skills to ${syncTargets.map((t) => t.name).join(", ")}`}
                >
                  {syncingAll ? "Syncing..." : "Sync all"}
                </button>
              )}
              <button
                onClick={() => setComposerOpen(true)}
                className="text-xs font-medium text-accent hover:underline px-3 py-1.5 border border-accent/20 rounded-md"
              >
                Compose
              </button>
              <button
                onClick={() => setImportOpen(true)}
                className="text-xs font-medium text-text-dim hover:text-text px-3 py-1.5 border border-border rounded-md"
              >
                Import from URL
              </button>
              <button
                onClick={startCreate}
                className="text-xs font-medium text-accent hover:underline px-3 py-1.5 border border-accent/20 rounded-md"
              >
                + New skill
              </button>
            </>
          )}
        </div>
      </div>

      <div className="border border-border rounded-lg overflow-hidden bg-bg-muted/20">
        <button
          type="button"
          onClick={toggleHelp}
          className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-bg-muted/40 transition-colors"
          aria-expanded={helpOpen}
        >
          <div
            className="w-7 h-7 rounded-full bg-accent/10 text-accent flex items-center justify-center text-xs font-bold shrink-0"
            aria-hidden="true"
          >
            ?
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-text">How to use skills</p>
            <p className="text-xs text-text-dim mt-0.5">
              {helpOpen
                ? "Click to collapse."
                : "What skills are, how clients see them, and when to reach for one."}
            </p>
          </div>
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            aria-hidden="true"
            className={`text-text-muted shrink-0 transition-transform ${helpOpen ? "rotate-180" : ""}`}
          >
            <path
              d="M3.5 5.25L7 8.75L10.5 5.25"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        {helpOpen && (
          <div className="border-t border-border px-4 py-4 text-sm text-text-dim space-y-3 bg-bg/40">
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-1">
                What is a skill?
              </h4>
              <p>
                A reusable prompt template (markdown) bundled with optional typed{" "}
                <strong>arguments</strong> and a list of MCP <strong>tools</strong> it&apos;s
                allowed to call. Think of it as a small recipe your AI client can run on demand.
              </p>
            </div>
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-1">
                How clients see it
              </h4>
              <p>
                Each skill is exposed to MCP clients (Claude, Cursor, Windsurf, ChatGPT) as a tool
                named <code className="text-text">skill_&lt;name&gt;</code> — and as a prompt in
                clients that support both. The <strong>description</strong> is what the LLM reads
                when picking which tool to call, so make it precise.
              </p>
            </div>
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-1">
                When to use a skill (vs a direct prompt)
              </h4>
              <ul className="list-disc pl-5 space-y-1">
                <li>
                  <strong>Use a skill</strong> when you repeat the same prompt shape often (status
                  reports, brief drafts, code reviews) — the LLM picks it for you and arguments
                  enforce the structure.
                </li>
                <li>
                  <strong>Use a direct prompt</strong> for one-shot, exploratory questions where the
                  structure isn&apos;t reusable.
                </li>
                <li>
                  Bundle a skill with <code className="text-text">toolsAllowed</code> when you want
                  to constrain which integrations it touches (governance + reviewability).
                </li>
              </ul>
            </div>
            <div className="text-xs text-text-muted pt-1 border-t border-border/60">
              Tip: use <strong className="text-text-dim">{`{{argument}}`}</strong> placeholders in
              the body to inject typed inputs from the caller.
            </div>
          </div>
        )}
      </div>

      {importOpen && (
        <ImportSkillModal
          onClose={() => setImportOpen(false)}
          onImported={async () => {
            setImportOpen(false);
            setFlash("Skill imported");
            setTimeout(() => setFlash(null), 2500);
            await reload();
          }}
        />
      )}

      {composerOpen && (
        <SkillComposer
          onClose={() => setComposerOpen(false)}
          onCreated={async () => {
            setComposerOpen(false);
            setFlash("Skill created via composer");
            setTimeout(() => setFlash(null), 2500);
            await reload();
          }}
        />
      )}

      {draft && (
        <DraftForm
          draft={draft}
          setDraft={setDraft}
          onCancel={cancelDraft}
          onSave={saveDraft}
          saving={saving}
          error={error}
          updateArg={updateDraftArg}
          addArg={addArg}
          removeArg={removeArg}
          availableTools={availableTools}
        />
      )}

      {syncTargets.length === 0 && skills.length > 0 && (
        <div className="border border-border rounded-lg p-3 text-xs text-text-dim bg-bg-muted/30">
          <strong>Tip:</strong> Configure sync targets by setting{" "}
          <code>KEBAB_SKILLS_SYNC_TARGETS</code> to a JSON array. Example:{" "}
          <code>{`[{"name":"claude-code","path":"/Users/you/.claude/skills"}]`}</code>. Skills will
          then be syncable to Claude Code&apos;s local skills directory with one click.
        </div>
      )}

      {syncTargets.length > 0 && (
        <div className="border border-border rounded-lg p-3 text-xs text-text-dim bg-bg-muted/30">
          Sync targets:{" "}
          {syncTargets.map((t) => (
            <code key={t.name} className="mr-2">
              {t.name} → {t.path}
            </code>
          ))}
        </div>
      )}

      {skills.length === 0 && !draft && (
        <div className="border border-border rounded-lg p-8 text-center">
          <p className="text-sm text-text-dim">
            No skills defined yet. Click <strong>+ New skill</strong> to create your first one.
          </p>
        </div>
      )}

      {skills.map((skill) => (
        <SkillCard
          key={skill.id}
          skill={skill}
          drift={computeDrift(skill)}
          syncedTargets={Object.keys(skill.syncState ?? {}).filter(
            (t) => (skill.syncState ?? {})[t]?.lastSyncStatus === "ok"
          )}
          version={versionMap[skill.id] ?? 0}
          syncTargets={syncTargets}
          refreshing={refreshing === skill.id}
          syncing={syncing === skill.id}
          historyOpen={historyOpen === skill.id}
          historyLoading={historyLoading}
          historyData={historyData}
          rollingBack={rollingBack}
          onEdit={() => startEdit(skill)}
          onDelete={() => deleteSkill(skill.id)}
          onRefresh={() => refreshSkill(skill.id)}
          onSync={() => syncSkill(skill.id)}
          onToggleHistory={() => toggleHistory(skill.id)}
          onExport={() => exportSkill(skill.id)}
          onExportClaude={() => exportClaudeSkill(skill)}
          onRollback={(version) => rollbackTo(skill.id, version)}
        />
      ))}
    </div>
  );
}

function SkillCard({
  skill,
  drift,
  syncedTargets,
  version,
  syncTargets,
  refreshing,
  syncing,
  historyOpen,
  historyLoading,
  historyData,
  rollingBack,
  onEdit,
  onDelete,
  onRefresh,
  onSync,
  onToggleHistory,
  onExport,
  onExportClaude,
  onRollback,
}: {
  skill: Skill;
  drift: { stale: boolean; targets: string[] };
  syncedTargets: string[];
  version: number;
  syncTargets: SyncTarget[];
  refreshing: boolean;
  syncing: boolean;
  historyOpen: boolean;
  historyLoading: boolean;
  historyData: SkillVersionSummary[];
  rollingBack: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onRefresh: () => void;
  onSync: () => void;
  onToggleHistory: () => void;
  onExport: () => void;
  onExportClaude: () => void;
  onRollback: (version: number) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const close = () => setMenuOpen(false);
  const run = (fn: () => void) => () => {
    close();
    fn();
  };

  const isRemote = skill.source.type === "remote";
  const remoteHasError = skill.source.type === "remote" && !!skill.source.lastError;

  return (
    <div className="border border-border rounded-lg overflow-hidden hover:border-border-light transition-colors">
      <div
        role="button"
        tabIndex={0}
        onClick={onEdit}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onEdit();
          }
        }}
        className="flex items-center gap-3 px-5 py-4 cursor-pointer hover:bg-bg-muted/30 transition-colors"
        title="Click to edit"
      >
        <div className="w-9 h-9 rounded-lg bg-accent/10 flex items-center justify-center text-accent font-bold text-sm shrink-0">
          {skill.name.charAt(0).toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-semibold text-sm">{skill.name}</p>
            <code className="text-[11px] text-text-muted">skill_{skill.id}</code>
            <span
              className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${
                isRemote ? "text-accent bg-accent/10" : "text-text-muted bg-bg-muted"
              }`}
            >
              {skill.source.type}
            </span>
            {version > 0 && (
              <span className="text-[11px] font-medium px-2 py-0.5 rounded-full text-text-muted bg-bg-muted">
                v{version}
              </span>
            )}
            {remoteHasError && (
              <span className="text-[11px] font-medium text-red bg-red-bg px-2 py-0.5 rounded-full">
                fetch error
              </span>
            )}
            {drift.stale && (
              <span
                className="text-[11px] font-medium text-orange bg-orange-bg px-2 py-0.5 rounded-full"
                title={`Edited after last sync to: ${drift.targets.join(", ")}`}
              >
                drift
              </span>
            )}
            {!drift.stale && syncedTargets.length > 0 && (
              <span
                className="text-[11px] font-medium text-green bg-green-bg px-2 py-0.5 rounded-full"
                title={`Synced to ${syncedTargets.join(", ")}`}
              >
                synced
              </span>
            )}
            {(skill.toolsAllowed?.length ?? 0) > 0 && (
              <span
                className="text-[11px] font-medium text-text-muted bg-bg-muted px-2 py-0.5 rounded-full"
                title={`Allowed tools: ${skill.toolsAllowed!.join(", ")}`}
              >
                {skill.toolsAllowed!.length} tool{skill.toolsAllowed!.length === 1 ? "" : "s"}
              </span>
            )}
          </div>
          <p className="text-xs text-text-dim mt-0.5 truncate">
            {skill.description || <em className="text-text-muted">no description</em>}
          </p>
        </div>
        <div
          className="relative shrink-0"
          ref={menuRef}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          role="presentation"
        >
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            className="text-xs font-medium text-text-dim hover:text-text border border-border hover:border-border-light rounded-md px-2.5 py-1 inline-flex items-center gap-1"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="Skill actions"
          >
            Actions
            <svg
              width="10"
              height="10"
              viewBox="0 0 12 12"
              fill="none"
              aria-hidden="true"
              className={`transition-transform ${menuOpen ? "rotate-180" : ""}`}
            >
              <path
                d="M3 4.5L6 7.5L9 4.5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 top-full mt-1 w-48 bg-bg border border-border rounded-md shadow-lg overflow-hidden z-10"
            >
              <button
                type="button"
                role="menuitem"
                onClick={run(onEdit)}
                className="w-full text-left text-xs px-3 py-2 text-text hover:bg-bg-muted"
              >
                Edit
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={run(onToggleHistory)}
                className="w-full text-left text-xs px-3 py-2 text-text-dim hover:bg-bg-muted hover:text-text"
              >
                {historyOpen ? "Hide history" : "View history"}
              </button>
              {isRemote && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={run(onRefresh)}
                  disabled={refreshing}
                  className="w-full text-left text-xs px-3 py-2 text-text-dim hover:bg-bg-muted hover:text-text disabled:opacity-60"
                >
                  {refreshing ? "Refreshing..." : "Refresh from URL"}
                </button>
              )}
              {syncTargets.length > 0 && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={run(onSync)}
                  disabled={syncing}
                  className="w-full text-left text-xs px-3 py-2 text-text-dim hover:bg-bg-muted hover:text-text disabled:opacity-60"
                  title={`Sync to ${syncTargets.map((t) => t.name).join(", ")}`}
                >
                  {syncing ? "Syncing..." : "Sync to targets"}
                </button>
              )}
              <div className="border-t border-border" />
              <button
                type="button"
                role="menuitem"
                onClick={run(onExport)}
                className="w-full text-left text-xs px-3 py-2 text-text-dim hover:bg-bg-muted hover:text-text"
              >
                Export as Markdown
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={run(onExportClaude)}
                className="w-full text-left text-xs px-3 py-2 text-text-dim hover:bg-bg-muted hover:text-text"
              >
                Export as Claude Skill
              </button>
              <div className="border-t border-border" />
              <button
                type="button"
                role="menuitem"
                onClick={run(onDelete)}
                className="w-full text-left text-xs px-3 py-2 text-red hover:bg-red-bg"
              >
                Delete
              </button>
            </div>
          )}
        </div>
      </div>
      {historyOpen && (
        <div className="border-t border-border px-5 py-4 bg-bg-muted/30">
          <h4 className="text-xs font-semibold text-text-muted mb-2">Version History</h4>
          {historyLoading ? (
            <p className="text-xs text-text-muted">Loading...</p>
          ) : historyData.length === 0 ? (
            <p className="text-xs text-text-muted">No version history available.</p>
          ) : (
            <div className="space-y-2">
              {[...historyData].reverse().map((v) => (
                <div
                  key={v.version}
                  className="flex items-center gap-3 text-xs border border-border rounded-md px-3 py-2"
                >
                  <span className="font-mono font-medium text-accent shrink-0">v{v.version}</span>
                  <span className="text-text-muted shrink-0">
                    {new Date(v.savedAt).toLocaleString()}
                  </span>
                  <span className="text-text-dim flex-1 truncate">
                    {v.contentPreview || "(empty)"}
                  </span>
                  {v.version !== version && (
                    <button
                      onClick={() => onRollback(v.version)}
                      disabled={rollingBack}
                      className="text-xs text-orange hover:underline shrink-0 disabled:opacity-50"
                    >
                      Rollback
                    </button>
                  )}
                  {v.version === version && (
                    <span className="text-[10px] font-medium text-green bg-green-bg px-1.5 py-0.5 rounded shrink-0">
                      current
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DraftForm({
  draft,
  setDraft,
  onCancel,
  onSave,
  saving,
  error,
  updateArg,
  addArg,
  removeArg,
  availableTools,
}: {
  draft: DraftState;
  setDraft: (updater: (d: DraftState | null) => DraftState | null) => void;
  onCancel: () => void;
  onSave: () => void;
  saving: boolean;
  error: string | null;
  updateArg: (idx: number, patch: Partial<SkillArgument>) => void;
  addArg: () => void;
  removeArg: (idx: number) => void;
  availableTools: AvailableTool[];
}) {
  const set = (patch: Partial<DraftState>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const toggleTool = (name: string) => {
    setDraft((d) => {
      if (!d) return d;
      const has = d.toolsAllowed.includes(name);
      return {
        ...d,
        toolsAllowed: has ? d.toolsAllowed.filter((t) => t !== name) : [...d.toolsAllowed, name],
      };
    });
  };

  const isEditing = !!draft.editingId;
  const breadcrumbLabel = isEditing ? draft.name.trim() || "Untitled skill" : "New";

  return (
    <div className="border border-accent/30 rounded-lg bg-bg p-5 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <nav
            className="flex items-center gap-1.5 text-[11px] text-text-muted mb-1"
            aria-label="Breadcrumb"
          >
            <button type="button" onClick={onCancel} className="hover:text-text transition-colors">
              Skills
            </button>
            <span className="text-text-muted/60">/</span>
            <span className="text-text-dim font-medium truncate max-w-[280px]">
              {breadcrumbLabel}
            </span>
            {isEditing && (
              <>
                <span className="text-text-muted/60">/</span>
                <span className="text-text-dim">Edit</span>
              </>
            )}
          </nav>
          <h2 className="font-semibold text-base text-text">
            {isEditing ? "Edit skill" : "Create a new skill"}
          </h2>
          <p className="text-xs text-text-dim mt-0.5">
            {isEditing
              ? "Update the prompt body, arguments, or allowed tools."
              : "Define a reusable prompt template — exposed as an MCP tool to your clients."}
          </p>
        </div>
        <button
          onClick={onCancel}
          className="text-xs text-text-dim hover:text-text shrink-0 px-2 py-1"
        >
          Cancel
        </button>
      </div>

      <div>
        <div className="flex items-center gap-2 mb-1.5">
          <label className="text-sm font-medium">Name</label>
          <InfoTooltip
            title="Skill name"
            body="Short slug used to derive the MCP tool name (lowercase, dashes only). Becomes skill_<name> when exposed to clients. Example: 'weekly-status' → tool 'skill_weekly-status'. Pick something memorable — the LLM picks tools partly by name."
          />
        </div>
        <input
          type="text"
          value={draft.name}
          onChange={(e) => set({ name: e.target.value })}
          placeholder="weekly-status"
          className="w-full bg-bg-muted border border-border rounded-md px-3 py-2 text-sm focus:border-accent focus:outline-none"
        />
      </div>

      <div>
        <div className="flex items-center gap-2 mb-1.5">
          <label className="text-sm font-medium">Description</label>
          <InfoTooltip
            title="What the LLM sees"
            body="One-line summary the LLM reads when picking which tool to call. Be precise — vague descriptions get ignored. Bad: 'helps with status reports'. Good: 'Drafts a Wins/Blockers/Next weekly status report from raw notes; takes a single notes argument'."
          />
        </div>
        <input
          type="text"
          value={draft.description}
          onChange={(e) => set({ description: e.target.value })}
          placeholder="Drafts a weekly status report from raw notes"
          className="w-full bg-bg-muted border border-border rounded-md px-3 py-2 text-sm focus:border-accent focus:outline-none"
        />
      </div>

      <div>
        <div className="flex items-center gap-2 mb-1.5">
          <label className="text-sm font-medium">Source</label>
          <InfoTooltip
            title="Inline vs Remote"
            body="Inline = the prompt body lives in Kebab MCP's KV store; edit it from this form anytime. Remote = Kebab MCP fetches the markdown from a URL on each invocation (with caching). Use Remote for skills shared across deployments; use Inline for personal skills you tweak often."
          />
        </div>
        <div className="flex gap-2">
          {(["inline", "remote"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => set({ mode: m })}
              className={`text-xs font-medium px-3 py-1.5 rounded-md border ${
                draft.mode === m
                  ? "border-accent bg-accent/10 text-accent"
                  : "border-border text-text-dim hover:border-border-light"
              }`}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      {draft.mode === "inline" ? (
        <div>
          <div className="flex items-center gap-2 mb-1.5">
            <label className="text-sm font-medium">Content</label>
            <InfoTooltip
              title="Skill body"
              body="The prompt body that gets rendered when the skill is called. Use {{arg_name}} placeholders to inject argument values. Example: 'Summarize the following: {{notes}}'. Keep it short — skills are templates, not full conversations."
            />
            <span className="text-text-muted text-xs font-normal">
              markdown · use {`{{arg}}`} placeholders
            </span>
          </div>
          <textarea
            value={draft.content}
            onChange={(e) => set({ content: e.target.value })}
            rows={10}
            placeholder="Summarize this article: {{url}}&#10;&#10;Focus on:&#10;- Key claims&#10;- Supporting evidence&#10;- Actionable takeaways"
            className="w-full bg-bg-muted border border-border rounded-md px-3 py-2 text-sm font-mono focus:border-accent focus:outline-none"
          />
        </div>
      ) : (
        <div>
          <label className="text-sm font-medium block mb-1.5">
            URL{" "}
            <span className="text-text-muted font-normal">(https, 500KB max, cached 15 min)</span>
          </label>
          <input
            type="url"
            value={draft.url}
            onChange={(e) => set({ url: e.target.value })}
            placeholder="https://raw.githubusercontent.com/user/repo/main/skill.md"
            className="w-full bg-bg-muted border border-border rounded-md px-3 py-2 text-sm font-mono focus:border-accent focus:outline-none"
          />
        </div>
      )}

      <div>
        <div className="flex items-center justify-between mb-1.5">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium">Arguments</label>
            <InfoTooltip
              title="Typed inputs the skill accepts"
              body="Each argument has a name (mustache placeholder), a description (shown to the LLM in the tool schema), and a required flag. The LLM picks values for required arguments before invoking. Example: name='notes', description='Raw notes for the week', required=true → the skill body can use {{notes}}."
            />
          </div>
          <button type="button" onClick={addArg} className="text-xs text-accent hover:underline">
            + Add arg
          </button>
        </div>
        {draft.arguments.length === 0 && (
          <p className="text-xs text-text-muted">
            No arguments. Add one to accept input from the caller.
          </p>
        )}
        <div className="space-y-2">
          {draft.arguments.map((arg, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                type="text"
                value={arg.name}
                onChange={(e) => updateArg(i, { name: e.target.value })}
                placeholder="name"
                className="w-32 bg-bg-muted border border-border rounded-md px-2 py-1 text-xs font-mono focus:border-accent focus:outline-none"
              />
              <input
                type="text"
                value={arg.description || ""}
                onChange={(e) => updateArg(i, { description: e.target.value })}
                placeholder="description (shown to LLM)"
                className="flex-1 bg-bg-muted border border-border rounded-md px-2 py-1 text-xs focus:border-accent focus:outline-none"
              />
              <label className="text-xs text-text-dim flex items-center gap-1 shrink-0">
                <input
                  type="checkbox"
                  checked={!!arg.required}
                  onChange={(e) => updateArg(i, { required: e.target.checked })}
                />
                required
              </label>
              <button
                type="button"
                onClick={() => removeArg(i)}
                className="text-xs text-red hover:underline"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className="flex items-center gap-2 mb-1.5">
          <label className="text-sm font-medium">Allowed tools</label>
          <InfoTooltip
            title="Governance — tools this skill is allowed to invoke"
            body="Declare which MCP tools this skill may call. The list is embedded in the exported frontmatter as `tools_allowed` so Claude Code (and reviewers) can see the skill's surface before invocation. Empty = no explicit restriction — the skill inherits the ambient tool surface at runtime."
          />
          <span className="text-text-muted text-xs font-normal">
            {draft.toolsAllowed.length} selected
          </span>
        </div>
        {availableTools.length === 0 ? (
          <p className="text-xs text-text-muted">No tools available yet.</p>
        ) : (
          <div className="max-h-48 overflow-y-auto border border-border rounded-md p-2 space-y-1 bg-bg-muted/40">
            {availableTools.map((t) => (
              <label
                key={t.name}
                className="flex items-start gap-2 text-xs px-1.5 py-1 hover:bg-bg-muted rounded cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={draft.toolsAllowed.includes(t.name)}
                  onChange={() => toggleTool(t.name)}
                  className="mt-0.5"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <code className="font-mono text-text">{t.name}</code>
                    <span className="text-[10px] text-text-muted">{t.connector}</span>
                  </div>
                  {t.description && <p className="text-text-dim truncate">{t.description}</p>}
                </div>
              </label>
            ))}
          </div>
        )}
      </div>

      {error && (
        <div className="bg-red-bg border border-red/20 rounded-md p-3 text-xs text-red">
          {error}
        </div>
      )}

      <div className="flex items-center gap-3 pt-2">
        <button
          onClick={onSave}
          disabled={saving}
          className="bg-accent text-white text-sm font-medium px-4 py-1.5 rounded-md hover:bg-accent/90 disabled:opacity-60"
        >
          {saving ? "Saving..." : draft.editingId ? "Save changes" : "Create skill"}
        </button>
        <button
          onClick={onCancel}
          className="text-sm font-medium px-4 py-1.5 rounded-md bg-bg-muted hover:bg-border-light text-text-dim"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
