"use client";

import { useState, useEffect, useCallback } from "react";
import { InfoTooltip } from "./settings/info-tooltip";
import { ImportSkillModal } from "./skills-import-modal";
import { SkillComposer } from "./skill-composer";

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

interface Skill {
  id: string;
  name: string;
  description: string;
  content: string;
  arguments: SkillArgument[];
  source: SkillSource;
  createdAt: string;
  updatedAt: string;
}

interface DraftState {
  editingId: string | null; // null = creating new
  name: string;
  description: string;
  mode: "inline" | "remote";
  content: string;
  url: string;
  arguments: SkillArgument[];
}

const emptyDraft = (): DraftState => ({
  editingId: null,
  name: "",
  description: "",
  mode: "inline",
  content: "",
  url: "",
  arguments: [],
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

  /** Client-side export to Claude Desktop .skill format (JSON). */
  const exportClaudeSkill = (skill: Skill) => {
    const body =
      skill.content || (skill.source.type === "remote" ? skill.source.cachedContent || "" : "");
    const payload = {
      name: skill.name,
      description: skill.description || skill.name,
      content: body,
      metadata: {
        source: "mymcp",
        version: "1.0",
        exportedAt: new Date().toISOString(),
      },
    };
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
        <p className="text-sm text-text-dim">
          Author reusable skills (prompts + templates) — exposed as MCP tools and prompts.
        </p>
        <div className="flex items-center gap-2">
          {flash && (
            <span className="text-[11px] font-medium text-green bg-green-bg px-2 py-0.5 rounded-full">
              {flash}
            </span>
          )}
          {!draft && !composerOpen && (
            <>
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
        />
      )}

      {skills.length === 0 && !draft && (
        <div className="border border-border rounded-lg p-8 text-center">
          <p className="text-sm text-text-dim">
            No skills defined yet. Click <strong>+ New skill</strong> to create your first one.
          </p>
        </div>
      )}

      {skills.map((skill) => (
        <div
          key={skill.id}
          className="border border-border rounded-lg overflow-hidden hover:border-border-light transition-colors"
        >
          <div className="flex items-center gap-3 px-5 py-4">
            <div className="w-9 h-9 rounded-lg bg-accent/10 flex items-center justify-center text-accent font-bold text-sm">
              {skill.name.charAt(0).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="font-semibold text-sm">{skill.name}</p>
                <code className="text-[11px] text-text-muted">skill_{skill.id}</code>
                <span
                  className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${
                    skill.source.type === "remote"
                      ? "text-accent bg-accent/10"
                      : "text-text-muted bg-bg-muted"
                  }`}
                >
                  {skill.source.type}
                </span>
                {versionMap[skill.id] != null && versionMap[skill.id] > 0 && (
                  <span className="text-[11px] font-medium px-2 py-0.5 rounded-full text-text-muted bg-bg-muted">
                    v{versionMap[skill.id]}
                  </span>
                )}
                {skill.source.type === "remote" && skill.source.lastError && (
                  <span className="text-[11px] font-medium text-red bg-red-bg px-2 py-0.5 rounded-full">
                    fetch error
                  </span>
                )}
              </div>
              <p className="text-xs text-text-dim mt-0.5 truncate">
                {skill.description || <em className="text-text-muted">no description</em>}
              </p>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {skill.source.type === "remote" && (
                <button
                  onClick={() => refreshSkill(skill.id)}
                  disabled={refreshing === skill.id}
                  className="text-xs text-text-dim hover:text-accent px-2 py-1 rounded disabled:opacity-60"
                  title="Re-fetch remote content"
                >
                  {refreshing === skill.id ? "..." : "Refresh"}
                </button>
              )}
              <button
                onClick={() => toggleHistory(skill.id)}
                className="text-xs text-text-dim hover:text-accent px-2 py-1 rounded"
                title="View version history"
              >
                History
              </button>
              <button
                onClick={() => exportSkill(skill.id)}
                className="text-xs text-text-dim hover:text-accent px-2 py-1 rounded"
                title="Download as Markdown (.md)"
              >
                Export
              </button>
              <button
                onClick={() => exportClaudeSkill(skill)}
                className="text-xs text-text-dim hover:text-accent px-2 py-1 rounded"
                title="Download as Claude Desktop Skill (.skill)"
              >
                Claude
              </button>
              <button
                onClick={() => startEdit(skill)}
                className="text-xs text-accent hover:underline px-2 py-1 rounded"
              >
                Edit
              </button>
              <button
                onClick={() => deleteSkill(skill.id)}
                className="text-xs text-red hover:underline px-2 py-1 rounded"
              >
                Delete
              </button>
            </div>
          </div>
          {historyOpen === skill.id && (
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
                      <span className="font-mono font-medium text-accent shrink-0">
                        v{v.version}
                      </span>
                      <span className="text-text-muted shrink-0">
                        {new Date(v.savedAt).toLocaleString()}
                      </span>
                      <span className="text-text-dim flex-1 truncate">
                        {v.contentPreview || "(empty)"}
                      </span>
                      {v.version !== versionMap[skill.id] && (
                        <button
                          onClick={() => rollbackTo(skill.id, v.version)}
                          disabled={rollingBack}
                          className="text-xs text-orange hover:underline shrink-0 disabled:opacity-50"
                        >
                          Rollback
                        </button>
                      )}
                      {v.version === versionMap[skill.id] && (
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
      ))}
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
}) {
  const set = (patch: Partial<DraftState>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  return (
    <div className="border border-accent/30 rounded-lg bg-bg p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-sm">{draft.editingId ? "Edit skill" : "New skill"}</h3>
        <button onClick={onCancel} className="text-xs text-text-dim hover:text-text">
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
            body="Inline = the prompt body lives in MyMCP's KV store; edit it from this form anytime. Remote = MyMCP fetches the markdown from a URL on each invocation (with caching). Use Remote for skills shared across deployments; use Inline for personal skills you tweak often."
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
