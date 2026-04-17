"use client";

import { useState } from "react";

interface StorageSetupCardProps {
  /** Credential key-value pairs the user tried to save. Used for .env download. */
  pendingVars: Record<string, string>;
  /** All current env vars (for complete .env export). */
  allEnvVars: Record<string, string>;
  /** Called when the user clicks "Retry" after setting up Upstash. */
  onRetry: () => void | Promise<void>;
  /** Called to dismiss the card. */
  onDismiss: () => void;
}

/**
 * Storage choice card — shown when Vercel has no Upstash or VERCEL_TOKEN.
 * Offers two paths: set up Upstash (recommended) or download .env file.
 */
export function StorageSetupCard({
  pendingVars,
  allEnvVars,
  onRetry,
  onDismiss,
}: StorageSetupCardProps) {
  const [retrying, setRetrying] = useState(false);

  const handleRetry = async () => {
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  };

  const handleDownloadEnv = () => {
    // Merge all env vars with the pending vars for a complete export
    const merged = { ...allEnvVars, ...pendingVars };
    const lines = [
      "# MyMCP — credential export",
      `# Generated: ${new Date().toISOString()}`,
      "# Paste these into your Vercel project's Environment Variables",
      "",
    ];
    for (const [key, value] of Object.entries(merged)) {
      // Skip masked values (contain bullet chars) and empty values
      if (!value || value.includes("\u2022")) continue;
      lines.push(`${key}=${value}`);
    }
    lines.push("");
    const text = lines.join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "mymcp-credentials.env";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="border border-accent/30 rounded-lg bg-accent/5 p-4 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-text">Storage setup needed</h3>
        <p className="text-xs text-text-dim mt-1">
          Vercel&apos;s filesystem is read-only. Choose how to store your credentials:
        </p>
      </div>

      {/* Option A: Upstash */}
      <div className="border border-border rounded-md p-3 space-y-2 bg-bg">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-accent bg-accent/10 px-2 py-0.5 rounded-full">
            Recommended
          </span>
          <h4 className="text-sm font-medium">Upstash Redis</h4>
        </div>
        <p className="text-xs text-text-dim">
          Instant save, no redeploy needed. Free tier available.
        </p>
        <ol className="text-xs text-text-dim space-y-0.5 list-decimal list-inside">
          <li>
            Go to Vercel Integrations and add <strong className="text-text">Upstash</strong>
          </li>
          <li>Link a Redis database to your project</li>
          <li>That&apos;s it &mdash; env vars are auto-injected</li>
        </ol>
        <div className="flex items-center gap-2 pt-1">
          <a
            href="https://vercel.com/integrations/upstash"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-medium text-accent hover:text-accent/80 underline underline-offset-2"
          >
            Open Upstash Integration
          </a>
          <button
            onClick={handleRetry}
            disabled={retrying}
            className="text-xs font-medium px-3 py-1.5 rounded-md bg-accent text-white hover:bg-accent/90 disabled:opacity-60"
          >
            {retrying ? "Checking..." : "I've set it up -- retry"}
          </button>
        </div>
      </div>

      {/* Option B: Download .env */}
      <div className="border border-border rounded-md p-3 space-y-2 bg-bg">
        <h4 className="text-sm font-medium">Download .env file</h4>
        <p className="text-xs text-text-dim">
          Export credentials to paste into Vercel dashboard manually. Requires redeploy.
        </p>
        <button
          onClick={handleDownloadEnv}
          className="text-xs font-medium px-3 py-1.5 rounded-md bg-bg-muted hover:bg-border-light text-text-dim hover:text-text border border-border"
        >
          Download .env
        </button>
      </div>

      <p className="text-[11px] text-text-muted">
        Tip: Go back to{" "}
        <a href="/welcome?preview=1" className="text-accent underline underline-offset-2">
          /welcome
        </a>{" "}
        to set up Upstash if you haven&apos;t already.
      </p>

      <button onClick={onDismiss} className="text-[11px] text-text-muted hover:text-text-dim">
        Dismiss
      </button>
    </div>
  );
}
