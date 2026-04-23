"use client";

/**
 * Phase 53 — top-10 slowest tools horizontal bar chart.
 *
 * Layout: vertical BarChart (tools on Y axis, p95Ms on X axis). Color
 * amber to visually differentiate from the blue Request count chart.
 * Empty input → friendly fallback.
 */

import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";

export interface LatencyBarChartProps {
  tools: Array<{ name: string; p95Ms: number; calls: number }>;
}

export function LatencyBarChart({ tools }: LatencyBarChartProps) {
  return (
    <div
      style={{
        background: "#111827",
        border: "1px solid #1f2937",
        borderRadius: "6px",
        padding: "12px 16px",
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: "8px" }}>p95 latency — slowest tools</div>
      {tools.length === 0 ? (
        <div style={{ color: "#6b7280", fontSize: "14px", padding: "32px 8px" }}>
          No latency data yet.
        </div>
      ) : (
        <ResponsiveContainer width="100%" aspect={1.5}>
          <BarChart data={tools} layout="vertical" margin={{ left: 20, right: 20 }}>
            <CartesianGrid stroke="#1f2937" strokeDasharray="3 3" horizontal={false} />
            <XAxis type="number" stroke="#6b7280" fontSize={11} unit="ms" />
            <YAxis
              dataKey="name"
              type="category"
              stroke="#6b7280"
              fontSize={11}
              width={150}
              interval={0}
            />
            <Tooltip
              contentStyle={{ background: "#111827", border: "1px solid #1f2937" }}
              labelStyle={{ color: "#e5e7eb" }}
              formatter={(value: number) => [`${value} ms`, "p95"]}
            />
            <Bar dataKey="p95Ms" fill="#f59e0b" />
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
