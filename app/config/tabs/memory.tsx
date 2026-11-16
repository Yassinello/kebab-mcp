"use client";

import { useCallback, useEffect, useState } from "react";
import { formatRelativeTime } from "@/core/relative-time";

/**
 * 2026-11 audit (C1.3) — the Memory page: browse the notes vault by folder,
 * search it, read a note (shown as plain text — never injected as HTML),
 * see where it came from and when it last changed, and delete it.
 * Backed by /api/config/memory (admin only).
 */

type Provenance = "user" | "assistant" | "external";

interface FolderEntry {
  path: string;
  count: number;
}
interface NoteRow {
  path: string;
  name: string;
  size?: number;
  updatedAt?: string | null;
  snippet?: string;
  provenance?: Provenance | null;
}
interface NoteDetail {
  path: string;
  name: string;
  size: number;
  content: string;
  provenance: Provenance;
  updatedAt: string | null;
  change: { message: string; author: string } | null;
}

const PAGE_SIZE = 50;

const PROVENANCE: Record<Provenance, { label: string; hint: string; className: string }> = {
  user: {
    label: "Written by you",
    hint: "A note you wrote, or one without a source.",
    className: "text-text-dim bg-bg-muted border-border",
  },
  assistant: {
    label: "Saved by an AI client",
    hint: "Written by one of your AI clients when you asked it to remember something.",
    className: "text-accent bg-accent/5 border-accent/30",
  },
  external: {
    label: "From the web",
    hint: "Saved from a web page. Its content is not trusted as instructions.",
    className: "text-orange-dark bg-orange-bg border-orange/30",
  },
};

function ProvenanceBadge({ value }: { value: Provenance }) {
  const p = PROVENANCE[value] ?? PROVENANCE.user;
  return (
    <span
      title={p.hint}
      className={`inline-block text-[11px] font-medium px-2 py-0.5 rounded-full border ${p.className}`}
    >
      {p.label}
    </span>
  );
}

function folderLabel(path: string): string {
  return path === "" ? "Top level" : path;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "include" });
  const data = (await res.json().catch(() => ({}))) as T & { message?: string; error?: string };
  if (!res.ok) throw new Error(data.message || data.error || `Request failed (${res.status})`);
  return data;
}

export function MemoryTab() {
  const [overview, setOverview] = useState<{
    totalNotes: number;
    folders: FolderEntry[];
  } | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [folder, setFolder] = useState<string | null>(null);
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [total, setTotal] = useState(0);
  const [listLoading, setListLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState<string | null>(null);
  const [searchInfo, setSearchInfo] = useState<{ total: number; truncated: boolean } | null>(null);
  const [selected, setSelected] = useState<NoteDetail | null>(null);
  const [noteLoading, setNoteLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const loadOverview = useCallback(async () => {
    try {
      const d = await getJson<{ totalNotes: number; folders: FolderEntry[] }>(
        "/api/config/memory?view=folders"
      );
      const next = { totalNotes: d.totalNotes ?? 0, folders: d.folders ?? [] };
      setOverview(next);
      setOverviewError(null);
      return next;
    } catch (err) {
      setOverviewError(err instanceof Error ? err.message : "Could not load your memory.");
      return null;
    }
  }, []);

  const openFolder = useCallback(async (path: string, offset = 0) => {
    setFolder(path);
    setSearching(null);
    setSearchInfo(null);
    setError(null);
    setListLoading(true);
    try {
      const d = await getJson<{ total: number; notes: NoteRow[] }>(
        `/api/config/memory?folder=${encodeURIComponent(path)}&offset=${offset}&limit=${PAGE_SIZE}`
      );
      setNotes((prev) => (offset === 0 ? d.notes : [...prev, ...d.notes]));
      setTotal(d.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load this folder.");
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => {
    // fire-and-forget OK: errors are shown in the page. Opens the first
    // folder so the page never starts blank.
    void (async () => {
      const first = (await loadOverview())?.folders[0];
      if (first) await openFolder(first.path);
    })();
  }, [loadOverview, openFolder]);

  const runSearch = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const q = query.trim();
    if (!q) return;
    setFolder(null);
    setSearching(q);
    setError(null);
    setListLoading(true);
    try {
      const d = await getJson<{ totalCount: number; truncated: boolean; results: NoteRow[] }>(
        `/api/config/memory?q=${encodeURIComponent(q)}&limit=${PAGE_SIZE}`
      );
      setNotes(d.results);
      setTotal(d.results.length);
      setSearchInfo({ total: d.totalCount, truncated: d.truncated });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed.");
      setNotes([]);
    } finally {
      setListLoading(false);
    }
  };

  const openNote = async (path: string) => {
    setNoteLoading(true);
    setError(null);
    setStatus(null);
    try {
      setSelected(await getJson<NoteDetail>(`/api/config/memory?path=${encodeURIComponent(path)}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open this note.");
    } finally {
      setNoteLoading(false);
    }
  };

  const deleteNote = async (note: NoteDetail) => {
    const ok = window.confirm(
      `Delete "${note.path}"?\n\nYour AI clients will no longer find it. This cannot be undone from here.`
    );
    if (!ok) return;
    setError(null);
    try {
      const res = await fetch(`/api/config/memory?path=${encodeURIComponent(note.path)}`, {
        method: "DELETE",
        credentials: "include",
      });
      const data = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) throw new Error(data.message || "Could not delete this note.");
      setSelected(null);
      setNotes((prev) => prev.filter((n) => n.path !== note.path));
      setTotal((t) => Math.max(0, t - 1));
      setStatus(`Deleted ${note.path}.`);
      await loadOverview();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete this note.");
    }
  };

  if (overviewError && !overview) {
    return (
      <div className="border border-border rounded-lg p-5">
        <p className="text-sm font-medium">Your memory could not be loaded.</p>
        <p className="text-xs text-text-dim mt-1">{overviewError}</p>
        <p className="text-xs text-text-muted mt-2">
          Check the Memory Vault connector on the{" "}
          <a href="/config?tab=connectors" className="text-accent hover:underline">
            Connectors
          </a>{" "}
          page.
        </p>
      </div>
    );
  }
  if (!overview) return <p className="text-sm text-text-muted">Loading…</p>;

  if (overview.totalNotes === 0) {
    return (
      <div className="border border-border rounded-lg p-8 text-center" data-testid="memory-empty">
        <p className="text-base font-semibold">Nothing saved yet.</p>
        <p className="text-sm text-text-dim mt-1">
          Say “remember that…” in any connected AI client.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <form onSubmit={(e) => void runSearch(e)} className="flex gap-2" role="search">
        <label htmlFor="memory-search" className="sr-only">
          Search your notes
        </label>
        <input
          id="memory-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search your notes"
          maxLength={200}
          className="flex-1 bg-bg-muted border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
        />
        <button
          type="submit"
          disabled={!query.trim()}
          className="bg-accent text-white text-sm font-medium px-4 py-2 rounded-md hover:bg-accent/90 disabled:opacity-60"
        >
          Search
        </button>
      </form>

      {error && (
        <p className="text-xs text-red" role="alert">
          {error}
        </p>
      )}
      {status && (
        <p className="text-xs text-green" role="status">
          {status}
        </p>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[14rem_minmax(0,18rem)_minmax(0,1fr)] gap-4">
        {/* Folders */}
        <nav aria-label="Folders" className="border border-border rounded-lg p-2 self-start">
          <p className="text-xs font-medium text-text-dim px-2 py-1">
            {overview.totalNotes} {overview.totalNotes === 1 ? "note" : "notes"}
          </p>
          <ul className="space-y-0.5 max-h-[28rem] overflow-y-auto">
            {overview.folders.map((f) => (
              <li key={f.path || "(root)"}>
                <button
                  type="button"
                  onClick={() => void openFolder(f.path)}
                  aria-current={folder === f.path ? "true" : undefined}
                  className={`w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-md text-sm text-left ${
                    folder === f.path
                      ? "bg-accent/10 text-accent font-medium"
                      : "text-text-dim hover:bg-bg-muted hover:text-text"
                  }`}
                >
                  <span className="truncate">{folderLabel(f.path)}</span>
                  <span className="text-xs text-text-muted">{f.count}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>

        {/* Notes of the folder, or search results */}
        <div className="border border-border rounded-lg self-start min-h-[6rem]">
          <p className="text-xs font-medium text-text-dim px-3 py-2 border-b border-border">
            {searching
              ? `Results for “${searching}”${searchInfo ? ` · ${searchInfo.total}` : ""}`
              : folder !== null
                ? `${folderLabel(folder)} · ${total}`
                : "Pick a folder or search"}
          </p>
          {searchInfo?.truncated && (
            <p className="text-[11px] text-text-muted px-3 pt-2">
              Large memory: the search stopped early, refine your words to find more.
            </p>
          )}
          {listLoading && notes.length === 0 ? (
            <p className="text-xs text-text-muted px-3 py-3">Loading…</p>
          ) : notes.length === 0 && (searching || folder !== null) ? (
            <p className="text-xs text-text-muted px-3 py-3">No note here.</p>
          ) : (
            <ul className="divide-y divide-border max-h-[32rem] overflow-y-auto">
              {notes.map((n) => (
                <li key={n.path}>
                  <button
                    type="button"
                    onClick={() => void openNote(n.path)}
                    className={`w-full text-left px-3 py-2 hover:bg-bg-muted ${
                      selected?.path === n.path ? "bg-bg-muted" : ""
                    }`}
                  >
                    <span className="block text-sm text-text truncate">{n.name}</span>
                    {searching && (
                      <span className="block text-[11px] text-text-muted truncate">{n.path}</span>
                    )}
                    {n.snippet && (
                      <span className="block text-xs text-text-dim line-clamp-2">{n.snippet}</span>
                    )}
                    {n.updatedAt && (
                      <span className="block text-[11px] text-text-muted">
                        changed {formatRelativeTime(n.updatedAt)}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!searching && folder !== null && notes.length < total && (
            <div className="p-2 border-t border-border">
              <button
                type="button"
                disabled={listLoading}
                onClick={() => void openFolder(folder, notes.length)}
                className="w-full text-xs text-accent hover:underline disabled:opacity-50"
              >
                {listLoading ? "Loading…" : `Show more (${total - notes.length} left)`}
              </button>
            </div>
          )}
        </div>

        {/* Selected note */}
        <article
          className="border border-border rounded-lg p-4 self-start min-w-0"
          aria-live="polite"
        >
          {noteLoading ? (
            <p className="text-xs text-text-muted">Opening…</p>
          ) : !selected ? (
            <p className="text-xs text-text-muted">Pick a note to read it.</p>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="text-base font-semibold break-words">{selected.name}</h2>
                  <p className="text-[11px] text-text-muted break-all">{selected.path}</p>
                </div>
                <button
                  type="button"
                  onClick={() => void deleteNote(selected)}
                  className="text-xs font-medium px-3 py-1.5 rounded-md border border-red/30 text-red hover:bg-red-bg"
                >
                  Delete
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-text-dim">
                <ProvenanceBadge value={selected.provenance} />
                {selected.updatedAt && (
                  <span title={new Date(selected.updatedAt).toLocaleString()}>
                    Last changed {formatRelativeTime(selected.updatedAt)}
                    {selected.change?.message ? ` · ${selected.change.message}` : ""}
                  </span>
                )}
                <span>{(selected.size / 1024).toFixed(1)} KB</span>
              </div>
              <pre
                data-testid="note-content"
                className="whitespace-pre-wrap break-words bg-bg-muted border border-border rounded-md p-3 text-sm font-mono text-text max-h-[32rem] overflow-auto"
              >
                {selected.content}
              </pre>
            </div>
          )}
        </article>
      </div>
    </div>
  );
}
