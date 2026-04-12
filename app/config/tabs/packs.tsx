"use client";

import { useState, useEffect, useCallback, type ReactNode } from "react";
import type { PackSummary } from "../tabs";
import { PACKS, CredentialInput, normalizeGitHubRepo } from "../../setup/wizard";

export function PacksTab({ packs }: { packs: PackSummary[] }) {
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

  // Load current env on mount
  useEffect(() => {
    fetch("/api/config/env", { credentials: "include" })
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) setEnvVars(data.vars || {});
      })
      .finally(() => setLoading(false));
  }, []);

  const getValue = useCallback(
    (key: string) => {
      if (key in edits) return edits[key];
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
      setTestResults((p) => ({ ...p, [packId]: data }));
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
    const packDef = PACKS.find((p) => p.id === packId);
    if (!packDef) return;
    const vars: Record<string, string> = {};
    for (const v of packDef.vars) {
      const edited = edits[v.key];
      if (edited !== undefined && edited !== "" && !edited.includes("•")) {
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
        setSavedFlash(packId);
        setTimeout(() => setSavedFlash(null), 2000);
      } else {
        alert(data.error || "Save failed");
      }
    } catch {
      alert("Network error");
    }
    setSavingId(null);
  };

  const togglePack = async (packId: string, enable: boolean) => {
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
      }
    } catch {
      alert("Failed to toggle pack");
    }
  };

  if (loading) {
    return <p className="text-sm text-text-muted">Loading packs...</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm text-text-dim">
          Toggle packs on/off, edit credentials, and test connections.
        </p>
        <a
          href="/setup?add="
          className="text-xs font-medium text-accent hover:underline px-3 py-1.5 border border-accent/20 rounded-md"
        >
          + Add pack
        </a>
      </div>

      {packs.map((pack) => {
        const packDef = PACKS.find((p) => p.id === pack.id);
        const isOpen = expanded === pack.id;
        const test = testResults[pack.id];
        return (
          <div
            key={pack.id}
            className={`border rounded-lg overflow-hidden transition-colors ${pack.enabled ? "border-accent/30" : "border-border"}`}
          >
            <div className="flex items-center gap-3 px-5 py-4">
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
                    className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${pack.enabled ? "text-green bg-green-bg" : "text-text-muted bg-bg-muted"}`}
                  >
                    {pack.enabled ? "Active" : "Inactive"}
                  </span>
                  <span className="text-[11px] text-text-muted">{pack.toolCount} tools</span>
                  {savedFlash === pack.id && (
                    <span className="text-[11px] font-medium text-green bg-green-bg px-2 py-0.5 rounded-full">
                      Saved
                    </span>
                  )}
                </div>
                <p className="text-xs text-text-dim mt-0.5">
                  {pack.enabled ? pack.description : `${pack.description} — ${pack.reason}`}
                </p>
              </div>
              {packDef && (
                <button
                  onClick={() => setExpanded(isOpen ? null : pack.id)}
                  className="text-xs text-accent hover:underline px-3 py-1 rounded"
                >
                  {isOpen ? "Close" : "Edit"}
                </button>
              )}
              <button
                onClick={() => togglePack(pack.id, !pack.enabled)}
                className={`w-11 h-6 rounded-full transition-colors relative shrink-0 ${
                  pack.enabled ? "bg-accent" : "bg-bg-muted border border-border"
                }`}
                title={pack.enabled ? "Disable pack" : "Enable pack"}
              >
                <div
                  className={`w-4 h-4 rounded-full bg-white shadow-sm absolute top-1 transition-all ${
                    pack.enabled ? "left-6" : "left-1"
                  }`}
                />
              </button>
            </div>

            {isOpen && packDef && (
              <div className="border-t border-border bg-bg px-5 py-4 space-y-4">
                {pack.guide && <PackGuide markdown={pack.guide} />}
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
                <div className="flex items-center gap-3 pt-2">
                  <button
                    onClick={() => savePack(pack.id)}
                    disabled={savingId === pack.id}
                    className="bg-accent text-white text-sm font-medium px-4 py-1.5 rounded-md hover:bg-accent/90 disabled:opacity-60"
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
                </div>
                {test && !test.ok && test.detail && (
                  <div className="bg-red-bg border border-red/20 rounded-md p-3 text-xs font-mono text-red break-all">
                    {test.detail}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Lightweight markdown renderer for per-pack guides ─────────────────
// We intentionally avoid pulling in a full markdown library. The guide
// strings are authored by the framework (not user input), so we only
// need to support a tiny subset: headings, bold, inline code, links,
// ordered lists, italics, and paragraphs. Everything is escaped first.

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderInline(text: string): string {
  let out = escapeHtml(text);
  // links: [label](url)
  out = out.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer" class="text-accent hover:underline">$1</a>'
  );
  // inline code `x`
  out = out.replace(
    /`([^`]+)`/g,
    '<code class="text-[11px] bg-bg-muted px-1 py-0.5 rounded">$1</code>'
  );
  // bold **x**
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // italic _x_
  out = out.replace(/(^|\s)_([^_]+)_/g, '$1<em class="text-text-dim">$2</em>');
  return out;
}

function PackGuide({ markdown }: { markdown: string }) {
  const lines = markdown.split("\n");
  const blocks: ReactNode[] = [];
  let listBuffer: string[] = [];
  let key = 0;

  const flushList = () => {
    if (listBuffer.length === 0) return;
    const items = listBuffer.slice();
    listBuffer = [];
    blocks.push(
      <ol
        key={`list-${key++}`}
        className="list-decimal list-inside space-y-1 text-xs text-text-dim"
      >
        {items.map((item, i) => (
          <li key={i} dangerouslySetInnerHTML={{ __html: renderInline(item) }} />
        ))}
      </ol>
    );
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const listMatch = line.match(/^\s*\d+\.\s+(.*)$/);
    if (listMatch) {
      listBuffer.push(listMatch[1]);
      continue;
    }
    flushList();

    if (line.trim() === "") continue;

    const h3 = line.match(/^###\s+(.*)$/);
    if (h3) {
      blocks.push(
        <h4 key={`h-${key++}`} className="text-sm font-semibold mt-3">
          {h3[1]}
        </h4>
      );
      continue;
    }
    blocks.push(
      <p
        key={`p-${key++}`}
        className="text-xs text-text-dim leading-relaxed"
        dangerouslySetInnerHTML={{ __html: renderInline(line) }}
      />
    );
  }
  flushList();

  return (
    <div className="rounded-md border border-border bg-bg-muted/40 px-4 py-3 space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
          Credential guide
        </p>
      </div>
      {blocks}
    </div>
  );
}
