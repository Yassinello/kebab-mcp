"use client";

import { useState, useEffect } from "react";
import type { ToolLog } from "@/core/logging";

type Scope = "current" | "all";

/**
 * Phase 48 (ISO-02) — tenant selector.
 *
 * When the current admin has root scope (no `x-mymcp-tenant` cookie/header),
 * the dropdown surfaces "Current tenant" + "All tenants (root)" so the
 * operator can switch between the per-tenant buffer and the flattened union.
 *
 * For tenant-scoped admins, no selector renders — privacy guard at the
 * route layer (app/api/config/logs/route.ts) already downgrades any
 * `?scope=all` query from a scoped caller.
 *
 * `initialIsRootScope` is passed from the server component that renders
 * the tab (reads cookies / header on the server side).
 */
export function LogsTab({
  initialLogs,
  initialIsRootScope = false,
}: {
  initialLogs: ToolLog[];
  initialIsRootScope?: boolean;
}) {
  const [logs, setLogs] = useState<ToolLog[]>(initialLogs);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [scope, setScope] = useState<Scope>("current");

  const showSelector = initialIsRootScope;

  // Poll for fresh logs every 5s; re-fetch on scope change.
  useEffect(() => {
    const qs = scope === "all" ? "?scope=all" : "";
    const url = `/api/config/logs${qs}`;
    let cancelled = false;
    async function fetchLogs() {
      try {
        const res = await fetch(url, { credentials: "include" });
        if (res.ok) {
          const data = await res.json();
          if (!cancelled && data.logs) setLogs(data.logs);
        }
      } catch {
        /* ignore */
      }
    }
    // Immediate refresh on scope switch
    fetchLogs();
    const id = setInterval(fetchLogs, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [scope]);

  const reversed = [...logs].reverse();

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm text-text-dim">
          Last {logs.length} tool invocations (in-memory, ephemeral).
        </p>
        <div className="flex items-center gap-3">
          {showSelector && (
            <label className="flex items-center gap-1 text-xs text-text-muted">
              <span>Scope:</span>
              <select
                value={scope}
                onChange={(e) => setScope(e.target.value as Scope)}
                className="bg-bg-muted border border-border rounded px-2 py-0.5 text-xs font-mono"
                aria-label="Log scope"
              >
                <option value="current">Current tenant</option>
                <option value="all">All tenants (root)</option>
              </select>
            </label>
          )}
          <p className="text-[11px] text-text-muted">Auto-refresh every 5s</p>
        </div>
      </div>
      <div className="border border-border rounded-lg divide-y divide-border">
        {reversed.length === 0 && (
          <p className="text-sm text-text-muted px-5 py-6 text-center">No logs yet.</p>
        )}
        {reversed.map((log, i) => {
          const isOpen = expanded === i;
          return (
            <div key={i}>
              <button
                onClick={() => setExpanded(isOpen ? null : i)}
                className="w-full flex items-center gap-3 px-5 py-2.5 text-left hover:bg-bg-muted/50"
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${log.status === "success" ? "bg-green" : "bg-red"}`}
                />
                <span className="font-mono text-xs text-text-muted w-20 shrink-0">
                  {new Date(log.timestamp).toLocaleTimeString()}
                </span>
                <span className="font-mono text-xs w-40 truncate shrink-0">{log.tool}</span>
                <span className="text-xs text-text-muted flex-1 truncate">
                  {log.status === "success" ? "OK" : log.error}
                </span>
                {log.tokenId && (
                  <span className="font-mono text-[11px] text-text-muted bg-bg-muted px-1.5 py-0.5 rounded shrink-0">
                    {log.tokenId}
                  </span>
                )}
                <span className="font-mono text-[11px] text-text-muted shrink-0">
                  {log.durationMs}ms
                </span>
              </button>
              {isOpen && log.error && (
                <div className="bg-red-bg border-t border-red/20 px-5 py-3 text-xs font-mono text-red break-all">
                  {log.error}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
