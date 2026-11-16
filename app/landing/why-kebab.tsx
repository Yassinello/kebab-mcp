import { PRODUCT } from "@/core/constants/brand";
import FeatureCard from "./feature-card";

/**
 * LND-01 (spec phase 3) — "the ingredients": what goes into the hub. The
 * tool count is deliberately not the pitch; what matters is that the same
 * five things follow the user into every client.
 */
const CARDS = [
  {
    title: "Skills",
    description:
      "One library of Agent Skills, loaded on demand by every client. Start from ritual templates (morning brief, meeting prep, handoff) or write your own.",
    icon: <ThreeSkewersIcon />,
  },
  {
    title: "Profile",
    description:
      "Who you are, what you work on, how you like answers. One profile per hat (work, home), bound to the client that uses it.",
    icon: <RecipeCardIcon />,
  },
  {
    title: "Memory",
    description:
      "Notes every client can read and write: built in, or your Obsidian repo on GitHub. “Remember this” in one client, find it in the next.",
    icon: <NotebookIcon />,
  },
  {
    title: "Tools",
    description:
      "Only what your clients' own connectors lack: LinkedIn, WhatsApp, a real browser, paywalled articles, any HTTP API as a tool.",
    icon: <ChefHatIcon />,
  },
  {
    title: "Guardrails",
    description:
      "Outside content is labelled as data, messages wait for your approval, and each client gets only the access you choose.",
    icon: <ShieldIcon />,
  },
];

export default function WhyKebab() {
  return (
    <section id="ingredients" className="py-10 sm:py-12 px-6 border-t border-slate-800">
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-6 sm:mb-8">
          <p className="text-xs font-mono text-amber-400 mb-3 tracking-widest uppercase">
            The ingredients
          </p>
          <h2 className="text-2xl sm:text-4xl font-bold text-white tracking-tight">
            Five ingredients, kept in one place.
          </h2>
          <p className="hidden sm:block text-slate-400 text-base mt-3 max-w-2xl mx-auto leading-relaxed">
            {PRODUCT.name} is a hub, not an agent: your AI clients do the thinking, and every one of
            them gets the same five things.
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 sm:gap-4">
          {CARDS.map((card) => (
            <FeatureCard key={card.title} {...card} />
          ))}
        </div>
      </div>
    </section>
  );
}

/** Notebook with a bookmark — the memory vault. */
function NotebookIcon() {
  return (
    <svg
      className="w-7 h-7"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="M9 3v18" />
      <path d="M13 8h3M13 12h3" />
    </svg>
  );
}

/** Shield with a check — guardrails. */
function ShieldIcon() {
  return (
    <svg
      className="w-7 h-7"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 3 5 6v5c0 4.5 3 8.2 7 10 4-1.8 7-5.5 7-10V6l-7-3z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
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
