"use client";

import { useState, useEffect } from "react";
import type { ToolLog } from "@/core/logging";

export function LogsTab({ initialLogs }: { initialLogs: ToolLog[] }) {
  const [logs, setLogs] = useState<ToolLog[]>(initialLogs);
  const [expanded, setExpanded] = useState<number | null>(null);

  // Poll for fresh logs every 5s
  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const res = await fetch("/api/config/logs", { credentials: "include" });
        if (res.ok) {
          const data = await res.json();
          if (data.logs) setLogs(data.logs);
        }
      } catch {
        /* ignore */
      }
    }, 5000);
    return () => clearInterval(id);
  }, []);

  const reversed = [...logs].reverse();

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm text-text-dim">
          Last {logs.length} tool invocations (in-memory, ephemeral).
        </p>
        <p className="text-[11px] text-text-muted">Auto-refresh every 5s</p>
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
