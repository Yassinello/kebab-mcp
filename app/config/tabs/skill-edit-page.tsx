"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { InfoTooltip } from "./settings/info-tooltip";
import { SkillFilesEditor } from "./skill-files-editor";

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

interface AvailableTool {
  name: string;
  connector: string;
  description: string;
}

interface SkillVersionSummary {
  version: number;
  savedAt: string;
  name: string;
  description: string;
  contentPreview: string;
}

interface DraftState {
  name: string;
  description: string;
  mode: "inline" | "remote";
  content: string;
  url: string;
  arguments: SkillArgument[];
  toolsAllowed: string[];
  /** Comma/space separated in the input; normalized server-side. */
  tags: string;
  exposeAsTool: boolean;
}

function parseTagsInput(s: string): string[] {
  return s
    .split(/[,\s]+/)
    .map((t) => t.replace(/^#/, "").trim())
    .filter(Boolean);
}

const emptyDraft = (): DraftState => ({
  name: "",
  description: "",
  mode: "inline",
  content: "",
  url: "",
  arguments: [],
  toolsAllowed: [],
  tags: "",
  exposeAsTool: false,
});

type Tab = "editor" | "settings";

export function SkillEditPage({ skillId }: { skillId: string }) {
  const router = useRouter();
  const isNew = skillId === "new";

  const [tab, setTab] = useState<Tab>("editor");
  const [skill, setSkill] = useState<Skill | null>(null);
  const [loading, setLoading] = useState(!isNew);
  const [draft, setDraft] = useState<DraftState>(emptyDraft());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [availableTools, setAvailableTools] = useState<AvailableTool[]>([]);
  const [versions, setVersions] = useState<SkillVersionSummary[]>([]);
  const [currentVersion, setCurrentVersion] = useState(0);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const loadSkill = useCallback(async () => {
    if (isNew) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/config/skills", { credentials: "include" });
      const data = await res.json();
      if (data.ok) {
        const found = (data.skills || []).find((s: Skill) => s.id === skillId);
        if (found) {
          setSkill(found);
          setDraft({
            name: found.name,
            description: found.description,
            mode: found.source.type,
            content: found.content,
            url: found.source.type === "remote" ? found.source.url : "",
            arguments: found.arguments.map((a: SkillArgument) => ({ ...a })),
            toolsAllowed: [...(found.toolsAllowed ?? [])],
            tags: (found.tags ?? []).join(", "),
            exposeAsTool: found.exposeAsTool !== false,
          });
        } else {
          setError("Skill not found");
        }
      }
    } catch {
      setError("Failed to load skill");
    } finally {
      setLoading(false);
    }
  }, [isNew, skillId]);

  const loadVersions = useCallback(async () => {
    if (isNew) return;
    setVersionsLoading(true);
    try {
      const res = await fetch(`/api/config/skill-versions?id=${skillId}`, {
        credentials: "include",
      });
      const data = await res.json();
      if (data.ok) {
        setVersions(data.versions || []);
        setCurrentVersion(data.currentVersion || 0);
      }
    } catch {
      /* ignore */
    } finally {
      setVersionsLoading(false);
    }
  }, [isNew, skillId]);

  useEffect(() => {
    loadSkill();
    loadVersions();
  }, [loadSkill, loadVersions]);

  useEffect(() => {
    fetch("/api/config/available-tools", { credentials: "include" })
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) setAvailableTools(d.tools || []);
      })
      .catch(() => {
        /* ignore */
      });
  }, []);

  const goBack = () => {
    router.push("/config?tab=skills");
  };

  const updateArg = (idx: number, patch: Partial<SkillArgument>) => {
    setDraft((d) => ({
      ...d,
      arguments: d.arguments.map((a, i) => (i === idx ? { ...a, ...patch } : a)),
    }));
  };

  const addArg = () => {
    setDraft((d) => ({
      ...d,
      arguments: [...d.arguments, { name: "", description: "", required: false }],
    }));
  };

  const removeArg = (idx: number) => {
    setDraft((d) => ({ ...d, arguments: d.arguments.filter((_, i) => i !== idx) }));
  };

  const toggleTool = (name: string) => {
    setDraft((d) => {
      const has = d.toolsAllowed.includes(name);
      return {
        ...d,
        toolsAllowed: has ? d.toolsAllowed.filter((t) => t !== name) : [...d.toolsAllowed, name],
      };
    });
  };

  const save = async () => {
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
      tags: parseTagsInput(draft.tags),
      exposeAsTool: draft.exposeAsTool,
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
    if (draft.mode === "remote" && !draft.url.trim()) {
      setError("Remote URL is required");
      setSaving(false);
      return;
    }
    try {
      const url = isNew ? "/api/config/skills" : `/api/config/skills/${skillId}`;
      const method = isNew ? "POST" : "PATCH";
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
        if (isNew && data.skill?.id) {
          router.push(`/config?tab=skills&edit=${data.skill.id}`);
        } else {
          setFlash("Saved");
          setTimeout(() => setFlash(null), 2000);
          await loadSkill();
          await loadVersions();
        }
      }
    } catch {
      setError("Network error");
    }
    setSaving(false);
  };

  const exportMarkdown = () => {
    if (isNew) return;
    window.location.href = `/api/config/skills/${skillId}/export`;
  };

  const downloadZip = (format: "zip" | "relay") => {
    if (isNew) return;
    window.location.href = `/api/config/skills/${skillId}/export?format=${format}`;
  };

  const rollback = async (version: number) => {
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
        await loadSkill();
        await loadVersions();
      } else {
        alert(data.error || "Rollback failed");
      }
    } catch {
      alert("Network error");
    }
    setRollingBack(false);
  };

  const deleteSkill = async () => {
    if (!confirm("Delete this skill? This cannot be undone.")) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/config/skills/${skillId}`, {
        method: "DELETE",
        credentials: "include",
      });
      const data = await res.json();
      if (data.ok) {
        router.push("/config?tab=skills");
      } else {
        alert(data.error || "Delete failed");
        setDeleting(false);
      }
    } catch {
      alert("Network error");
      setDeleting(false);
    }
  };

  const breadcrumbName = isNew ? "New skill" : skill?.name || draft.name || "Untitled skill";

  if (loading) {
    return <p className="text-sm text-text-muted p-8">Loading skill...</p>;
  }

  return (
    <div className="space-y-4">
      <div>
        <nav
          className="flex items-center gap-1.5 text-xs text-text-muted mb-2"
          aria-label="Breadcrumb"
        >
          <button type="button" onClick={goBack} className="hover:text-text transition-colors">
            Skills
          </button>
          <span className="text-text-muted/60">/</span>
          <span className="text-text-dim font-medium truncate max-w-[280px]">{breadcrumbName}</span>
          {!isNew && (
            <>
              <span className="text-text-muted/60">/</span>
              <span className="text-text-dim">Edit</span>
            </>
          )}
        </nav>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-text">
              {isNew ? "Create a new skill" : skill?.name || "Edit skill"}
            </h1>
            <p className="text-xs text-text-dim mt-0.5">
              {isNew
                ? "Define a reusable prompt template — exposed as an MCP tool to your clients."
                : skill?.description || "No description"}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {flash && (
              <span className="text-[11px] font-medium text-green bg-green-bg px-2 py-0.5 rounded-full">
                {flash}
              </span>
            )}
            <button
              type="button"
              onClick={goBack}
              className="text-xs font-medium text-text-dim hover:text-text px-3 py-1.5 border border-border rounded-md"
            >
              Back to skills
            </button>
          </div>
        </div>
      </div>

      <div className="border-b border-border flex gap-1">
        <TabButton active={tab === "editor"} onClick={() => setTab("editor")}>
          Editor
        </TabButton>
        {!isNew && (
          <TabButton active={tab === "settings"} onClick={() => setTab("settings")}>
            Settings
          </TabButton>
        )}
      </div>

      {tab === "editor" && (
        <EditorTab
          draft={draft}
          setDraft={setDraft}
          updateArg={updateArg}
          addArg={addArg}
          removeArg={removeArg}
          toggleTool={toggleTool}
          availableTools={availableTools}
          error={error}
          saving={saving}
          isNew={isNew}
          onSave={save}
          onCancel={goBack}
        />
      )}

      {tab === "editor" && !isNew && skill && (
        <div className="mt-5">
          <SkillFilesEditor skillId={skill.id} agentName={skill.id.replace(/_/g, "-")} />
        </div>
      )}
      {tab === "editor" && isNew && (
        <p className="mt-3 text-xs text-text-muted">
          Save the skill first to add bundled files (references, templates, scripts).
        </p>
      )}

      {tab === "settings" && !isNew && skill && (
        <SettingsTab
          skill={skill}
          versions={versions}
          currentVersion={currentVersion}
          versionsLoading={versionsLoading}
          rollingBack={rollingBack}
          deleting={deleting}
          onRollback={rollback}
          onExportMarkdown={exportMarkdown}
          onDownloadZip={() => downloadZip("zip")}
          onDownloadRelay={() => downloadZip("relay")}
          onDelete={deleteSkill}
        />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-sm font-medium px-4 py-2 border-b-2 -mb-px transition-colors ${
        active ? "border-accent text-accent" : "border-transparent text-text-dim hover:text-text"
      }`}
    >
      {children}
    </button>
  );
}

function EditorTab({
  draft,
  setDraft,
  updateArg,
  addArg,
  removeArg,
  toggleTool,
  availableTools,
  error,
  saving,
  isNew,
  onSave,
  onCancel,
}: {
  draft: DraftState;
  setDraft: React.Dispatch<React.SetStateAction<DraftState>>;
  updateArg: (idx: number, patch: Partial<SkillArgument>) => void;
  addArg: () => void;
  removeArg: (idx: number) => void;
  toggleTool: (name: string) => void;
  availableTools: AvailableTool[];
  error: string | null;
  saving: boolean;
  isNew: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const set = (patch: Partial<DraftState>) => setDraft((d) => ({ ...d, ...patch }));

  return (
    <div className="space-y-5">
      <section className="border border-border rounded-lg bg-bg p-5 space-y-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">Identity</h3>
        <div>
          <div className="flex items-center gap-2 mb-1.5">
            <label className="text-sm font-medium">Name</label>
            <InfoTooltip
              title="Skill name"
              body="Display name. The skill's id (used by skill_load, e.g. 'weekly-review') is derived from it at creation and never changes."
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
              body="One-line summary the LLM reads when picking which tool to call. Be precise — vague descriptions get ignored."
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
            <label className="text-sm font-medium">Tags</label>
            <InfoTooltip
              title="Profiles"
              body="e.g. perso, cadens. In Devices, each client token can be limited to some tags — that token then only sees matching skills."
            />
          </div>
          <input
            type="text"
            value={draft.tags}
            onChange={(e) => set({ tags: e.target.value })}
            placeholder="perso, cadens"
            className="w-full bg-bg-muted border border-border rounded-md px-3 py-2 text-sm focus:border-accent focus:outline-none"
          />
        </div>
        <label className="flex items-start gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={draft.exposeAsTool}
            onChange={(e) => set({ exposeAsTool: e.target.checked })}
            className="mt-0.5"
          />
          <span>
            Also expose as a dedicated tool
            <span className="block text-xs text-text-dim">
              Off (recommended): clients load it with <code>skill_load</code>, keeping their tool
              list short. On: adds a <code>skill_&lt;id&gt;</code> tool for clients that ignore
              server instructions.
            </span>
          </span>
        </label>
      </section>

      <section className="border border-border rounded-lg bg-bg p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
            Instructions
          </h3>
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
              <span className="text-text-muted text-xs font-normal">
                markdown · use {`{{arg}}`} placeholders
              </span>
            </div>
            <textarea
              value={draft.content}
              onChange={(e) => set({ content: e.target.value })}
              rows={14}
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
      </section>

      <section className="border border-border rounded-lg bg-bg p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
              Arguments
            </h3>
            <p className="text-xs text-text-dim mt-0.5">
              Typed inputs the skill accepts. Reference them in the body with{" "}
              <code>{`{{name}}`}</code>.
            </p>
          </div>
          <button type="button" onClick={addArg} className="text-xs text-accent hover:underline">
            + Add argument
          </button>
        </div>
        {draft.arguments.length === 0 ? (
          <p className="text-xs text-text-muted">
            No arguments. Add one to accept input from the caller.
          </p>
        ) : (
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
        )}
      </section>

      <section className="border border-border rounded-lg bg-bg p-5 space-y-4">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
            Allowed tools{" "}
            <span className="text-text-dim font-normal normal-case">
              ({draft.toolsAllowed.length} selected)
            </span>
          </h3>
          <p className="text-xs text-text-dim mt-0.5">
            MCP tools this skill is allowed to invoke. Empty = inherit ambient surface at runtime.
          </p>
        </div>
        {availableTools.length === 0 ? (
          <p className="text-xs text-text-muted">No tools available yet.</p>
        ) : (
          <div className="max-h-64 overflow-y-auto border border-border rounded-md p-2 space-y-1 bg-bg-muted/40">
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
      </section>

      {error && (
        <div className="bg-red-bg border border-red/20 rounded-md p-3 text-xs text-red">
          {error}
        </div>
      )}

      <div className="flex items-center gap-3 pt-2">
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className="bg-accent text-white text-sm font-medium px-5 py-2 rounded-md hover:bg-accent/90 disabled:opacity-60"
        >
          {saving ? "Saving..." : isNew ? "Create skill" : "Save changes"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="text-sm font-medium px-4 py-2 rounded-md bg-bg-muted hover:bg-border-light text-text-dim"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function SettingsTab({
  skill,
  versions,
  currentVersion,
  versionsLoading,
  rollingBack,
  deleting,
  onRollback,
  onExportMarkdown,
  onDownloadZip,
  onDownloadRelay,
  onDelete,
}: {
  skill: Skill;
  versions: SkillVersionSummary[];
  currentVersion: number;
  versionsLoading: boolean;
  rollingBack: boolean;
  deleting: boolean;
  onRollback: (version: number) => void;
  onExportMarkdown: () => void;
  onDownloadZip: () => void;
  onDownloadRelay: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="space-y-5">
      <section className="border border-border rounded-lg bg-bg p-5 space-y-3">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
            Version history
          </h3>
          <p className="text-xs text-text-dim mt-0.5">
            Every save creates a new version. Roll back to any prior version — a new entry is
            written, the existing history is preserved.
          </p>
        </div>
        {versionsLoading ? (
          <p className="text-xs text-text-muted">Loading...</p>
        ) : versions.length === 0 ? (
          <p className="text-xs text-text-muted">No version history available.</p>
        ) : (
          <div className="space-y-2">
            {[...versions].reverse().map((v) => (
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
                {v.version !== currentVersion && (
                  <button
                    onClick={() => onRollback(v.version)}
                    disabled={rollingBack}
                    className="text-xs text-orange hover:underline shrink-0 disabled:opacity-50"
                  >
                    Rollback
                  </button>
                )}
                {v.version === currentVersion && (
                  <span className="text-[10px] font-medium text-green bg-green-bg px-1.5 py-0.5 rounded shrink-0">
                    current
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="border border-border rounded-lg bg-bg p-5 space-y-3">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">Export</h3>
          <p className="text-xs text-text-dim mt-0.5">
            Download this skill as an Agent Skills folder, or as a <strong>relay</strong> to upload
            once in claude.ai / ChatGPT (it triggers natively and always loads the live version from
            Kebab).
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onExportMarkdown}
            className="text-xs font-medium text-text-dim hover:text-text px-3 py-1.5 border border-border rounded-md"
          >
            Export as Markdown (.md)
          </button>
          <button
            type="button"
            onClick={onDownloadZip}
            className="text-xs font-medium text-text-dim hover:text-text px-3 py-1.5 border border-border rounded-md"
            title="SKILL.md + bundled files — uploadable to Claude, ChatGPT, Codex, Claude Code"
          >
            Download Agent Skill (.zip)
          </button>
          <button
            type="button"
            onClick={onDownloadRelay}
            className="text-xs font-medium text-text-dim hover:text-text px-3 py-1.5 border border-border rounded-md"
            title="Install once in claude.ai / ChatGPT: triggers natively, loads the live version from Kebab"
          >
            Download relay (.zip)
          </button>
        </div>
      </section>

      <section className="border border-border rounded-lg bg-bg p-5 space-y-3">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
            Metadata
          </h3>
        </div>
        <dl className="grid grid-cols-2 gap-3 text-xs">
          <div>
            <dt className="text-text-muted">ID</dt>
            <dd className="font-mono text-text">{skill.id}</dd>
          </div>
          <div>
            <dt className="text-text-muted">Tool name</dt>
            <dd className="font-mono text-text">skill_{skill.id}</dd>
          </div>
          <div>
            <dt className="text-text-muted">Created</dt>
            <dd className="text-text-dim">{new Date(skill.createdAt).toLocaleString()}</dd>
          </div>
          <div>
            <dt className="text-text-muted">Last updated</dt>
            <dd className="text-text-dim">{new Date(skill.updatedAt).toLocaleString()}</dd>
          </div>
        </dl>
      </section>

      <section className="border border-red/30 rounded-lg bg-red-bg/30 p-5 space-y-3">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-red">Danger zone</h3>
          <p className="text-xs text-text-dim mt-0.5">
            Deleting a skill removes it from the registry. Version history is also wiped — this
            cannot be undone.
          </p>
        </div>
        <button
          type="button"
          onClick={onDelete}
          disabled={deleting}
          className="text-xs font-medium text-red hover:underline disabled:opacity-60"
        >
          {deleting ? "Deleting..." : "Delete this skill"}
        </button>
      </section>
    </div>
  );
}
