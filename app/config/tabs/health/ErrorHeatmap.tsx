"use client";

/**
 * Phase 53 — connector × hour error heatmap (SVG, not Recharts).
 *
 * 24 columns (hours, newest on the right) × N connector rows.
 * Cell intensity = `log10(errors + 1) / log10(maxErrors + 1)` so
 * 1 error vs 100 errors stay visually distinct. Pure black-on-red
 * gradient = catastrophic; light gray = zero errors but active;
 * empty (no total) = dark gray.
 *
 * No Recharts dep added here — a log-scale heatmap is 40 lines of
 * SVG and adding a library dep for it would inflate /config further.
 */

import type { MouseEvent } from "react";
import { useMemo, useState } from "react";

export interface ErrorHeatmapProps {
  connectors: Array<{
    connectorId: string;
    hours: Array<{ ts: number; errors: number; total: number }>;
  }>;
}

interface TooltipState {
  x: number;
  y: number;
  text: string;
}

const CELL_WIDTH = 16;
const CELL_HEIGHT = 24;
const CELL_GAP = 2;
const LABEL_WIDTH = 120;

function formatHour(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:00`;
}

function cellFill(errors: number, total: number, maxErrors: number): string {
  if (total === 0) return "#1f2937"; // dark gray - no activity
  if (errors === 0) return "#1f2937aa"; // slightly lighter gray - active no errors
  if (maxErrors <= 0) return "#1f2937";
  // log-scale intensity: 1 error vs 100 errors stay distinguishable.
  const numerator = Math.log10(errors + 1);
  const denominator = Math.log10(maxErrors + 1) || 1;
  const intensity = Math.max(0.1, Math.min(1, numerator / denominator));
  // Red scale: base hsl(0, 70%, L%) with L decreasing as intensity rises.
  const lightness = Math.round(65 - intensity * 40); // 65% -> 25%
  return `hsl(0, 70%, ${lightness}%)`;
}

export function ErrorHeatmap({ connectors }: ErrorHeatmapProps) {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  const maxErrors = useMemo(() => {
    let max = 0;
    for (const c of connectors) {
      for (const h of c.hours) {
        if (h.errors > max) max = h.errors;
      }
    }
    return max;
  }, [connectors]);

  if (connectors.length === 0) {
    return (
      <div
        style={{
          background: "#111827",
          border: "1px solid #1f2937",
          borderRadius: "6px",
          padding: "12px 16px",
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: "8px" }}>Errors by connector</div>
        <div style={{ color: "#6b7280", fontSize: "14px", padding: "24px 8px" }}>
          No connector activity reported in the 24h window.
        </div>
      </div>
    );
  }

  const hoursCount = connectors[0]?.hours.length ?? 24;
  const width = LABEL_WIDTH + hoursCount * (CELL_WIDTH + CELL_GAP);
  const height = connectors.length * (CELL_HEIGHT + CELL_GAP) + 24;

  const onCellEnter = (
    event: MouseEvent<SVGRectElement>,
    connectorId: string,
    hour: { ts: number; errors: number; total: number }
  ) => {
    setTooltip({
      x: event.clientX,
      y: event.clientY,
      text: `${connectorId} @ ${formatHour(hour.ts)} — ${hour.errors} errors / ${hour.total} total`,
    });
  };

  const onCellLeave = () => setTooltip(null);

  return (
    <div
      style={{
        background: "#111827",
        border: "1px solid #1f2937",
        borderRadius: "6px",
        padding: "12px 16px",
        position: "relative",
        overflow: "auto",
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: "8px" }}>Errors by connector × hour</div>
      <svg width={width} height={height} style={{ fontFamily: "ui-monospace, monospace" }}>
        {/* header row — show "24h ago" / "now" markers */}
        <text x={LABEL_WIDTH} y={12} fill="#6b7280" fontSize={10}>
          24h ago
        </text>
        <text
          x={LABEL_WIDTH + (hoursCount - 1) * (CELL_WIDTH + CELL_GAP)}
          y={12}
          fill="#6b7280"
          fontSize={10}
          textAnchor="end"
        >
          now
        </text>
        {connectors.map((c, rowIdx) => {
          // The data comes back newest-first, but the heatmap reads
          // left-to-right oldest → newest, so reverse once here.
          const hoursLR = [...c.hours].reverse();
          const y = 20 + rowIdx * (CELL_HEIGHT + CELL_GAP);
          return (
            <g key={c.connectorId}>
              <text x={0} y={y + CELL_HEIGHT / 2 + 4} fill="#9ca3af" fontSize={11}>
                {c.connectorId}
              </text>
              {hoursLR.map((h, hIdx) => (
                <rect
                  key={h.ts}
                  x={LABEL_WIDTH + hIdx * (CELL_WIDTH + CELL_GAP)}
                  y={y}
                  width={CELL_WIDTH}
                  height={CELL_HEIGHT}
                  fill={cellFill(h.errors, h.total, maxErrors)}
                  onMouseEnter={(e) => onCellEnter(e, c.connectorId, h)}
                  onMouseLeave={onCellLeave}
                />
              ))}
            </g>
          );
        })}
      </svg>
      {tooltip && (
        <div
          role="tooltip"
          style={{
            position: "fixed",
            left: tooltip.x + 12,
            top: tooltip.y + 12,
            background: "#111827",
            border: "1px solid #1f2937",
            borderRadius: "4px",
            padding: "4px 8px",
            color: "#e5e7eb",
            fontSize: "12px",
            pointerEvents: "none",
            zIndex: 50,
          }}
        >
          {tooltip.text}
        </div>
      )}
    </div>
  );
}
