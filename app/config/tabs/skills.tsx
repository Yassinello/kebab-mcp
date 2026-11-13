"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ImportSkillModal } from "./skills-import-modal";
import { SkillComposer } from "./skill-composer";
import { SkillEditPage } from "./skill-edit-page";
import { BundleImportModal } from "./skills-bundle-import-modal";
import { SkillsEverywherePanel } from "./skills-everywhere";
import { SkillTemplatesSection } from "./skills-templates";

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
  tags?: string[];
  files?: { path: string; size: number }[];
  exposeAsTool?: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Agent Skills name used by skill_load (`meeting_prep` → `meeting-prep`). */
function agentName(id: string): string {
  return id.replace(/_/g, "-");
}

function download(href: string) {
  window.location.href = href;
}

interface SyncTarget {
  name: string;
  path: string;
}

interface SkillVersionSummary {
  version: number;
  savedAt: string;
  name: string;
  description: string;
  contentPreview: string;
}

export function SkillsTab() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const editId = searchParams.get("edit");

  if (editId) {
    return <SkillEditPage skillId={editId} />;
  }

  return <SkillsListView router={router} />;
}

function SkillsListView({ router }: { router: ReturnType<typeof useRouter> }) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [bundleImportOpen, setBundleImportOpen] = useState(false);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [versionMap, setVersionMap] = useState<Record<string, number>>({});
  const [historyOpen, setHistoryOpen] = useState<string | null>(null);
  const [historyData, setHistoryData] = useState<SkillVersionSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const [syncTargets, setSyncTargets] = useState<SyncTarget[]>([]);
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
    fetch("/api/config/skills-sync-targets", { credentials: "include" })
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) setSyncTargets(d.targets || []);
      })
      .catch(() => {
        /* ignore */
      });
  }, []);

  const startCreate = () => {
    router.push("/config?tab=skills&edit=new");
  };

  const startEdit = (skill: Skill) => {
    router.push(`/config?tab=skills&edit=${skill.id}`);
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

  const tagCounts = new Map<string, number>();
  for (const sk of skills)
    for (const t of sk.tags ?? []) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
  const allTags = [...tagCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const visible = tagFilter ? skills.filter((sk) => (sk.tags ?? []).includes(tagFilter)) : skills;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h2 className="text-sm font-semibold text-text">Skills</h2>
        <div className="flex flex-wrap items-center gap-2 [&>button]:whitespace-nowrap">
          {flash && (
            <span className="text-[11px] font-medium text-green bg-green-bg px-2 py-0.5 rounded-full">
              {flash}
            </span>
          )}
          {!composerOpen && (
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
                onClick={() => setBundleImportOpen(true)}
                className="text-xs font-medium text-text-dim hover:text-text px-3 py-1.5 border border-border rounded-md"
                title="Import SKILL.md or .zip (Claude, ChatGPT, Codex, git…)"
                aria-label="Import SKILL.md or zip"
              >
                Import
              </button>
              <button
                onClick={() => setImportOpen(true)}
                className="text-xs font-medium text-text-dim hover:text-text px-3 py-1.5 border border-border rounded-md"
                title="Keep a skill in sync with a public URL (GitHub raw, Gist…)"
                aria-label="Import from URL"
              >
                From URL
              </button>
              {skills.length > 0 && (
                <button
                  onClick={() => download("/api/config/skills/export-all")}
                  className="text-xs font-medium text-text-dim hover:text-text px-3 py-1.5 border border-border rounded-md"
                  title="Download the whole library as Agent Skills folders (.zip)"
                >
                  Export all
                </button>
              )}
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
                Reusable instructions in the open <strong>Agent Skills</strong> format (a{" "}
                <code>SKILL.md</code> + optional bundled files such as references or scripts) — the
                same format Claude, ChatGPT, Codex and Claude Code use. Optional typed{" "}
                <strong>arguments</strong> fill <code>{`{{placeholders}}`}</code>.
              </p>
            </div>
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-1">
                How clients see it
              </h4>
              <p>
                Every client connected to Kebab gets your catalogue (name + description) and loads a
                skill on demand with <code className="text-text">skill_load</code> — so 50 skills
                cost 3 tools, not 50. Skills also appear as prompts (slash commands) and{" "}
                <code>skill://</code> resources. Older skills, or ones you opt in, additionally keep
                a dedicated <code className="text-text">skill_&lt;name&gt;</code> tool. The{" "}
                <strong>description</strong> is what the model reads to decide when to use a skill,
                so make it precise.
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

      <SkillsEverywherePanel tags={allTags.map(([t]) => t)} />

      <SkillTemplatesSection
        refreshKey={skills.map((sk) => `${sk.id}:${sk.updatedAt}`).join("|")}
        onInstalled={async (message) => {
          setFlash(message);
          setTimeout(() => setFlash(null), 2500);
          await reload();
        }}
      />

      {bundleImportOpen && (
        <BundleImportModal
          onClose={() => setBundleImportOpen(false)}
          onImported={async (summary) => {
            setBundleImportOpen(false);
            setFlash(`Imported: ${summary}`);
            setTimeout(() => setFlash(null), 3000);
            await reload();
          }}
        />
      )}

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

      {skills.length === 0 && (
        <div className="border border-border rounded-lg p-8 text-center">
          <p className="text-sm text-text-dim">
            No skills defined yet. Install a template above, or click <strong>+ New skill</strong>{" "}
            to create your own.
          </p>
        </div>
      )}

      {allTags.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap text-xs">
          <span className="text-text-muted">Tags:</span>
          <button
            type="button"
            onClick={() => setTagFilter(null)}
            className={`px-2 py-0.5 rounded-full border ${tagFilter === null ? "border-accent text-accent" : "border-border text-text-dim"}`}
          >
            all ({skills.length})
          </button>
          {allTags.map(([t, n]) => (
            <button
              key={t}
              type="button"
              onClick={() => setTagFilter(tagFilter === t ? null : t)}
              className={`px-2 py-0.5 rounded-full border ${tagFilter === t ? "border-accent text-accent" : "border-border text-text-dim"}`}
            >
              #{t} ({n})
            </button>
          ))}
        </div>
      )}

      {visible.map((skill) => (
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
          onDownloadZip={() => download(`/api/config/skills/${skill.id}/export?format=zip`)}
          onDownloadRelay={() => download(`/api/config/skills/${skill.id}/export?format=relay`)}
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
  onDownloadZip,
  onDownloadRelay,
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
  onDownloadZip: () => void;
  onDownloadRelay: () => void;
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
            <code
              className="text-[11px] text-text-muted"
              title={
                skill.exposeAsTool !== false
                  ? "Loaded via skill_load and also exposed as a dedicated tool"
                  : "Loaded on demand via skill_load"
              }
            >
              {skill.exposeAsTool !== false ? `skill_${skill.id}` : agentName(skill.id)}
            </code>
            {(skill.tags ?? []).map((t) => (
              <span key={t} className="text-[11px] px-1.5 py-0.5 rounded bg-bg-muted text-text-dim">
                #{t}
              </span>
            ))}
            {(skill.files?.length ?? 0) > 0 && (
              <span
                className="text-[11px] font-medium text-text-muted bg-bg-muted px-2 py-0.5 rounded-full"
                title={skill.files!.map((f) => f.path).join("\n")}
              >
                {skill.files!.length} file{skill.files!.length === 1 ? "" : "s"}
              </span>
            )}
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
              className="absolute right-0 top-full mt-1 w-56 bg-bg border border-border rounded-md shadow-lg overflow-hidden z-10"
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
                onClick={run(onDownloadZip)}
                className="w-full text-left text-xs px-3 py-2 text-text-dim hover:bg-bg-muted hover:text-text"
                title="SKILL.md + bundled files — uploadable to Claude, ChatGPT, Codex"
              >
                Download .zip (Agent Skill)
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={run(onDownloadRelay)}
                className="w-full text-left text-xs px-3 py-2 text-text-dim hover:bg-bg-muted hover:text-text"
                title="Tiny native skill that loads this one from Kebab — install once in claude.ai / ChatGPT, never re-upload"
              >
                Download relay .zip
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={run(onExport)}
                className="w-full text-left text-xs px-3 py-2 text-text-dim hover:bg-bg-muted hover:text-text"
              >
                Export as Markdown
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
