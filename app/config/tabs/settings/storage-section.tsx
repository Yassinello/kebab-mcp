"use client";

import { useState, useEffect } from "react";

interface StorageStatus {
  backend: "upstash" | "vercel-api" | "filesystem" | "none";
  upstashConfigured: boolean;
  vercelApiConfigured: boolean;
  isVercel: boolean;
}

const BACKEND_LABELS: Record<string, { label: string; ok: boolean }> = {
  upstash: { label: "Upstash Redis", ok: true },
  "vercel-api": { label: "Vercel API", ok: true },
  filesystem: { label: "Filesystem", ok: true },
  none: { label: "Not configured", ok: false },
};

export function StorageSection() {
  const [status, setStatus] = useState<StorageStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState<"env" | "json" | null>(null);

  useEffect(() => {
    fetch("/api/config/storage-status", { credentials: "include" })
      .then((r) => r.json())
      .then((data) => setStatus(data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleExportEnv = async () => {
    setExporting("env");
    try {
      const res = await fetch("/api/config/env-export", {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Export failed");
      const text = await res.text();
      const blob = new Blob([text], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "mymcp-credentials.env";
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // silent — the button click itself is feedback enough
    }
    setExporting(null);
  };

  const handleExportJson = async () => {
    setExporting("json");
    try {
      const res = await fetch("/api/config/env?reveal=1", {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Export failed");
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "mymcp-backup.json";
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // silent
    }
    setExporting(null);
  };

  if (loading) {
    return <p className="text-sm text-text-muted">Loading storage info...</p>;
  }

  const info = status ? BACKEND_LABELS[status.backend] || BACKEND_LABELS.none : BACKEND_LABELS.none;

  return (
    <div className="space-y-5">
      {/* Current backend */}
      <div className="border border-border rounded-lg p-5 space-y-3">
        <h3 className="text-sm font-semibold">Credential storage</h3>
        <div className="flex items-center gap-2">
          <span
            className={`text-xs font-medium px-2 py-0.5 rounded-full ${
              info.ok ? "text-green bg-green-bg" : "text-orange bg-orange-bg"
            }`}
          >
            {info.label} {info.ok ? "\u2713" : "\u26A0"}
          </span>
        </div>
        {status?.isVercel && !status.upstashConfigured && (
          <p className="text-xs text-text-dim">
            On Vercel without Upstash, credentials saved from the dashboard won&apos;t persist
            across cold starts.{" "}
            <a
              href="https://vercel.com/integrations/upstash"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent underline underline-offset-2"
            >
              Set up Upstash
            </a>{" "}
            for instant, persistent storage.
          </p>
        )}
        {!status?.isVercel && (
          <p className="text-xs text-text-dim">
            Credentials are saved to the local .env file on disk.
          </p>
        )}
        {status?.backend === "upstash" && (
          <p className="text-xs text-text-dim">
            Credentials are stored in Upstash Redis. Changes take effect immediately without
            redeploy.
          </p>
        )}
        {status?.backend === "vercel-api" && (
          <p className="text-xs text-text-dim">
            Credentials are saved via Vercel API. A redeploy is triggered after each save (~30s).
          </p>
        )}
      </div>

      {/* Export */}
      <div className="border border-border rounded-lg p-5 space-y-3">
        <h3 className="text-sm font-semibold">Export</h3>
        <p className="text-xs text-text-dim">
          Download all credentials and settings for backup or migration.
        </p>
        <div className="flex items-center gap-3">
          <button
            onClick={handleExportEnv}
            disabled={exporting === "env"}
            className="text-sm font-medium px-4 py-1.5 rounded-md bg-bg-muted hover:bg-border-light text-text-dim hover:text-text border border-border disabled:opacity-60"
          >
            {exporting === "env" ? "Exporting..." : "Export as .env"}
          </button>
          <button
            onClick={handleExportJson}
            disabled={exporting === "json"}
            className="text-sm font-medium px-4 py-1.5 rounded-md bg-bg-muted hover:bg-border-light text-text-dim hover:text-text border border-border disabled:opacity-60"
          >
            {exporting === "json" ? "Exporting..." : "Export backup (JSON)"}
          </button>
        </div>
      </div>
    </div>
  );
}
