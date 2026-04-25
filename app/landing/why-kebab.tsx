import FeatureCard from "./feature-card";

const CARDS = [
  {
    title: "Same tools everywhere.",
    description:
      "Connect once. Every AI client — Claude, Cursor, Windsurf — gets the exact same 86+ tools from a single endpoint. No per-client setup, no drift.",
    icon: <ThreeSkewersIcon />,
  },
  {
    title: "Bring your own sauce.",
    description:
      "Define custom HTTP tools against any API via API Connections. No code to deploy — just a URL, a method, and a schema. Your workflow, your rules.",
    icon: <SauceBottleIcon />,
  },
  {
    title: "Your kitchen, your rules.",
    description:
      "Runs on your own Vercel account. Your API keys never leave your infra. No SaaS middlemen, no data sharing, no vendor lock-in. Fork and own it.",
    icon: <ChefHatIcon />,
  },
];

export default function WhyKebab() {
  return (
    <section className="py-20 px-6 border-t border-slate-800">
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-12">
          <p className="text-xs font-mono text-amber-400 mb-3 tracking-widest uppercase">
            Why Kebab MCP
          </p>
          <h2 className="text-3xl sm:text-4xl font-bold text-white tracking-tight">
            Your AI stack is hungry. Feed it once.
          </h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
          {CARDS.map((card) => (
            <FeatureCard key={card.title} {...card} />
          ))}
        </div>
      </div>
    </section>
  );
}

/** Three identical skewers stacked — "same tools across clients" */
function ThreeSkewersIcon() {
  return (
    <svg className="w-7 h-7" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.5">
      {[8, 16, 24].map((y) => (
        <g key={y}>
          <line x1="3" y1={y} x2="29" y2={y} strokeLinecap="round" strokeWidth="1.8" />
          <circle cx="9" cy={y} r="2" fill="currentColor" />
          <rect x="13" y={y - 2} width="4" height="4" rx="0.6" fill="currentColor" />
          <circle cx="22" cy={y} r="1.8" fill="currentColor" />
        </g>
      ))}
    </svg>
  );
}

/** Sauce/condiment bottle — "bring your own sauce" */
function SauceBottleIcon() {
  return (
    <svg className="w-7 h-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      {/* Cap */}
      <rect x="9" y="2" width="6" height="3" rx="0.5" fill="currentColor" />
      {/* Neck */}
      <line x1="10.5" y1="5" x2="10.5" y2="8" strokeLinecap="round" />
      <line x1="13.5" y1="5" x2="13.5" y2="8" strokeLinecap="round" />
      {/* Body */}
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 8 L9 20 a2 2 0 002 2 h2 a2 2 0 002 -2 L15 8 Z"
      />
      {/* Label */}
      <rect x="9.5" y="12" width="5" height="5" fill="currentColor" opacity="0.25" />
      {/* Drip */}
      <circle cx="17.5" cy="14" r="0.8" fill="currentColor" />
    </svg>
  );
}

/** Simple chef's toque — "your kitchen, your rules" */
function ChefHatIcon() {
  return (
    <svg className="w-7 h-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M5 14 a3 3 0 010 -6 a4 4 0 017 -3 a4 4 0 017 3 a3 3 0 010 6 Z"
      />
      <path strokeLinecap="round" d="M5 14 v4 a2 2 0 002 2 h10 a2 2 0 002 -2 v-4" />
      <line x1="5" y1="17" x2="19" y2="17" strokeLinecap="round" opacity="0.5" />
    </svg>
  );
}
