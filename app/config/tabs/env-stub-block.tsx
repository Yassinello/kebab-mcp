"use client";

import { PRODUCT } from "@/core/constants/brand";
import { useMemo, useState } from "react";

interface VarRow {
  key: string;
  label?: string;
  value: string;
  placeholder?: string;
  /** Whether the value is masked (•••). Don't include masked values in the stub. */
  masked?: boolean;
}

interface EnvStubBlockProps {
  /** Pack id used in the filename (e.g. "google" → google.env). */
  packId: string;
  /** Human label used in the comment header (e.g. "Google Workspace"). */
  packLabel: string;
  /** The connector vars to render. Empty/masked values get placeholder rows. */
  vars: VarRow[];
}

/**
 * Read-only `.env`-format snippet block with copy + download buttons.
 *
 * Used in static mode where the dashboard cannot persist credentials. The
 * block reflects the values currently in the form (typed by the user) so
 * what they paste is exactly what they would have saved. Masked values are
 * shown as placeholders so we never leak server-side stored secrets through
 * this surface — the user must re-type to materialize them.
 */
export function EnvStubBlock({ packId, packLabel, vars }: EnvStubBlockProps) {
  const [copied, setCopied] = useState(false);

  // Memoize so we don't rebuild the text 3× per render (preview + 2 handlers)
  // — typing into the connector form re-renders the whole tree, and OAuth
  // refresh tokens make this non-trivial to do on every keystroke.
  const previewText = useMemo(() => {
    const lines: string[] = [
      `# ${PRODUCT.name} — ${packLabel} connector`,
      `# Generated: ${new Date().toISOString()}`,
      `# Paste these into your deploy environment (Vercel → Project → Settings →`,
      `# Environment Variables) and redeploy. Live save is unavailable in static mode.`,
      "",
    ];
    for (const v of vars) {
      const value = v.masked || !v.value ? (v.placeholder ?? "your-value") : v.value;
      // Quote values that contain whitespace or special chars to keep them parseable.
      const needsQuotes = /[\s"'\\]/.test(value);
      const safeValue = needsQuotes ? `"${value.replace(/"/g, '\\"')}"` : value;
      lines.push(`${v.key}=${safeValue}`);
    }
    lines.push("");
    return lines.join("\n");
  }, [vars, packId, packLabel]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(previewText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can fail in insecure contexts — surface via download instead.
    }
  };

  const handleDownload = () => {
    const blob = new Blob([previewText], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${packId}.env`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Visible preview always materializes so the user can verify what they're
  // copying. Masked values render as the placeholder; we never reveal the
  // actual masked value here (that would defeat the masking).
  const hasMaskedValues = vars.some((v) => v.masked);
  const hasEmptyValues = vars.some((v) => !v.value && !v.masked);

  return (
    <div className="border border-orange/30 rounded-lg bg-orange-bg/20 p-4 space-y-3">
      <div>
        <h4 className="text-sm font-semibold text-text">
          Static mode — copy these env vars to persist this connector
        </h4>
        <p className="text-[11px] text-text-dim mt-0.5 leading-relaxed">
          Live saves are disabled because no persistent storage is configured. Add the lines below
          to your deploy environment, then redeploy.{" "}
          {(hasMaskedValues || hasEmptyValues) && (
            <span className="text-orange">
              Fill empty values in the form above first — masked / empty fields render as
              placeholders.
            </span>
          )}
        </p>
      </div>
      <pre className="bg-bg border border-border rounded p-3 text-[11px] font-mono text-text overflow-x-auto whitespace-pre">
        {previewText}
      </pre>
      <div className="flex items-center gap-2">
        <button
          onClick={handleCopy}
          className="text-xs font-medium px-3 py-1.5 rounded-md bg-bg-muted hover:bg-border-light text-text-dim hover:text-text border border-border"
        >
          {copied ? "Copied ✓" : "Copy"}
        </button>
        <button
          onClick={handleDownload}
          className="text-xs font-medium px-3 py-1.5 rounded-md bg-bg-muted hover:bg-border-light text-text-dim hover:text-text border border-border"
        >
          Download {packId}.env
        </button>
      </div>
    </div>
  );
}
