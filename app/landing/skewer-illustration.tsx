/**
 * Hero illustration — a horizontal kebab skewer threaded with the five
 * ingredients of the hub (skills, profile, memory, tools, guardrails), each
 * drawn as a simple glyph. Deliberately no third-party service logos: the
 * landing tells people to use their client's own Gmail/Slack/Notion
 * connectors. A subtle flame underneath sells the "hot off the grill"
 * metaphor. Pure inline SVG — no image asset, scales freely.
 */
export default function SkewerIllustration() {
  return (
    <svg
      viewBox="0 0 480 360"
      xmlns="http://www.w3.org/2000/svg"
      className="w-full h-auto max-w-lg mx-auto"
      role="img"
      aria-labelledby="hero-skewer-title"
    >
      <title id="hero-skewer-title">
        A kebab skewer threaded with the five ingredients: skills, profile, memory, tools and
        guardrails
      </title>
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

      {/* Five chunks alternating veg / meat / veg / meat / veg — one per ingredient */}
      {/* Chunk 1 — Skills (veg-style round): a lightning bolt */}
      <g transform="translate(75, 188)">
        <circle r="34" fill="url(#hero-veg)" />
        <circle r="34" fill="none" stroke="#92400e" strokeWidth="1.5" opacity="0.4" />
        <path
          d="M3 -17 L-10 3 L-1 3 L-4 17 L10 -4 L1 -4 Z"
          fill="#fef3c7"
          stroke="#7c2d12"
          strokeWidth="2"
          strokeLinejoin="round"
        />
      </g>

      {/* Chunk 2 — Profile (meat-style cube): a head and shoulders */}
      <g transform="translate(160, 184) rotate(-3)">
        <rect x="-32" y="-32" width="64" height="64" rx="6" fill="url(#hero-meat)" />
        <rect
          x="-32"
          y="-32"
          width="64"
          height="64"
          rx="6"
          fill="none"
          stroke="#7c2d12"
          strokeWidth="1.5"
          opacity="0.5"
        />
        <circle cx="0" cy="-7" r="8" fill="#fef3c7" />
        <path d="M-15 17 a15 13 0 0 1 30 0 Z" fill="#fef3c7" />
      </g>

      {/* Chunk 3 — Memory (veg-style round, larger): a notebook */}
      <g transform="translate(248, 180)">
        <circle r="36" fill="url(#hero-veg)" />
        <circle r="36" fill="none" stroke="#92400e" strokeWidth="1.5" opacity="0.4" />
        <g
          transform="translate(-12, -15)"
          stroke="#7c2d12"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="0" y="0" width="24" height="30" rx="2.5" fill="#fef3c7" />
          <line x1="7" y1="0" x2="7" y2="30" />
          <line x1="12" y1="9" x2="19" y2="9" />
          <line x1="12" y1="15" x2="19" y2="15" />
        </g>
      </g>

      {/* Chunk 4 — Tools (meat-style cube): a wrench */}
      <g transform="translate(336, 175) rotate(2)">
        <rect x="-30" y="-30" width="60" height="60" rx="6" fill="url(#hero-meat)" />
        <rect
          x="-30"
          y="-30"
          width="60"
          height="60"
          rx="6"
          fill="none"
          stroke="#7c2d12"
          strokeWidth="1.5"
          opacity="0.5"
        />
        <g transform="rotate(45)">
          <rect x="-3.5" y="-4" width="7" height="22" rx="3" fill="#fef3c7" />
          <path d="M-9 -12 a9 9 0 1 0 18 0 l0 -5 l-5 0 l0 5 l-8 0 l0 -5 l-5 0 Z" fill="#fef3c7" />
        </g>
      </g>

      {/* Chunk 5 — Guardrails (veg-style round, smaller, near tip): a shield */}
      <g transform="translate(415, 172)">
        <circle r="28" fill="url(#hero-veg)" />
        <circle r="28" fill="none" stroke="#92400e" strokeWidth="1.5" opacity="0.4" />
        <g
          transform="translate(-11, -13)"
          stroke="#7c2d12"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M11 0 L0 4 v8 c0 7 5 12 11 14 c6 -2 11 -7 11 -14 v-8 Z" fill="#fef3c7" />
          <path d="M6 13 l4 4 l6 -7" fill="none" />
        </g>
      </g>

      {/* Ingredient labels */}
      <g
        fontSize="15"
        fontWeight="600"
        fontFamily="ui-sans-serif, system-ui, sans-serif"
        fill="#cbd5e1"
        textAnchor="middle"
      >
        <text x="75" y="140">
          Skills
        </text>
        <text x="160" y="136">
          Profile
        </text>
        <text x="248" y="129">
          Memory
        </text>
        <text x="336" y="130">
          Tools
        </text>
        <text x="415" y="129">
          Guardrails
        </text>
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
        <path d="M120 100 q-8 -10 0 -20 q8 -10 0 -20" />
        <path d="M250 95 q-8 -10 0 -20 q8 -10 0 -20" />
        <path d="M380 100 q-8 -10 0 -20 q8 -10 0 -20" />
      </g>
    </svg>
  );
}
