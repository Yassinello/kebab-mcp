"use client";

import { PRODUCT } from "@/core/constants/brand";
import { useState } from "react";
import { McpClientSnippets } from "../../../components/mcp-client-snippets";

/**
 * MCP install panel for Settings → MCP subtab.
 *
 * Thin wrapper around the shared <McpClientSnippets /> — adds a token
 * reveal affordance that fetches the actual token on demand via
 * /api/config/auth-token rather than serializing it into the HTML payload.
 */
export function McpInstallPanel({ baseUrl, hasToken }: { baseUrl: string; hasToken: boolean }) {
  const [token, setToken] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const reveal = async () => {
    if (token) {
      setToken(null);
      return;
    }
    setRevealing(true);
    setRevealError(null);
    try {
      const res = await fetch("/api/config/auth-token", { credentials: "include" });
      const data = (await res.json()) as { ok: boolean; token?: string; error?: string };
      if (data.ok && data.token) {
        setToken(data.token);
      } else {
        setRevealError(data.error || "Could not fetch token");
      }
    } catch {
      setRevealError("Network error");
    }
    setRevealing(false);
  };

  const copyToken = async () => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  const displayToken = token ? token : hasToken ? "••••••••••••" : "<MCP_AUTH_TOKEN>";

  return (
    <div className="space-y-5">
      <p className="text-sm text-text-dim">
        Install {PRODUCT.name} in any MCP client below. The same token works in every client — paste
        it everywhere. Use multiple comma-separated tokens (in <code>MCP_AUTH_TOKEN</code>) only if
        you want to revoke one client without breaking the others.
      </p>

      <div className="border border-border rounded-lg p-4">
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-semibold text-text">Your MCP token</p>
          {hasToken && (
            <button
              type="button"
              onClick={reveal}
              disabled={revealing}
              className="text-[11px] text-accent hover:underline disabled:opacity-50"
            >
              {revealing ? "Loading…" : token ? "Hide" : "Reveal"}
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <code className="flex-1 break-all text-xs text-accent font-mono bg-bg-muted px-2.5 py-1.5 rounded border border-border">
            {displayToken}
          </code>
          {token && (
            <button
              type="button"
              onClick={copyToken}
              className="bg-bg border border-border hover:bg-bg-muted text-text text-xs font-medium px-2.5 py-1.5 rounded-md"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          )}
        </div>
        {revealError && <p className="text-[11px] text-red-500 mt-2">{revealError}</p>}
        {!hasToken && (
          <p className="text-[11px] text-text-muted mt-2">
            No token configured on this server. Set <code>MCP_AUTH_TOKEN</code> in your environment.
          </p>
        )}
      </div>

      <McpClientSnippets baseUrl={baseUrl} token={token} theme="dashboard" />
    </div>
  );
}
