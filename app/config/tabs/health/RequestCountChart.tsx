"use client";

/**
 * Phase 53 — 24-hour request count line chart.
 *
 * Recharts LineChart with a ResponsiveContainer so it flexes inside
 * the Health tab grid. X-axis labels render as `HH:MM` to keep the
 * visual density low (24 ticks is already busy). Empty-state text
 * replaces the chart entirely when every bucket is zero — otherwise
 * we'd render an empty axis with no Line path, which is worse.
 *
 * Recharts imports are named ({ LineChart, Line, … }) so Turbopack's
 * tree-shaker can drop the rest of the library. `import * as Rch from
 * "recharts"` would pull in ~50 KB of unused chart types.
 */

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import type { ChangeEventHandler } from "react";

export interface RequestCountChartProps {
  hours: Array<{ ts: number; count: number }>;
  /** Full list of tool names in scope (not just the filtered-in ones). */
  tools: string[];
  /** Current filter value — "" means "All tools". */
  toolFilter: string;
  onToolChange: (next: string) => void;
}

function formatHourLabel(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  return `${hh}:00`;
}

export function RequestCountChart({
  hours,
  tools,
  toolFilter,
  onToolChange,
}: RequestCountChartProps) {
  const totalCount = hours.reduce((s, b) => s + b.count, 0);
  // Chart expects ascending time left-to-right; the API returns
  // descending (current hour first).
  const chartData = [...hours].reverse().map((b) => ({
    ts: b.ts,
    count: b.count,
    label: formatHourLabel(b.ts),
  }));

  const handleToolChange: ChangeEventHandler<HTMLSelectElement> = (event) => {
    onToolChange(event.target.value);
  };

  return (
    <div
      style={{
        background: "#111827",
        border: "1px solid #1f2937",
        borderRadius: "6px",
        padding: "12px 16px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "8px",
        }}
      >
        <div style={{ fontWeight: 600 }}>Requests (last 24h)</div>
        <select
          value={toolFilter}
          onChange={handleToolChange}
          aria-label="Tool filter"
          style={{
            background: "#111827",
            color: "#e5e7eb",
            border: "1px solid #1f2937",
            borderRadius: "4px",
            padding: "4px 8px",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: "13px",
          }}
        >
          <option value="">All tools</option>
          {tools.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>
      {totalCount === 0 ? (
        <div style={{ color: "#6b7280", fontSize: "14px", padding: "32px 8px" }}>
          No requests in the last 24h — make a tool call to populate.
        </div>
      ) : (
        <ResponsiveContainer width="100%" aspect={3}>
          <LineChart data={chartData}>
            <CartesianGrid stroke="#1f2937" strokeDasharray="3 3" />
            <XAxis dataKey="label" stroke="#6b7280" fontSize={11} />
            <YAxis stroke="#6b7280" fontSize={11} allowDecimals={false} />
            <Tooltip
              contentStyle={{ background: "#111827", border: "1px solid #1f2937" }}
              labelStyle={{ color: "#e5e7eb" }}
            />
            <Line type="monotone" dataKey="count" stroke="#60a5fa" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
