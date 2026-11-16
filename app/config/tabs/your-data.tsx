"use client";

import { useRef, useState } from "react";

/** Plain-words labels for the import report fields we know; others are shown as-is. */
const LABELS: Record<string, string> = {
  profiles: "Profiles",
  skills: "Skills",
  notes: "Notes",
  warnings: "Warnings",
  created: "added",
  updated: "updated",
  failed: "failed",
  written: "saved",
  skipped: "skipped (already there)",
  unchanged: "unchanged",
};

function humanize(key: string): string {
  if (LABELS[key]) return LABELS[key]!;
  const spaced = key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

function scalar(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v === null || v === undefined) return "—";
  return JSON.stringify(v);
}

/**
 * Render an import report whatever its shape: numbers, nested counters
 * ({created, updated, failed}), lists (warnings) and anything else as text.
 * The export route may add fields over time; nothing is dropped.
 */
export function ImportReportView({ report }: { report: Record<string, unknown> }) {
  return (
    <dl
      className="text-xs grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5"
      data-testid="import-report"
    >
      {Object.entries(report).map(([key, value]) => (
        <ReportRow key={key} name={key} value={value} />
      ))}
    </dl>
  );
}

function ReportRow({ name, value }: { name: string; value: unknown }) {
  let body: React.ReactNode;
  if (Array.isArray(value)) {
    body =
      value.length === 0 ? (
        "none"
      ) : (
        <ul className="list-disc pl-4 space-y-0.5">
          {value.slice(0, 50).map((item, i) => (
            <li key={i} className="break-words">
              {scalar(item)}
            </li>
          ))}
          {value.length > 50 && <li>…and {value.length - 50} more</li>}
        </ul>
      );
  } else if (value && typeof value === "object") {
    body = Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${scalar(v)} ${humanize(k).toLowerCase()}`)
      .join(", ");
  } else {
    body = scalar(value);
  }
  return (
    <>
      <dt className="font-medium text-text">{humanize(name)}</dt>
      <dd className="text-text-dim">{body}</dd>
    </>
  );
}

/**
 * C1.4 — "Your data": export everything, or import a backup made by the
 * export (POST /api/config/export with the zip as the body).
 */
export function YourDataSection({ onImported }: { onImported?: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<Record<string, unknown> | null>(null);

  const runImport = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      const res = await fetch(`/api/config/export${overwrite ? "?overwriteNotes=1" : ""}`, {
        method: "POST",
        headers: { "Content-Type": "application/zip" },
        credentials: "include",
        body: file,
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        report?: Record<string, unknown>;
        message?: string;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        setError(data.message || data.error || `Import failed (${res.status})`);
      } else {
        setReport(data.report ?? {});
        setFile(null);
        if (fileRef.current) fileRef.current.value = "";
        onImported?.();
      }
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="border border-border rounded-lg p-5 space-y-4" aria-labelledby="data-title">
      <h2 id="data-title" className="text-base font-semibold">
        Your data
      </h2>
      <div>
        <a
          href="/api/config/export"
          download
          className="inline-block bg-bg border border-border hover:bg-bg-muted text-text text-xs font-medium px-3 py-1.5 rounded-md"
        >
          Export everything (.zip)
        </a>
        <p className="text-xs text-text-muted mt-2">
          Profiles, skills, your memory (Markdown notes, opens in Obsidian) and settings. Secrets,
          keys and devices are never included.
        </p>
      </div>
      <div className="border-t border-border pt-4 space-y-2">
        <label htmlFor="import-zip" className="text-sm font-medium block">
          Import a backup (.zip)
        </label>
        <input
          id="import-zip"
          ref={fileRef}
          type="file"
          accept=".zip,application/zip"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setReport(null);
            setError(null);
          }}
          className="block text-xs text-text-dim file:mr-3 file:px-3 file:py-1.5 file:rounded-md file:border file:border-border file:bg-bg file:text-text file:text-xs file:font-medium"
        />
        <label className="flex items-center gap-2 text-xs text-text-dim">
          <input
            type="checkbox"
            checked={overwrite}
            onChange={(e) => setOverwrite(e.target.checked)}
          />
          Overwrite existing notes
        </label>
        <p className="text-xs text-text-muted">
          Adds the profiles, skills and notes of an export. Nothing is deleted. Existing notes are
          kept unless you tick the box.
        </p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={!file || busy}
            onClick={() => void runImport()}
            className="bg-bg border border-border hover:bg-bg-muted text-text text-xs font-medium px-3 py-1.5 rounded-md disabled:opacity-60"
          >
            {busy ? "Importing…" : "Import"}
          </button>
          {error && <span className="text-xs text-red">{error}</span>}
        </div>
        {report && (
          <div
            className="border border-green/30 bg-green-bg rounded-md p-3 space-y-2"
            role="status"
          >
            <p className="text-xs font-semibold text-green">Import finished</p>
            <ImportReportView report={report} />
          </div>
        )}
      </div>
    </section>
  );
}
