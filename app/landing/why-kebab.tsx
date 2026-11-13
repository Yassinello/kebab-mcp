import { PRODUCT } from "@/core/constants/brand";
import FeatureCard from "./feature-card";

const CARDS = [
  {
    title: "Same skills everywhere.",
    description:
      "One Agent Skills library (SKILL.md), served to Claude, Claude Code, Cursor, Codex and ChatGPT. Write or import a skill once, scope it per client token — one hat for work, one for home.",
    icon: <ThreeSkewersIcon />,
  },
  {
    title: "Same you everywhere.",
    description:
      "Your profile and your memory vault travel with you. Every client knows who you are and what you're working on, and can read and write the notes in your vault.",
    icon: <RecipeCardIcon />,
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
            Why {PRODUCT.name}
          </p>
          <h2 className="text-3xl sm:text-4xl font-bold text-white tracking-tight">
            Your AI clients are hungry. Feed them once.
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
    <svg
      className="w-7 h-7"
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
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

/** Recipe card with a portrait — "same you everywhere" (profile + vault) */
function RecipeCardIcon() {
  return (
    <svg
      className="w-7 h-7"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      {/* Card */}
      <rect x="3" y="4" width="18" height="16" rx="2" strokeLinejoin="round" />
      {/* Portrait */}
      <circle cx="8.5" cy="10" r="2" fill="currentColor" />
      <path strokeLinecap="round" d="M5.5 16 a3 3 0 016 0" />
      {/* Notes */}
      <line x1="14" y1="9" x2="18" y2="9" strokeLinecap="round" />
      <line x1="14" y1="12.5" x2="18" y2="12.5" strokeLinecap="round" />
      <line x1="14" y1="16" x2="16.5" y2="16" strokeLinecap="round" />
    </svg>
  );
}

/** Simple chef's toque — "your kitchen, your rules" */
function ChefHatIcon() {
  return (
    <svg
      className="w-7 h-7"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
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
