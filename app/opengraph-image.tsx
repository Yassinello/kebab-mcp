import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt = "Kebab MCP — Give every AI client the same superpowers";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/**
 * Dynamic OG image rendered at the edge. Avoids shipping a binary asset
 * (re-rendered on rebrand without checking a PNG into git) and stays in
 * sync with the actual landing wording.
 *
 * Layout: amber gradient background, big H1 left, mini-skewer SVG right.
 * Pure inline SVG + system fonts — no external font fetch (which would
 * occasionally fail and break OG previews on Twitter/Slack).
 */
export default async function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background:
            "linear-gradient(135deg, #0f172a 0%, #1e293b 60%, #422006 100%)",
          padding: "70px 80px",
          fontFamily: "system-ui, -apple-system, sans-serif",
          color: "white",
          position: "relative",
        }}
      >
        {/* Eyebrow */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            color: "#fbbf24",
            fontSize: 24,
            fontWeight: 600,
            letterSpacing: 4,
            textTransform: "uppercase",
            marginBottom: 28,
          }}
        >
          {/* Mini logo — three chunks on a stick */}
          <svg width="48" height="48" viewBox="0 0 32 32" fill="none">
            <line x1="3" y1="17.5" x2="29" y2="14.5" stroke="#fbbf24" strokeWidth="2.5" strokeLinecap="round" />
            <line x1="3" y1="15" x2="3" y2="20" stroke="#fbbf24" strokeWidth="2.5" strokeLinecap="round" />
            <circle cx="9.5" cy="16.7" r="3.4" fill="#fbbf24" />
            <rect x="13.2" y="12.4" width="6" height="6" rx="1" fill="#f97316" />
            <circle cx="22.5" cy="14.7" r="3" fill="#fbbf24" />
            <path d="M26 14.2 L29 14.5 L26.5 16 Z" fill="#fbbf24" />
          </svg>
          <span>Kebab MCP</span>
        </div>

        {/* Main headline */}
        <div
          style={{
            display: "flex",
            fontSize: 72,
            fontWeight: 800,
            lineHeight: 1.05,
            letterSpacing: "-0.03em",
            maxWidth: 720,
            marginBottom: 28,
          }}
        >
          Give every AI client the same superpowers.
        </div>

        {/* Subheadline */}
        <div
          style={{
            display: "flex",
            fontSize: 30,
            color: "#94a3b8",
            maxWidth: 820,
            lineHeight: 1.3,
            marginBottom: "auto",
          }}
        >
          One Vercel deploy. 86+ tools across 15 connectors. Self-hosted, MIT licensed.
        </div>

        {/* Footer row */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontSize: 22,
            color: "#64748b",
            fontFamily: "ui-monospace, SF Mono, Menlo, monospace",
          }}
        >
          <div style={{ display: "flex", gap: 28 }}>
            <span>Claude</span>
            <span>·</span>
            <span>Cursor</span>
            <span>·</span>
            <span>Windsurf</span>
            <span>·</span>
            <span>any MCP client</span>
          </div>
          <span style={{ color: "#fbbf24" }}>kebab-mcp</span>
        </div>

        {/* Decorative skewer in bottom-right */}
        <div
          style={{
            display: "flex",
            position: "absolute",
            bottom: 80,
            right: 60,
            opacity: 0.9,
          }}
        >
          <svg width="280" height="200" viewBox="0 0 320 220" fill="none">
            <line x1="20" y1="130" x2="300" y2="115" stroke="#cbd5e1" strokeWidth="4" strokeLinecap="round" />
            <line x1="22" y1="115" x2="22" y2="145" stroke="#cbd5e1" strokeWidth="5" strokeLinecap="round" />
            <circle cx="70" cy="127" r="22" fill="#fbbf24" />
            <rect x="105" y="106" width="44" height="44" rx="4" fill="#f97316" />
            <circle cx="180" cy="121" r="24" fill="#fbbf24" />
            <rect x="210" y="100" width="40" height="40" rx="4" fill="#f97316" />
            <circle cx="275" cy="116" r="20" fill="#fbbf24" />
            <path d="M298 113 L312 115 L300 122 Z" fill="#cbd5e1" />
            {/* Flame */}
            <path
              d="M100 175 q15 -25 30 -10 q15 -25 30 -5 q15 -30 30 -5 q15 -25 30 -10 q15 25 -30 35 q-45 5 -90 -5 z"
              fill="#dc2626"
              opacity="0.85"
            />
          </svg>
        </div>
      </div>
    ),
    { ...size },
  );
}
