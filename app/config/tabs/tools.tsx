"use client";

import { useState, useMemo, useEffect } from "react";
import type { ConnectorSummary } from "../tabs";
import { toMsg } from "@/core/error-utils";

interface ToolRow {
  name: string;
  description: string;
  packId: string;
  packLabel: string;
  deprecated?: string;
  destructive?: boolean;
  disabled?: boolean;
}

export function ToolsTab({
  connectors,
  initialDisabledTools,
}: {
  connectors: ConnectorSummary[];
  /** Server-fetched disabled tool names — avoids client-side loading spinner. */
  initialDisabledTools?: string[];
}) {
  const packs = connectors;
  const [search, setSearch] = useState("");
  const [packFilter, setPackFilter] = useState<string>("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [argsByTool, setArgsByTool] = useState<Record<string, string>>({});
  const [results, setResults] = useState<
    Record<string, { ok: boolean; data?: unknown; error?: string; durationMs?: number }>
  >({});
  const [running, setRunning] = useState<string | null>(null);
  const [disabledTools, setDisabledTools] = useState<Set<string>>(
    new Set(initialDisabledTools ?? [])
  );
  const [toggling, setToggling] = useState<string | null>(null);

  // RSC-01: Only fetch client-side if no server data was provided (backward compat).
  useEffect(() => {
    if (initialDisabledTools) return; // Already have server data
    fetch("/api/config/tool-toggle-list", { credentials: "include" })
      .then((r) => r.json())
      .then((d: { ok?: boolean; disabled?: string[] }) => {
        if (d.ok && Array.isArray(d.disabled)) {
          setDisabledTools(new Set(d.disabled));
        }
      })
      .catch(() => {});
  }, [initialDisabledTools]);

  const toggleTool = async (toolName: string, currentlyDisabled: boolean) => {
    setToggling(toolName);
    try {
      const res = await fetch("/api/config/tool-toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ tool: toolName, disabled: !currentlyDisabled }),
      });
      const data = await res.json();
      if (data.ok) {
        setDisabledTools((prev) => {
          const next = new Set(prev);
          if (!currentlyDisabled) {
            next.add(toolName);
          } else {
            next.delete(toolName);
          }
          return next;
        });
      }
    } catch {
      // Silently fail — user can retry.
    }
    setToggling(null);
  };

  const allTools: ToolRow[] = useMemo(() => {
    const rows: ToolRow[] = [];
    for (const pack of packs) {
      if (!pack.enabled) continue;
      for (const t of pack.tools) {
        rows.push({
          name: t.name,
          description: t.description,
          packId: pack.id,
          packLabel: pack.label,
          deprecated: t.deprecated,
          destructive: t.destructive,
        });
      }
    }
    return rows;
  }, [packs]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allTools.filter((t) => {
      if (packFilter !== "all" && t.packId !== packFilter) return false;
      if (!q) return true;
      return t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q);
    });
  }, [allTools, search, packFilter]);

  const runTool = async (name: string, destructive: boolean) => {
    const raw = argsByTool[name] || "{}";
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(raw);
    } catch {
      setResults((p) => ({ ...p, [name]: { ok: false, error: "Invalid JSON in arguments" } }));
      return;
    }
    if (
      destructive &&
      !confirm(`"${name}" is marked DESTRUCTIVE and will write to upstream APIs. Execute for real?`)
    ) {
      return;
    }
    const isDestructive = destructive;
    setRunning(name);
    try {
      const res = await fetch("/api/config/sandbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ toolName: name, args, confirm: isDestructive }),
      });
      const data = await res.json();
      setResults((p) => ({ ...p, [name]: data }));
    } catch (err) {
      setResults((p) => ({
        ...p,
        [name]: { ok: false, error: toMsg(err) },
      }));
    }
    setRunning(null);
  };

  return (
    <div>
      {/* Controls */}
      <div className="flex gap-3 mb-4 flex-wrap">
        <input
          type="text"
          placeholder="Search tools by name or description..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 min-w-[240px] bg-bg-muted border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
        />
        <select
          value={packFilter}
          onChange={(e) => setPackFilter(e.target.value)}
          className="bg-bg-muted border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
        >
          <option value="all">All connectors</option>
          {packs
            .filter((p) => p.enabled)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
        </select>
      </div>

      <p className="text-xs text-text-muted mb-3">
        {filtered.length} of {allTools.length} tools
      </p>

      {/* MOBILE-03: outer scroll container so the fixed-width tool name
          and pack badge columns don't push the whole layout off the
          right edge of a 375px viewport. The expanded inline form
          (Arguments, Run, Result) still flows normally inside each row. */}
      <div className="border border-border rounded-lg divide-y divide-border overflow-x-auto">
        {filtered.map((tool) => {
          const isOpen = expanded === tool.name;
          const result = results[tool.name];
          const destructive = !!tool.destructive;
          const isDisabled = disabledTools.has(tool.name);
          return (
            <div key={tool.name} className={isDisabled ? "opacity-60" : ""}>
              <div className="w-full flex items-center gap-3 px-3 sm:px-5 py-3 hover:bg-bg-muted/50 transition-colors whitespace-nowrap min-w-max">
                <button
                  onClick={() => setExpanded(isOpen ? null : tool.name)}
                  className="flex items-center gap-3 flex-1 text-left min-w-0"
                >
                  <span className="font-mono text-xs text-accent w-40 truncate shrink-0">
                    {tool.name}
                  </span>
                  <span className="text-xs text-text-muted w-24 truncate shrink-0">
                    {tool.packLabel}
                  </span>
                  <span className="text-xs text-text-dim flex-1 truncate">{tool.description}</span>
                </button>
                {destructive && (
                  <span
                    className="text-[10px] font-medium text-orange bg-orange-bg px-1.5 py-0.5 rounded shrink-0"
                    title="Destructive — requires confirmation"
                  >
                    DESTRUCTIVE
                  </span>
                )}
                {isDisabled && (
                  <span className="text-[10px] font-medium text-text-muted bg-bg-muted px-1.5 py-0.5 rounded shrink-0">
                    OFF
                  </span>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleTool(tool.name, isDisabled);
                  }}
                  disabled={toggling === tool.name}
                  className={`w-9 h-5 rounded-full transition-colors relative shrink-0 ${
                    isDisabled ? "bg-bg-muted border border-border" : "bg-accent"
                  }`}
                  title={isDisabled ? "Enable tool" : "Disable tool"}
                  aria-label={isDisabled ? `Enable ${tool.name}` : `Disable ${tool.name}`}
                >
                  <div
                    className={`w-3.5 h-3.5 rounded-full bg-white shadow-sm absolute top-[3px] transition-all ${
                      isDisabled ? "left-[3px]" : "left-[18px]"
                    }`}
                  />
                </button>
              </div>
              {isOpen && (
                <div className="bg-bg-muted/30 px-5 py-4 space-y-3">
                  <div>
                    <label className="text-xs text-text-muted mb-1 block">Arguments (JSON)</label>
                    <textarea
                      value={argsByTool[tool.name] || "{}"}
                      onChange={(e) =>
                        setArgsByTool((p) => ({ ...p, [tool.name]: e.target.value }))
                      }
                      rows={4}
                      className="w-full bg-bg border border-border rounded-md px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-accent/30"
                    />
                  </div>
                  <button
                    onClick={() => runTool(tool.name, destructive)}
                    disabled={running === tool.name}
                    className="bg-accent text-white text-sm font-medium px-4 py-1.5 rounded-md hover:bg-accent/90 disabled:opacity-60"
                  >
                    {running === tool.name ? "Running..." : "Run"}
                  </button>
                  {result && (
                    <div
                      className={`border rounded-md p-3 text-xs font-mono whitespace-pre-wrap break-all max-h-96 overflow-auto ${
                        result.ok
                          ? "bg-green-bg/30 border-green/20 text-text"
                          : "bg-red-bg border-red/20 text-red"
                      }`}
                    >
                      {result.ok
                        ? JSON.stringify(result.data, null, 2)
                        : result.error || "Unknown error"}
                      {result.durationMs !== undefined && (
                        <p className="text-text-muted mt-2">— {result.durationMs}ms</p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {filtered.length === 0 && (
          <p className="text-sm text-text-muted px-5 py-6 text-center">No tools match.</p>
        )}
      </div>
    </div>
  );
}
