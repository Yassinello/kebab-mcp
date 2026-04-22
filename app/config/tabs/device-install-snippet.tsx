"use client";

/**
 * Phase 52 / DEV-01 — Claude Desktop install-snippet modal.
 * Renders claude_desktop_config.json + all 3 OS config paths. Token shown once.
 */

import { useState } from "react";

function slugify(label: string): string {
  return (
    label
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "kebab"
  );
}

const PATHS: [string, string][] = [
  ["macOS", "~/Library/Application Support/Claude/claude_desktop_config.json"],
  ["Windows", "%APPDATA%\\Claude\\claude_desktop_config.json"],
  ["Linux", "~/.config/Claude/claude_desktop_config.json"],
];

export function DeviceInstallSnippet({
  label,
  token,
  baseUrl,
  onClose,
}: {
  label: string;
  token: string;
  baseUrl: string;
  onClose: () => void;
}) {
  const snippet = JSON.stringify(
    {
      mcpServers: {
        [slugify(label)]: {
          command: "npx",
          args: ["-y", "mcp-remote", `${baseUrl}/api/mcp?token=${token}`],
        },
      },
    },
    null,
    2
  );
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // silent-swallow-ok: user can select-copy from the visible pre block.
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-2xl rounded-lg bg-bg border border-border p-6 shadow-xl">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold">Install on new device: {label}</h2>
            <p className="text-xs text-text-dim mt-1">Token shown once — save now.</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            type="button"
            className="text-text-muted hover:text-text"
          >
            ×
          </button>
        </div>
        <pre className="bg-bg-muted text-xs p-3 rounded overflow-x-auto border border-border font-mono">
          <code>{snippet}</code>
        </pre>
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={onCopy}
            className="px-3 py-1.5 text-xs rounded bg-accent text-white hover:bg-accent/90"
          >
            {copied ? "Copied!" : "Copy JSON"}
          </button>
          <span className="text-[11px] text-text-muted">Echoed once; not retrievable later.</span>
        </div>
        <div className="mt-4 text-[11px] text-text-dim space-y-1">
          <p className="font-semibold text-text">Config file location:</p>
          {PATHS.map(([os, path]) => (
            <p key={os}>
              <span className="text-text-muted">{os}:</span>{" "}
              <code className="text-[10px]">{path}</code>
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}
