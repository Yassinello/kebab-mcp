"use client";

import { useCallback, useEffect, useState } from "react";
import { formatRelativeTime } from "@/core/relative-time";

interface HistoryEntry {
  savedAt: string;
  replacedAt?: string;
  bytes: number;
  content: string;
  by?: string;
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Unknown date";
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * 2026-11 audit (C1.2) — saved versions of one profile, newest first, with
 * "View" and "Restore this version". A restore is a normal save, so the
 * text it replaces appears at the top of the list afterwards.
 */
export function ProfileHistory({
  name,
  refreshKey,
  onRestored,
}: {
  name: string;
  /** Changes whenever the profile was saved elsewhere on the page. */
  refreshKey?: number | string;
  onRestored?: () => void;
}) {
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/config/profiles?name=${encodeURIComponent(name)}&history=1`, {
        credentials: "include",
      });
      if (!res.ok) {
        setHistory([]);
        return;
      }
      const data = (await res.json()) as { history?: HistoryEntry[] };
      setHistory(Array.isArray(data.history) ? data.history : []);
    } catch {
      setHistory([]);
    }
  }, [name]);

  useEffect(() => {
    // fire-and-forget OK: errors leave an empty history list
    void load();
  }, [load, refreshKey]);

  const restore = async (index: number, entry: HistoryEntry) => {
    const ok = window.confirm(
      `Restore the version saved ${formatWhen(entry.savedAt)}?\n\nIt replaces the current profile. The current text is kept in the history, so you can undo this.`
    );
    if (!ok) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/config/profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ action: "restore", name, index }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { message?: string };
        setMessage(data.message || "Could not restore this version.");
      } else {
        setMessage("Version restored.");
        setOpen(null);
        await load();
        onRestored?.();
      }
    } catch {
      setMessage("Network error");
    } finally {
      setBusy(false);
    }
  };

  if (history === null) return <p className="text-xs text-text-muted">Loading history…</p>;

  return (
    <div>
      <h3 className="text-sm font-medium mb-1.5">History</h3>
      {history.length === 0 ? (
        <p className="text-xs text-text-muted">
          No earlier version yet. Each time this profile changes, the previous text is kept here
          (last 10 versions).
        </p>
      ) : (
        <ul className="divide-y divide-border border border-border rounded-md">
          {history.map((h, i) => (
            <li key={`${h.savedAt}-${i}`} className="px-3 py-2 text-xs">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-medium text-text">{formatWhen(h.savedAt)}</span>
                <span className="text-text-muted">
                  {formatRelativeTime(h.savedAt)}
                  {h.by ? ` · by ${h.by}` : ""} · {formatSize(h.bytes)}
                </span>
                <span className="ml-auto flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setOpen(open === i ? null : i)}
                    aria-expanded={open === i}
                    className="text-accent hover:underline"
                  >
                    {open === i ? "Hide" : "View"}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void restore(i, h)}
                    className="text-accent hover:underline disabled:opacity-50"
                  >
                    Restore this version
                  </button>
                </span>
              </div>
              {open === i && (
                <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words bg-bg-muted border border-border rounded p-2 font-mono text-[12px] text-text">
                  {h.content}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}
      {message && (
        <p className="text-xs text-text-dim mt-1.5" role="status">
          {message}
        </p>
      )}
    </div>
  );
}
