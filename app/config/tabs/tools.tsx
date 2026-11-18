"use client";

import { useState, useMemo, useEffect } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { UnderlineTabs } from "../../components/page-tabs";
import type { ConnectorSummary } from "../tabs";
import { toMsg } from "@/core/error-utils";
import { CustomToolsTab } from "./custom-tools";

interface ToolEntry {
  name: string;
  description: string;
  deprecated?: string | undefined;
  destructive?: boolean | undefined;
}

type ToolsSubTab = "all" | "custom";

/**
 * Tools tab shell — hosts two sub-tabs:
 *   - "all"    → AllToolsView (every registered tool, grouped by connector,
 *                with per-tool enable/disable + inline test).
 *   - "custom" → CustomToolsTab (CRUD for user-defined declarative tools).
 *
 * Custom Tools used to be a top-level sidebar item; it was demoted to a
 * sub-tab here (same pattern as Storage/Devices under Settings) so all
 * tool-related surfaces live in one place. Sub-tab state lives in `?sub=`
 * so deep links + back/forward work; the legacy `?tab=custom-tools` route
 * still resolves here via `forceSub="custom"` (see tabs.tsx) for bookmark
 * compatibility, and the CustomToolsTab's own `?edit=<id>` deep link keeps
 * working unchanged (it reads `edit` independently of `sub`).
 */
export function ToolsTab({
  connectors,
  initialDisabledTools,
  forceSub,
}: {
  connectors: ConnectorSummary[];
  /** Server-fetched disabled tool names — avoids client-side loading spinner. */
  initialDisabledTools?: string[] | undefined;
  /** Force a sub-tab regardless of `?sub=` (legacy `?tab=custom-tools` route). */
  forceSub?: ToolsSubTab;
}) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const subFromUrl = searchParams.get("sub");
  const initialSub: ToolsSubTab = forceSub ?? (subFromUrl === "custom" ? "custom" : "all");
  const [sub, setSubState] = useState<ToolsSubTab>(initialSub);
  const setSub = (next: ToolsSubTab) => {
    setSubState(next);
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", "tools");
    params.set("sub", next);
    // Leaving the custom sub-tab should drop any open editor (`?edit=`).
    if (next !== "custom") params.delete("edit");
    router.replace(`/config?${params.toString()}`, { scroll: false });
  };

  return (
    <div>
      <UnderlineTabs
        label="Tools sections"
        idBase="tools"
        value={sub}
        onChange={setSub}
        tabs={
          [
            { id: "all", label: "All tools" },
            { id: "custom", label: "Custom tools" },
          ] as const
        }
      />

      {sub === "custom" ? (
        <CustomToolsTab />
      ) : (
        <AllToolsView connectors={connectors} initialDisabledTools={initialDisabledTools} />
      )}
    </div>
  );
}

function AllToolsView({
  connectors,
  initialDisabledTools,
}: {
  connectors: ConnectorSummary[];
  initialDisabledTools?: string[] | undefined;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const enabledPacks = useMemo(() => connectors.filter((p) => p.enabled), [connectors]);

  const [search, setSearch] = useState("");
  const [packFilter, setPackFilter] = useState<string>("all");
  const [expandedTool, setExpandedTool] = useState<string | null>(null);
  const [openConnectors, setOpenConnectors] = useState<Set<string>>(new Set());
  const [argsByTool, setArgsByTool] = useState<Record<string, string>>({});
  const [results, setResults] = useState<
    Record<string, { ok: boolean; data?: unknown; error?: string; durationMs?: number }>
  >({});
  const [running, setRunning] = useState<string | null>(null);
  const [disabledTools, setDisabledTools] = useState<Set<string>>(
    new Set(initialDisabledTools ?? [])
  );
  const [toggling, setToggling] = useState<string | null>(null);
  const [bulkToggling, setBulkToggling] = useState<string | null>(null);

  // RSC-01: Only fetch client-side if no server data was provided (backward compat).
  useEffect(() => {
    if (initialDisabledTools) return;
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
          if (!currentlyDisabled) next.add(toolName);
          else next.delete(toolName);
          return next;
        });
      }
    } catch {
      /* silent — user can retry */
    }
    setToggling(null);
  };

  /** Connector-level master toggle. Disables/enables all tools in a pack. */
  const toggleConnector = async (packId: string, packTools: ToolEntry[]) => {
    const allDisabled = packTools.every((t) => disabledTools.has(t.name));
    const targetDisabled = !allDisabled; // if all already off, enable; otherwise disable all
    setBulkToggling(packId);
    try {
      await Promise.all(
        packTools.map((t) =>
          fetch("/api/config/tool-toggle", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ tool: t.name, disabled: targetDisabled }),
          })
        )
      );
      setDisabledTools((prev) => {
        const next = new Set(prev);
        for (const t of packTools) {
          if (targetDisabled) next.add(t.name);
          else next.delete(t.name);
        }
        return next;
      });
    } catch {
      /* silent */
    }
    setBulkToggling(null);
  };

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
    setRunning(name);
    try {
      const res = await fetch("/api/config/sandbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ toolName: name, args, confirm: destructive }),
      });
      const data = await res.json();
      setResults((p) => ({ ...p, [name]: data }));
    } catch (err) {
      setResults((p) => ({ ...p, [name]: { ok: false, error: toMsg(err) } }));
    }
    setRunning(null);
  };

  const totalTools = useMemo(
    () => enabledPacks.reduce((n, p) => n + p.tools.length, 0),
    [enabledPacks]
  );

  const filteredPacks = useMemo(() => {
    const q = search.trim().toLowerCase();
    return enabledPacks
      .filter((p) => packFilter === "all" || p.id === packFilter)
      .map((p) => ({
        ...p,
        tools: p.tools.filter((t) => {
          if (!q) return true;
          return t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q);
        }),
      }))
      .filter((p) => p.tools.length > 0);
  }, [enabledPacks, search, packFilter]);

  const visibleToolCount = useMemo(
    () => filteredPacks.reduce((n, p) => n + p.tools.length, 0),
    [filteredPacks]
  );

  // Auto-open all connectors when a search query is active so matches are visible.
  const isFiltered = search.trim().length > 0 || packFilter !== "all";

  const isConnectorOpen = (id: string) => isFiltered || openConnectors.has(id);

  const toggleConnectorOpen = (id: string) => {
    setOpenConnectors((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-3 flex-wrap items-center">
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
          {enabledPacks.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <button
          onClick={() => {
            const params = new URLSearchParams(searchParams.toString());
            params.set("tab", "tools");
            params.set("sub", "custom");
            params.set("edit", "__new__");
            router.replace(`/config?${params.toString()}`, { scroll: false });
          }}
          className="text-xs font-medium text-accent hover:underline px-3 py-2 border border-accent/20 rounded-md shrink-0"
        >
          + New custom tool
        </button>
      </div>

      <p className="text-xs text-text-muted">
        {visibleToolCount} of {totalTools} tools across {filteredPacks.length} connector
        {filteredPacks.length === 1 ? "" : "s"}
      </p>

      {filteredPacks.length === 0 && (
        <div className="border border-border rounded-lg p-8 text-center">
          <p className="text-sm text-text-muted">No tools match.</p>
        </div>
      )}

      <div className="space-y-3">
        {filteredPacks.map((pack) => {
          const open = isConnectorOpen(pack.id);
          const enabledCount = pack.tools.filter((t) => !disabledTools.has(t.name)).length;
          const allDisabled = pack.tools.every((t) => disabledTools.has(t.name));
          const someDisabled = !allDisabled && pack.tools.some((t) => disabledTools.has(t.name));
          return (
            <ConnectorBanner
              key={pack.id}
              packId={pack.id}
              packLabel={pack.label}
              packDescription={pack.description}
              tools={pack.tools}
              open={open}
              onToggleOpen={() => toggleConnectorOpen(pack.id)}
              enabledCount={enabledCount}
              someDisabled={someDisabled}
              allDisabled={allDisabled}
              bulkToggling={bulkToggling === pack.id}
              onBulkToggle={() => toggleConnector(pack.id, pack.tools)}
              disabledTools={disabledTools}
              expandedTool={expandedTool}
              setExpandedTool={setExpandedTool}
              toggling={toggling}
              onToggleTool={toggleTool}
              argsByTool={argsByTool}
              setArgsByTool={setArgsByTool}
              running={running}
              results={results}
              onRunTool={runTool}
            />
          );
        })}
      </div>
    </div>
  );
}

function ConnectorBanner({
  packId,
  packLabel,
  packDescription,
  tools,
  open,
  onToggleOpen,
  enabledCount,
  someDisabled,
  allDisabled,
  bulkToggling,
  onBulkToggle,
  disabledTools,
  expandedTool,
  setExpandedTool,
  toggling,
  onToggleTool,
  argsByTool,
  setArgsByTool,
  running,
  results,
  onRunTool,
}: {
  packId: string;
  packLabel: string;
  packDescription: string;
  tools: ToolEntry[];
  open: boolean;
  onToggleOpen: () => void;
  enabledCount: number;
  someDisabled: boolean;
  allDisabled: boolean;
  bulkToggling: boolean;
  onBulkToggle: () => void;
  disabledTools: Set<string>;
  expandedTool: string | null;
  setExpandedTool: (name: string | null) => void;
  toggling: string | null;
  onToggleTool: (name: string, currentlyDisabled: boolean) => void;
  argsByTool: Record<string, string>;
  setArgsByTool: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  running: string | null;
  results: Record<string, { ok: boolean; data?: unknown; error?: string; durationMs?: number }>;
  onRunTool: (name: string, destructive: boolean) => void;
}) {
  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-3.5 hover:bg-bg-muted/30 transition-colors">
        <button
          type="button"
          onClick={onToggleOpen}
          className="flex items-center gap-3 flex-1 min-w-0 text-left"
          aria-expanded={open}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            aria-hidden="true"
            className={`text-text-muted shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
          >
            <path
              d="M5 3.5L8.5 7L5 10.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <div className="w-9 h-9 rounded-lg bg-accent/10 flex items-center justify-center text-accent font-bold text-sm shrink-0">
            {packLabel.charAt(0).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="font-semibold text-sm">{packLabel}</p>
              <span className="text-[11px] font-medium text-text-muted bg-bg-muted px-2 py-0.5 rounded-full">
                {enabledCount}/{tools.length} on
              </span>
              {someDisabled && (
                <span className="text-[11px] font-medium text-orange bg-orange-bg px-2 py-0.5 rounded-full">
                  partial
                </span>
              )}
              {allDisabled && (
                <span className="text-[11px] font-medium text-text-muted bg-bg-muted px-2 py-0.5 rounded-full">
                  all off
                </span>
              )}
            </div>
            <p className="text-xs text-text-dim mt-0.5 truncate">{packDescription}</p>
          </div>
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onBulkToggle();
          }}
          disabled={bulkToggling}
          className="text-xs font-medium text-text-dim hover:text-text px-3 py-1.5 border border-border hover:border-border-light rounded-md shrink-0 disabled:opacity-60"
          title={allDisabled ? "Enable every tool in this connector" : "Disable every tool"}
        >
          {bulkToggling ? "..." : allDisabled ? "Enable all" : "Disable all"}
        </button>
      </div>

      {open && (
        <div className="border-t border-border divide-y divide-border bg-bg-muted/10">
          {tools.map((tool) => (
            <ToolRow
              key={tool.name}
              packId={packId}
              tool={tool}
              isDisabled={disabledTools.has(tool.name)}
              isExpanded={expandedTool === tool.name}
              onToggleExpand={() => setExpandedTool(expandedTool === tool.name ? null : tool.name)}
              toggling={toggling === tool.name}
              onToggle={() => onToggleTool(tool.name, disabledTools.has(tool.name))}
              argsValue={argsByTool[tool.name] ?? "{}"}
              onArgsChange={(v) => setArgsByTool((p) => ({ ...p, [tool.name]: v }))}
              running={running === tool.name}
              result={results[tool.name]}
              onRun={() => onRunTool(tool.name, !!tool.destructive)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolRow({
  tool,
  isDisabled,
  isExpanded,
  onToggleExpand,
  toggling,
  onToggle,
  argsValue,
  onArgsChange,
  running,
  result,
  onRun,
}: {
  packId: string;
  tool: ToolEntry;
  isDisabled: boolean;
  isExpanded: boolean;
  onToggleExpand: () => void;
  toggling: boolean;
  onToggle: () => void;
  argsValue: string;
  onArgsChange: (v: string) => void;
  running: boolean;
  result: { ok: boolean; data?: unknown; error?: string; durationMs?: number } | undefined;
  onRun: () => void;
}) {
  const destructive = !!tool.destructive;
  return (
    <div className={isDisabled ? "opacity-60" : ""}>
      <div className="flex items-center gap-3 px-5 py-2.5">
        <button
          type="button"
          onClick={onToggleExpand}
          className="flex items-center gap-3 flex-1 min-w-0 text-left"
          aria-expanded={isExpanded}
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 12 12"
            fill="none"
            aria-hidden="true"
            className={`text-text-muted shrink-0 transition-transform ${isExpanded ? "rotate-90" : ""}`}
          >
            <path
              d="M4.5 3L7.5 6L4.5 9"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <code className="font-mono text-xs text-accent shrink-0 truncate max-w-[200px]">
            {tool.name}
          </code>
          <span className="text-xs text-text-dim flex-1 truncate">{tool.description}</span>
          {destructive && (
            <span
              className="text-[10px] font-medium text-orange bg-orange-bg px-1.5 py-0.5 rounded shrink-0"
              title="Destructive — requires confirmation"
            >
              DESTRUCTIVE
            </span>
          )}
          {tool.deprecated && (
            <span
              className="text-[10px] font-medium text-text-muted bg-bg-muted px-1.5 py-0.5 rounded shrink-0"
              title={tool.deprecated}
            >
              DEPRECATED
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={onToggle}
          disabled={toggling}
          className={`w-9 h-5 rounded-full transition-colors relative shrink-0 ${
            isDisabled ? "bg-bg-muted border border-border" : "bg-accent"
          } disabled:opacity-60`}
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
      {isExpanded && (
        <div className="bg-bg-muted/30 px-5 py-4 space-y-3 border-t border-border/60">
          {tool.description && (
            <p className="text-xs text-text-dim leading-relaxed">{tool.description}</p>
          )}
          <div>
            <label className="text-xs text-text-muted mb-1 block">Arguments (JSON)</label>
            <textarea
              value={argsValue}
              onChange={(e) => onArgsChange(e.target.value)}
              rows={4}
              className="w-full bg-bg border border-border rounded-md px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-accent/30"
            />
          </div>
          <button
            onClick={onRun}
            disabled={running || isDisabled}
            className="bg-accent text-white text-sm font-medium px-4 py-1.5 rounded-md hover:bg-accent/90 disabled:opacity-60"
            title={isDisabled ? "Enable the tool first" : "Run with the JSON arguments above"}
          >
            {running ? "Running..." : "Run"}
          </button>
          {result && (
            <div
              className={`border rounded-md p-3 text-xs font-mono whitespace-pre-wrap break-all max-h-96 overflow-auto ${
                result.ok
                  ? "bg-green-bg/30 border-green/20 text-text"
                  : "bg-red-bg border-red/20 text-red"
              }`}
            >
              {result.ok ? JSON.stringify(result.data, null, 2) : result.error || "Unknown error"}
              {result.durationMs !== undefined && (
                <p className="text-text-muted mt-2">— {result.durationMs}ms</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
