"use client";

import { useEffect, useState, useCallback } from "react";

interface ConnectorSample {
  ok: boolean;
  latencyMs: number;
}

interface HealthSample {
  ts: number;
  overall: "ok" | "degraded" | "down";
  connectors: Record<string, ConnectorSample>;
}

type State =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "ready"; samples: HealthSample[] }
  | { kind: "error" };

const POLL_INTERVAL_MS = 60_000;

/**
 * Renders a mini sparkline as an inline SVG. Points are scaled to fit
 * a 100x30 viewBox. Uses a simple polyline — no charting library.
 */
function Sparkline({ values, color }: { values: number[]; color: string }) {
  if (values.length < 2) return null;
  const max = Math.max(...values, 1);
  const w = 100;
  const h = 30;
  const padding = 2;
  const effectiveH = h - padding * 2;
  const step = w / (values.length - 1);
  const points = values
    .map((v, i) => {
      const x = i * step;
      const y = padding + effectiveH - (v / max) * effectiveH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="w-[100px] h-[30px] shrink-0"
      preserveAspectRatio="none"
    >
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Badge({
  status,
  label,
  lastCheck,
}: {
  status: "ok" | "degraded" | "down" | "no-data";
  label: string;
  lastCheck?: string | undefined;
}) {
  const colors: Record<typeof status, string> = {
    ok: "bg-green/15 text-green border-green/30",
    degraded: "bg-orange/15 text-orange-dark border-orange/30",
    down: "bg-red/15 text-red border-red/30",
    "no-data": "bg-bg-soft text-text-muted border-border",
  };

  return (
    <div className="flex items-center gap-2">
      <span
        className={`inline-block w-2 h-2 rounded-full shrink-0 ${
          status === "ok"
            ? "bg-green"
            : status === "degraded"
              ? "bg-orange"
              : status === "down"
                ? "bg-red"
                : "bg-text-muted/40"
        }`}
      />
      <span
        className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium border ${colors[status]}`}
      >
        {label}
      </span>
      {lastCheck && <span className="text-[10px] text-text-muted">{lastCheck}</span>}
    </div>
  );
}

export function ConnectorHealthWidget() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [checking, setChecking] = useState(false);
  // Auto-trigger a single deep check on first empty state — avoids the
  // "you have to click Check Now to see anything" UX trap on fresh
  // deploys. We only auto-run once per mount; subsequent polls populate
  // history naturally, and the "Check Now" button stays available for
  // manual refreshes from the ready state.
  const [autoChecked, setAutoChecked] = useState(false);

  const fetchHistory = useCallback(() => {
    fetch("/api/admin/health-history", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: HealthSample[]) => {
        if (data.length === 0) {
          setState({ kind: "empty" });
        } else {
          setState({ kind: "ready", samples: data });
        }
      })
      .catch(() => setState({ kind: "error" }));
  }, []);

  useEffect(() => {
    fetchHistory();
    const id = setInterval(fetchHistory, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchHistory]);

  const runDeepCheck = useCallback(async () => {
    setChecking(true);
    try {
      await fetch("/api/health?deep=1", { credentials: "include" });
      // Refetch history after the sample is written.
      setTimeout(fetchHistory, 500);
    } catch {
      // Ignore — the user will see the badge update on next poll.
    } finally {
      setChecking(false);
    }
  }, [fetchHistory]);

  // First-paint auto-check: trigger one deep health check when we land
  // on the empty state, so the user sees actual data without manual
  // intervention. Guarded by autoChecked so a transient empty re-render
  // doesn't fire a second time.
  useEffect(() => {
    if (state.kind === "empty" && !autoChecked) {
      setAutoChecked(true);
      // fire-and-forget OK: auto-trigger deep check on first empty render; result lands in state via setter
      void runDeepCheck();
    }
  }, [state.kind, autoChecked, runDeepCheck]);

  if (state.kind === "error") return null;

  return (
    <section>
      <h2 className="text-[10px] font-semibold text-text-muted uppercase tracking-[0.1em] mb-3">
        Connector health
      </h2>
      <div className="border border-border rounded-lg px-5 py-4">
        {state.kind === "loading" && (
          <p className="text-xs text-text-muted">Loading health data...</p>
        )}
        {state.kind === "empty" && (
          <div className="flex items-center gap-4">
            <p className="text-xs text-text-muted flex-1">
              {checking ? "Running first health check…" : "No health data yet."}
            </p>
            {!checking && (
              <button
                onClick={runDeepCheck}
                className="text-xs font-medium px-3 py-1.5 rounded-md bg-accent/10 text-accent border border-accent/30 hover:bg-accent/20 transition-colors"
              >
                Check now
              </button>
            )}
          </div>
        )}
        {state.kind === "ready" && <ConnectorGrid samples={state.samples} />}
      </div>
    </section>
  );
}

function ConnectorGrid({ samples }: { samples: HealthSample[] }) {
  // Collect all connector IDs seen across all samples.
  const connectorIds = new Set<string>();
  for (const s of samples) {
    for (const id of Object.keys(s.connectors)) {
      connectorIds.add(id);
    }
  }

  const latest = samples[samples.length - 1];
  if (!latest) return null;
  const lastCheckTime = new Date(latest.ts).toLocaleTimeString();

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[10px] text-text-muted uppercase tracking-wide">
          Last check: {lastCheckTime}
        </p>
        <OverallBadge overall={latest.overall} />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {[...connectorIds].sort().map((id) => {
          const latestState = latest.connectors[id];
          const status: "ok" | "degraded" | "down" | "no-data" = latestState
            ? latestState.ok
              ? "ok"
              : "down"
            : "no-data";

          // Collect latency values for sparkline.
          const latencies = samples
            .map((s) => s.connectors[id]?.latencyMs)
            .filter((v): v is number => v !== undefined);

          const sparkColor =
            status === "ok" ? "#22c55e" : status === "down" ? "#ef4444" : "#94a3b8";

          return (
            <div
              key={id}
              className="flex items-center gap-3 p-2 rounded-md border border-border/50"
            >
              <div className="flex-1 min-w-0">
                <Badge
                  status={status}
                  label={id}
                  lastCheck={latestState ? `${latestState.latencyMs}ms` : undefined}
                />
              </div>
              <Sparkline values={latencies} color={sparkColor} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function OverallBadge({ overall }: { overall: "ok" | "degraded" | "down" }) {
  const colors: Record<typeof overall, string> = {
    ok: "text-green",
    degraded: "text-orange-dark",
    down: "text-red",
  };
  const labels: Record<typeof overall, string> = {
    ok: "All systems operational",
    degraded: "Degraded",
    down: "Down",
  };
  return <span className={`text-[11px] font-medium ${colors[overall]}`}>{labels[overall]}</span>;
}
