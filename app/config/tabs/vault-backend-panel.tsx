"use client";

/**
 * Kebab House phase 2 (VLT-04, VLT-06) — vault backend panel, shown inside
 * the Memory Vault connector card.
 *
 * - Says where the notes live (KV or GitHub) and why.
 * - "Import GitHub vault into KV": copies the GitHub repo's Markdown files
 *   into the KV backend (POST /api/admin/vault) and shows the report.
 *   Notes that exist in both with different content are kept unless the
 *   "Overwrite notes that exist in both" box is ticked (confirmed in a
 *   dialog) — B2, 2026-11 audit. Switching backend afterwards stays an
 *   explicit choice (env var).
 * - "Rebuild index": rebuilds the KV vault index from the stored notes.
 */

import { useCallback, useEffect, useState } from "react";

interface VaultStatus {
  ok: boolean;
  backend?: "github" | "kv";
  reason?: "forced" | "github-credentials" | "default";
  githubConfigured?: boolean;
  kv?: { notes: number; totalBytes: number };
}

interface ImportReport {
  totalFiles: number;
  copied: number;
  overwritten?: number;
  keptCount?: number;
  kept?: string[];
  unchanged: number;
  skippedCount: number;
  tooLargeCount: number;
  failedCount: number;
  incomplete: boolean;
  remaining: number;
  tooLarge: Array<{ path: string; size: number }>;
  failed: Array<{ path: string; error: string }>;
}

function describeBackend(s: VaultStatus): string {
  if (s.backend === "github") {
    return s.reason === "forced"
      ? "Notes live in your GitHub repository (KEBAB_VAULT_BACKEND=github)."
      : "Notes live in your GitHub repository (GITHUB_PAT and GITHUB_REPO are set).";
  }
  return s.reason === "forced"
    ? "Notes live in this instance's KV store (KEBAB_VAULT_BACKEND=kv)."
    : "Notes live in this instance's KV store (no GitHub repository configured).";
}

export function VaultBackendPanel() {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [busy, setBusy] = useState<"import" | "reindex" | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [overwrite, setOverwrite] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/vault", { credentials: "include" });
      const data = (await res.json()) as VaultStatus;
      setStatus(data && data.ok && data.backend ? data : null);
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    // fire-and-forget OK: initial status load; errors are handled inside load().
    void load();
  }, [load]);

  async function post(action: "import-github" | "rebuild-index") {
    if (
      action === "import-github" &&
      overwrite &&
      !window.confirm(
        "Notes that exist both on GitHub and here will be replaced by the GitHub version. " +
          "Changes made here since the last import will be lost. Continue?"
      )
    ) {
      return;
    }
    setBusy(action === "import-github" ? "import" : "reindex");
    setError(null);
    setInfo(null);
    if (action === "import-github") setReport(null);
    try {
      const res = await fetch("/api/admin/vault", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(action === "import-github" ? { action, overwrite } : { action }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        message?: string;
        hint?: string;
        report?: ImportReport;
        notes?: number;
      };
      if (!res.ok || !data.ok) {
        setError(data.message || data.hint || `Request failed (${res.status})`);
        return;
      }
      if (data.report) setReport(data.report);
      if (action === "rebuild-index") setInfo(`Index rebuilt: ${data.notes ?? 0} notes.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(null);
    }
  }

  if (!status) return null;
  const kvNotes = status.kv?.notes ?? 0;
  const kvKB = Math.round((status.kv?.totalBytes ?? 0) / 1024);

  return (
    <div className="rounded-md border border-border bg-bg-muted/40 p-3 space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">
        Where your notes live
      </p>
      <p className="text-sm">{describeBackend(status)}</p>
      <p className="text-xs text-text-dim">
        KV vault: {kvNotes} note{kvNotes === 1 ? "" : "s"}, {kvKB} KB.
      </p>
      {status.githubConfigured && (
        <label className="flex items-center gap-2 text-xs text-text-dim">
          <input
            type="checkbox"
            checked={overwrite}
            onChange={(e) => setOverwrite(e.target.checked)}
            disabled={busy !== null}
          />
          Overwrite notes that exist in both (otherwise they are kept as they are here)
        </label>
      )}
      <div className="flex items-center gap-2 flex-wrap pt-1">
        {status.githubConfigured && (
          <button
            onClick={() => post("import-github")}
            disabled={busy !== null}
            className="text-sm font-medium px-3 py-1.5 rounded-md bg-bg-muted hover:bg-border-light text-text-dim hover:text-text disabled:opacity-60"
          >
            {busy === "import" ? "Importing..." : "Import GitHub vault into KV"}
          </button>
        )}
        <button
          onClick={() => post("rebuild-index")}
          disabled={busy !== null}
          className="text-sm font-medium px-3 py-1.5 rounded-md bg-bg-muted hover:bg-border-light text-text-dim hover:text-text disabled:opacity-60"
        >
          {busy === "reindex" ? "Rebuilding..." : "Rebuild index"}
        </button>
      </div>
      {report && (
        <div className="text-xs space-y-1">
          <p>
            Import: {report.copied} imported, {report.overwritten ?? 0} overwritten,{" "}
            {report.keptCount ?? 0} kept (different here), {report.unchanged} unchanged,{" "}
            {report.skippedCount} skipped (not Markdown or reserved path), {report.tooLargeCount}{" "}
            too large (over 256 KB)
            {report.failedCount > 0 ? `, ${report.failedCount} failed` : ""} — {report.totalFiles}{" "}
            files in the repository.
          </p>
          {(report.keptCount ?? 0) > 0 && (
            <p className="text-text-dim">
              Kept as they are here: {(report.kept ?? []).join(", ")}. Tick &quot;Overwrite notes
              that exist in both&quot; to replace them with the GitHub version.
            </p>
          )}
          {report.incomplete && (
            <p className="text-orange">
              Stopped by the time limit: {report.remaining} notes left. Click Import again to
              continue (already copied notes are skipped).
            </p>
          )}
          {report.tooLarge.length > 0 && (
            <p className="text-text-dim">
              Too large: {report.tooLarge.map((t) => t.path).join(", ")}
            </p>
          )}
          {report.failed.length > 0 && (
            <p className="text-red">Failed: {report.failed.map((f) => f.path).join(", ")}</p>
          )}
          {status.backend === "github" && (
            <p className="text-text-dim">
              The vault still uses GitHub. To switch to the KV copy, set{" "}
              <code>KEBAB_VAULT_BACKEND=kv</code> (or remove the GitHub credentials) and redeploy.
            </p>
          )}
        </div>
      )}
      {info && <p className="text-xs text-green">{info}</p>}
      {error && <p className="text-xs text-red">{error}</p>}
    </div>
  );
}
