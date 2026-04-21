"use client";

/**
 * OBS-05: /config Health tab.
 *
 * Renders the combined live state from /api/health + /api/admin/status
 * in one view so a cold-start operator can diagnose rehydrate health
 * without tailing logs. Auto-refreshes every 15s.
 *
 * Sections:
 *   - Bootstrap state (active | pending | error)
 *   - KV reachability + last rehydrate timestamp
 *   - Destructive env var warnings (complements the dashboard banner)
 *   - Rehydrate counter (total + last 24h)
 *   - KV latency samples (ring buffer, last ≤20)
 *   - Environment presence checklist
 */

import { useCallback, useEffect, useState } from "react";

interface HealthBody {
  ok: boolean;
  version: string;
  bootstrap: { state: string };
  kv: { reachable: boolean; lastRehydrateAt: string | null };
  warnings?: Array<{ code: string; var: string; message: string }>;
}

interface AdminStatusBody {
  firstRun?: {
    rehydrateCount: { total: number; last24h: number };
    kvLatencySamples: Array<{ at: string; op: string; durationMs: number }>;
    envPresent: Record<string, boolean>;
  };
}

const REFRESH_MS = 15_000;

function Block({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        background: "#111827",
        border: "1px solid #1f2937",
        borderRadius: "6px",
        padding: "12px 16px",
        marginBottom: "12px",
      }}
    >
      {children}
    </div>
  );
}

function Badge({
  tone,
  children,
}: {
  tone: "ok" | "warn" | "bad" | "dim";
  children: React.ReactNode;
}) {
  const colors: Record<string, { bg: string; fg: string }> = {
    ok: { bg: "#064e3b", fg: "#6ee7b7" },
    warn: { bg: "#78350f", fg: "#fcd34d" },
    bad: { bg: "#7f1d1d", fg: "#fca5a5" },
    dim: { bg: "#1f2937", fg: "#9ca3af" },
  };
  const c = colors[tone];
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: "12px",
        background: c.bg,
        color: c.fg,
        fontSize: "12px",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      }}
    >
      {children}
    </span>
  );
}

export function HealthTab() {
  const [health, setHealth] = useState<HealthBody | null>(null);
  const [status, setStatus] = useState<AdminStatusBody | null>(null);
  const [adminError, setAdminError] = useState<string | null>(null);
  const [lastRefreshAt, setLastRefreshAt] = useState<Date | null>(null);

  const refresh = useCallback(async () => {
    try {
      const h = (await fetch("/api/health").then((r) => r.json())) as HealthBody;
      setHealth(h);
    } catch {
      // silent-swallow-ok: UI retries on next interval; a fetch error does not mean the endpoint is unhealthy
    }
    try {
      const res = await fetch("/api/admin/status", { credentials: "include" });
      if (res.status === 401) {
        setAdminError("admin auth required");
        setStatus(null);
      } else {
        const s = (await res.json()) as AdminStatusBody;
        setStatus(s);
        setAdminError(null);
      }
    } catch {
      // silent-swallow-ok: UI retries on next interval
    }
    setLastRefreshAt(new Date());
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const bootstrapState = health?.bootstrap.state;
  const bootstrapTone =
    bootstrapState === "active" ? "ok" : bootstrapState === "pending" ? "warn" : "bad";

  return (
    <div style={{ maxWidth: "960px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "16px",
        }}
      >
        <h2 style={{ margin: 0, fontSize: "18px", fontWeight: 600 }}>Health</h2>
        <span style={{ color: "#6b7280", fontSize: "12px" }}>
          Auto-refresh every {REFRESH_MS / 1000}s
          {lastRefreshAt && ` · last ${lastRefreshAt.toLocaleTimeString()}`}
        </span>
      </div>

      {/* Bootstrap + KV */}
      <Block>
        <div style={{ marginBottom: "8px", fontWeight: 600 }}>Instance</div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "180px 1fr",
            rowGap: "6px",
            fontSize: "14px",
          }}
        >
          <div>Bootstrap state</div>
          <div>
            {bootstrapState ? (
              <Badge tone={bootstrapTone}>{bootstrapState}</Badge>
            ) : (
              <Badge tone="dim">loading…</Badge>
            )}
          </div>
          <div>Version</div>
          <div style={{ fontFamily: "ui-monospace, monospace" }}>{health?.version ?? "—"}</div>
          <div>KV reachable</div>
          <div>
            {health?.kv ? (
              health.kv.reachable ? (
                <Badge tone="ok">reachable</Badge>
              ) : (
                <Badge tone="bad">unreachable</Badge>
              )
            ) : (
              <Badge tone="dim">loading…</Badge>
            )}
          </div>
          <div>Last rehydrate</div>
          <div style={{ fontFamily: "ui-monospace, monospace", color: "#9ca3af" }}>
            {health?.kv?.lastRehydrateAt ?? "never"}
          </div>
        </div>
      </Block>

      {/* Warnings (destructive env vars) */}
      {health?.warnings && health.warnings.length > 0 && (
        <Block>
          <div style={{ marginBottom: "8px", fontWeight: 600, color: "#fca5a5" }}>
            Active warnings
          </div>
          <ul style={{ margin: 0, paddingLeft: "20px", fontSize: "14px" }}>
            {health.warnings.map((w) => (
              <li key={w.var}>
                <code>{w.var}</code>: {w.message}
              </li>
            ))}
          </ul>
        </Block>
      )}

      {/* First-run diagnostics (admin-gated) */}
      <Block>
        <div style={{ marginBottom: "8px", fontWeight: 600 }}>
          Rehydrate counters (24h sliding window)
        </div>
        {adminError ? (
          <div style={{ color: "#9ca3af", fontSize: "14px" }}>admin auth required</div>
        ) : status?.firstRun ? (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "180px 1fr",
              rowGap: "6px",
              fontSize: "14px",
            }}
          >
            <div>Total</div>
            <div style={{ fontFamily: "ui-monospace, monospace" }}>
              {status.firstRun.rehydrateCount.total}
            </div>
            <div>Last 24h</div>
            <div style={{ fontFamily: "ui-monospace, monospace" }}>
              {status.firstRun.rehydrateCount.last24h}
            </div>
          </div>
        ) : (
          <div style={{ color: "#6b7280", fontSize: "14px" }}>loading…</div>
        )}
      </Block>

      {/* KV latency samples */}
      <Block>
        <div style={{ marginBottom: "8px", fontWeight: 600 }}>
          KV latency samples{" "}
          {status?.firstRun ? `(${status.firstRun.kvLatencySamples.length})` : ""}
        </div>
        {adminError ? (
          <div style={{ color: "#9ca3af", fontSize: "14px" }}>admin auth required</div>
        ) : status?.firstRun ? (
          status.firstRun.kvLatencySamples.length === 0 ? (
            <div style={{ color: "#6b7280", fontSize: "14px" }}>no samples yet</div>
          ) : (
            <table
              style={{ width: "100%", fontSize: "13px", fontFamily: "ui-monospace, monospace" }}
            >
              <thead>
                <tr
                  style={{ textAlign: "left", color: "#6b7280", borderBottom: "1px solid #1f2937" }}
                >
                  <th style={{ padding: "4px 8px" }}>timestamp</th>
                  <th style={{ padding: "4px 8px" }}>op</th>
                  <th style={{ padding: "4px 8px", textAlign: "right" }}>duration</th>
                </tr>
              </thead>
              <tbody>
                {status.firstRun.kvLatencySamples
                  .slice()
                  .reverse()
                  .map((s, i) => (
                    <tr key={i}>
                      <td style={{ padding: "4px 8px", color: "#9ca3af" }}>{s.at}</td>
                      <td style={{ padding: "4px 8px" }}>{s.op}</td>
                      <td style={{ padding: "4px 8px", textAlign: "right" }}>{s.durationMs}ms</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )
        ) : (
          <div style={{ color: "#6b7280", fontSize: "14px" }}>loading…</div>
        )}
      </Block>

      {/* Env presence checklist */}
      <Block>
        <div style={{ marginBottom: "8px", fontWeight: 600 }}>
          Environment variables (presence only — values never shown)
        </div>
        {adminError ? (
          <div style={{ color: "#9ca3af", fontSize: "14px" }}>admin auth required</div>
        ) : status?.firstRun ? (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
              gap: "4px 12px",
              fontSize: "13px",
              fontFamily: "ui-monospace, monospace",
            }}
          >
            {Object.entries(status.firstRun.envPresent).map(([k, v]) => (
              <div key={k} style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                <span style={{ color: v ? "#6ee7b7" : "#4b5563", fontWeight: 700 }}>
                  {v ? "●" : "○"}
                </span>
                <span style={{ color: v ? "#e5e7eb" : "#6b7280" }}>{k}</span>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ color: "#6b7280", fontSize: "14px" }}>loading…</div>
        )}
      </Block>
    </div>
  );
}
