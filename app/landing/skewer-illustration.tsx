/**
 * Hero illustration — the money shot. A horizontal kebab skewer threaded
 * with five chunks, each labelled with a tool name (Gmail, Notion,
 * Slack, GitHub, Calendar). A subtle flame underneath sells the "hot off
 * the grill" metaphor. Pure SVG — no image asset, scales freely, ships
 * inside the JS bundle (~3KB gzipped).
 */
export default function SkewerIllustration() {
  return (
    <svg
      viewBox="0 0 480 360"
      xmlns="http://www.w3.org/2000/svg"
      className="w-full h-auto max-w-lg mx-auto"
      role="img"
      aria-label="A kebab skewer threaded with the icons of Gmail, Notion, Slack, GitHub and Google Calendar"
    >
      <defs>
        <linearGradient id="hero-meat" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#fbbf24" />
          <stop offset="100%" stopColor="#d97706" />
        </linearGradient>
        <linearGradient id="hero-veg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#fde68a" />
          <stop offset="100%" stopColor="#f59e0b" />
        </linearGradient>
        <linearGradient id="hero-flame" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#fbbf24" />
          <stop offset="50%" stopColor="#f97316" />
          <stop offset="100%" stopColor="#dc2626" />
        </linearGradient>
        <radialGradient id="hero-glow" cx="50%" cy="60%" r="55%">
          <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.3" />
          <stop offset="100%" stopColor="#f59e0b" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Warm radial glow behind */}
      <rect x="0" y="0" width="480" height="360" fill="url(#hero-glow)" />

      {/* Skewer rod — slight upward tilt */}
      <line
        x1="20"
        y1="195"
        x2="460"
        y2="170"
        stroke="#cbd5e1"
        strokeWidth="5"
        strokeLinecap="round"
      />
      {/* Handle cross-bar */}
      <line
        x1="22"
        y1="175"
        x2="22"
        y2="220"
        stroke="#cbd5e1"
        strokeWidth="6"
        strokeLinecap="round"
      />
      {/* Sharpened tip */}
      <path d="M455 167 L472 169 L460 178 Z" fill="#cbd5e1" />

      {/* Five chunks alternating veg / meat / veg / meat / veg */}
      {/* Chunk 1 — Gmail (veg-style round) */}
      <g transform="translate(75, 188)">
        <circle r="34" fill="url(#hero-veg)" />
        <circle r="34" fill="none" stroke="#92400e" strokeWidth="1.5" opacity="0.4" />
        {/* Mini Gmail mark — envelope */}
        <g transform="translate(-14, -10)" stroke="#7c2d12" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round">
          <rect x="0" y="0" width="28" height="20" rx="2" fill="#fef3c7" />
          <path d="M0 2 L14 12 L28 2" />
        </g>
      </g>

      {/* Chunk 2 — Notion (meat-style cube) */}
      <g transform="translate(160, 184) rotate(-3)">
        <rect x="-32" y="-32" width="64" height="64" rx="6" fill="url(#hero-meat)" />
        <rect x="-32" y="-32" width="64" height="64" rx="6" fill="none" stroke="#7c2d12" strokeWidth="1.5" opacity="0.5" />
        <text
          x="0"
          y="6"
          textAnchor="middle"
          fontSize="24"
          fontWeight="700"
          fontFamily="Georgia, serif"
          fill="#fef3c7"
        >
          N
        </text>
      </g>

      {/* Chunk 3 — Slack (veg-style round, larger) */}
      <g transform="translate(248, 180)">
        <circle r="36" fill="url(#hero-veg)" />
        <circle r="36" fill="none" stroke="#92400e" strokeWidth="1.5" opacity="0.4" />
        {/* Slack hash mark */}
        <g transform="translate(-12, -12)" stroke="#7c2d12" strokeWidth="3" strokeLinecap="round">
          <line x1="6" y1="0" x2="6" y2="24" />
          <line x1="18" y1="0" x2="18" y2="24" />
          <line x1="0" y1="8" x2="24" y2="8" />
          <line x1="0" y1="16" x2="24" y2="16" />
        </g>
      </g>

      {/* Chunk 4 — GitHub (meat-style cube) */}
      <g transform="translate(336, 175) rotate(2)">
        <rect x="-30" y="-30" width="60" height="60" rx="6" fill="url(#hero-meat)" />
        <rect x="-30" y="-30" width="60" height="60" rx="6" fill="none" stroke="#7c2d12" strokeWidth="1.5" opacity="0.5" />
        {/* GH cat silhouette simplified */}
        <path
          d="M0 -16 c-9 0 -16 7 -16 16 c0 7 5 13 11 15 c1 0 1 -1 1 -1 v-3 c-4 1 -6 -2 -6 -2 c-1 -2 -2 -3 -2 -3 c-2 -1 0 -1 0 -1 c2 0 3 2 3 2 c2 3 5 2 7 2 c0 -2 1 -3 2 -4 c-5 -1 -10 -3 -10 -11 c0 -2 1 -4 2 -6 c0 -1 -1 -3 0 -6 c0 0 2 -1 7 2 c2 -1 4 -1 6 -1 c2 0 4 0 6 1 c5 -3 7 -2 7 -2 c1 3 0 5 0 6 c1 2 2 4 2 6 c0 8 -5 10 -10 11 c1 1 2 3 2 5 v6 c0 1 0 2 1 1 c6 -2 11 -8 11 -15 c0 -9 -7 -16 -16 -16z"
          fill="#fef3c7"
        />
      </g>

      {/* Chunk 5 — Calendar (veg-style round, smaller, near tip) */}
      <g transform="translate(415, 172)">
        <circle r="28" fill="url(#hero-veg)" />
        <circle r="28" fill="none" stroke="#92400e" strokeWidth="1.5" opacity="0.4" />
        {/* Mini calendar */}
        <g transform="translate(-10, -10)" stroke="#7c2d12" strokeWidth="1.8" fill="#fef3c7" strokeLinecap="round" strokeLinejoin="round">
          <rect x="0" y="2" width="20" height="18" rx="1.5" />
          <line x1="0" y1="7" x2="20" y2="7" />
          <line x1="6" y1="0" x2="6" y2="4" />
          <line x1="14" y1="0" x2="14" y2="4" />
        </g>
      </g>

      {/* Flame underneath — three tongues */}
      <g transform="translate(240, 280)" opacity="0.95">
        <path
          d="M-90 30 Q-80 -20 -60 10 Q-50 -30 -30 5 Q-15 -40 0 0 Q15 -40 30 5 Q50 -30 60 10 Q80 -20 90 30 Q60 50 0 50 Q-60 50 -90 30 Z"
          fill="url(#hero-flame)"
        />
        <path
          d="M-50 25 Q-40 -5 -20 10 Q0 -15 20 10 Q40 -5 50 25 Q30 40 0 40 Q-30 40 -50 25 Z"
          fill="#fbbf24"
          opacity="0.7"
        />
      </g>

      {/* Wisps of smoke above */}
      <g opacity="0.25" stroke="#94a3b8" strokeWidth="2" fill="none" strokeLinecap="round">
        <path d="M120 130 q-8 -10 0 -20 q8 -10 0 -20" />
        <path d="M250 110 q-8 -10 0 -20 q8 -10 0 -20" />
        <path d="M380 120 q-8 -10 0 -20 q8 -10 0 -20" />
      </g>
    </svg>
  );
}
