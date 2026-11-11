"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * Skills v2 — bundled files editor (scripts/, references/, templates…).
 * Loads + saves the whole file set through /api/config/skills/[id]/files.
 * Text files only; limits mirror the server (30 files, 100 KB each, 512 KB total).
 */

const MAX_FILES = 30;
const MAX_FILE_BYTES = 100 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024;

function bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

function kb(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

export function SkillFilesEditor({ skillId, agentName }: { skillId: string; agentName: string }) {
  const [files, setFiles] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [newPath, setNewPath] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/config/skills/${skillId}/files`, { credentials: "include" });
      const data = (await res.json()) as { files?: Record<string, string>; error?: string };
      const f = data.files ?? {};
      setFiles(f);
      setSaved(f);
      setSelected(Object.keys(f).sort()[0] ?? null);
    } catch {
      setError("Failed to load files");
    } finally {
      setLoading(false);
    }
  }, [skillId]);

  useEffect(() => {
    void load();
  }, [load]);

  const paths = useMemo(() => Object.keys(files).sort(), [files]);
  const total = useMemo(() => paths.reduce((n, p) => n + bytes(files[p] ?? ""), 0), [paths, files]);
  const dirty = JSON.stringify(files) !== JSON.stringify(saved);

  const addFile = () => {
    const p = newPath.trim().replace(/^\.?\//, "");
    if (!p) return;
    if (files[p] !== undefined) {
      setSelected(p);
      setNewPath("");
      return;
    }
    if (paths.length >= MAX_FILES) {
      setError(`Max ${MAX_FILES} files per skill.`);
      return;
    }
    setFiles((f) => ({ ...f, [p]: "" }));
    setSelected(p);
    setNewPath("");
    setError(null);
  };

  const removeFile = (p: string) => {
    if (!confirm(`Delete ${p}?`)) return;
    setFiles((f) => {
      const next = { ...f };
      delete next[p];
      return next;
    });
    setSelected((s) => (s === p ? null : s));
  };

  const onUpload = async (list: FileList | null) => {
    if (!list) return;
    const next = { ...files };
    for (const file of Array.from(list)) {
      if (file.size > MAX_FILE_BYTES) {
        setError(`${file.name} is larger than ${kb(MAX_FILE_BYTES)}.`);
        continue;
      }
      next[`references/${file.name}`] = await file.text();
    }
    setFiles(next);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/config/skills/${skillId}/files`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ files }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Save failed");
      } else {
        setSaved(files);
        setFlash("Files saved");
        setTimeout(() => setFlash(null), 2000);
      }
    } catch {
      setError("Network error");
    }
    setSaving(false);
  };

  const current = selected !== null ? files[selected] : undefined;
  const currentBytes = current !== undefined ? bytes(current) : 0;

  return (
    <section className="border border-border rounded-lg bg-bg p-5 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
            Bundled files{" "}
            <span className="normal-case font-normal text-text-dim">
              ({paths.length}/{MAX_FILES} · {kb(total)} / {kb(MAX_TOTAL_BYTES)})
            </span>
          </h3>
          <p className="text-xs text-text-dim mt-0.5">
            Reference docs, templates or scripts the skill can point to (e.g.{" "}
            <code>references/style.md</code>, <code>scripts/report.py</code>). Clients read them on
            demand with <code>skill_read_file(&quot;{agentName}&quot;, path)</code>, so they cost
            nothing until needed. Text files only.
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
            onClick={save}
            disabled={!dirty || saving}
            className="text-xs font-medium text-accent px-3 py-1.5 border border-accent/30 rounded-md disabled:opacity-50"
          >
            {saving ? "Saving..." : dirty ? "Save files" : "Saved"}
          </button>
        </div>
      </div>

      {error && <p className="text-xs text-red">{error}</p>}

      {loading ? (
        <p className="text-xs text-text-muted">Loading...</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-3">
          <div className="space-y-2">
            <div className="border border-border rounded-md divide-y divide-border max-h-72 overflow-auto">
              {paths.length === 0 && (
                <p className="text-xs text-text-muted px-3 py-2">No files yet.</p>
              )}
              {paths.map((p) => (
                <div
                  key={p}
                  className={`flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer ${
                    selected === p ? "bg-accent/10 text-text" : "text-text-dim hover:bg-bg-muted"
                  }`}
                  onClick={() => setSelected(p)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => e.key === "Enter" && setSelected(p)}
                >
                  <span className="font-mono truncate flex-1" title={p}>
                    {p}
                  </span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeFile(p);
                    }}
                    className="text-text-muted hover:text-red"
                    aria-label={`Delete ${p}`}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <div className="flex gap-1">
              <input
                value={newPath}
                onChange={(e) => setNewPath(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addFile()}
                placeholder="references/notes.md"
                className="flex-1 min-w-0 bg-bg-muted border border-border rounded-md px-2 py-1 text-xs font-mono focus:border-accent focus:outline-none"
              />
              <button
                type="button"
                onClick={addFile}
                className="text-xs px-2 py-1 border border-border rounded-md text-text-dim hover:text-text"
              >
                Add
              </button>
            </div>
            <label className="block text-xs text-text-dim cursor-pointer hover:text-text">
              <input
                type="file"
                multiple
                className="hidden"
                onChange={(e) => void onUpload(e.target.files)}
              />
              ↑ Upload text files (→ references/)
            </label>
          </div>

          <div>
            {selected !== null && current !== undefined ? (
              <>
                <div className="flex items-center justify-between mb-1">
                  <code className="text-xs text-text-dim">{selected}</code>
                  <span
                    className={`text-[11px] ${currentBytes > MAX_FILE_BYTES ? "text-red" : "text-text-muted"}`}
                  >
                    {kb(currentBytes)}
                  </span>
                </div>
                <textarea
                  value={current}
                  onChange={(e) => setFiles((f) => ({ ...f, [selected]: e.target.value }))}
                  spellCheck={false}
                  className="w-full h-72 bg-bg-muted border border-border rounded-md px-3 py-2 text-xs font-mono focus:border-accent focus:outline-none"
                />
              </>
            ) : (
              <div className="h-72 border border-dashed border-border rounded-md flex items-center justify-center text-xs text-text-muted">
                Select or add a file
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
