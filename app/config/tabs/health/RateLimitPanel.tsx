"use client";

/**
 * Phase 53 — rate-limit bucket table.
 *
 * Columns: Tenant (masked) | Scope | Current / Max | Reset. Rows are
 * sorted by utilization percentage descending by the route; we render
 * as-received. Empty state surfaces a friendly "nothing to see here"
 * instead of an empty table to keep the panel purposeful.
 */

export interface RateLimitBucket {
  tenantIdMasked: string;
  scope: string;
  current: number;
  max: number;
  resetAt: number;
}

export interface RateLimitPanelProps {
  buckets: RateLimitBucket[];
}

function formatReset(ts: number): string {
  const delta = Math.max(0, ts - Date.now());
  const secs = Math.round(delta / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.round(secs / 60)}m`;
}

export function RateLimitPanel({ buckets }: RateLimitPanelProps) {
  return (
    <div
      style={{
        background: "#111827",
        border: "1px solid #1f2937",
        borderRadius: "6px",
        padding: "12px 16px",
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: "8px" }}>Rate-limit buckets</div>
      {buckets.length === 0 ? (
        <div style={{ color: "#6b7280", fontSize: "14px", padding: "16px 0" }}>
          No active rate-limit buckets in this minute window.
        </div>
      ) : (
        <table
          style={{
            width: "100%",
            fontSize: "13px",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          }}
        >
          <thead>
            <tr style={{ textAlign: "left", color: "#6b7280", borderBottom: "1px solid #1f2937" }}>
              <th style={{ padding: "4px 8px" }}>Tenant</th>
              <th style={{ padding: "4px 8px" }}>Scope</th>
              <th style={{ padding: "4px 8px", textAlign: "right" }}>Current</th>
              <th style={{ padding: "4px 8px", textAlign: "right" }}>Max</th>
              <th style={{ padding: "4px 8px", textAlign: "right" }}>Reset in</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((b, i) => {
              const pct = b.max > 0 ? Math.round((b.current / b.max) * 100) : 0;
              const tone = pct >= 90 ? "#fca5a5" : pct >= 75 ? "#fcd34d" : "#e5e7eb";
              return (
                <tr key={`${b.tenantIdMasked}:${b.scope}:${i}`}>
                  <td style={{ padding: "4px 8px", color: "#9ca3af" }}>{b.tenantIdMasked}</td>
                  <td style={{ padding: "4px 8px" }}>{b.scope}</td>
                  <td style={{ padding: "4px 8px", textAlign: "right", color: tone }}>
                    {b.current}
                  </td>
                  <td style={{ padding: "4px 8px", textAlign: "right", color: "#6b7280" }}>
                    {b.max}
                  </td>
                  <td style={{ padding: "4px 8px", textAlign: "right", color: "#6b7280" }}>
                    {formatReset(b.resetAt)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
