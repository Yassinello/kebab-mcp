import FeatureCard from "./feature-card";

const PILLARS = [
  {
    title: "Built-in connectors (15)",
    description:
      "Google Workspace, Obsidian Vault, Slack, Notion, GitHub, Linear, Airtable, Apify, Browser Automation, Paywall Readers, Composio, Webhooks, Skills, API Connections, Admin — 86+ tools, all pre-wired. Drop in an API key, the connector lights up.",
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"
        />
      </svg>
    ),
  },
  {
    title: "API Connections",
    description:
      "Wire any HTTP API as a tool without writing code. Define a URL, method, and JSON Schema — Kebab MCP infers types, stores the schema, and registers it as a live tool at runtime.",
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
        />
      </svg>
    ),
  },
  {
    title: "Skills",
    description:
      "Define reusable prompt-driven tools from the dashboard — no deployment needed. Great for team playbooks, SOPs, or recurring AI workflows you want on-tap.",
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
        />
      </svg>
    ),
  },
  {
    title: "Admin & observability",
    description:
      "Health checks, structured logs, rate limiting, durable bootstrap diagnostics, and an auth-gated dashboard — all built in. No extra tooling to wire up.",
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
        />
      </svg>
    ),
  },
];

export default function Connectors() {
  return (
    <section id="whats-inside" className="py-20 px-6 border-t border-slate-800">
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-12">
          <p className="text-xs font-mono text-blue-400 mb-3 tracking-widest uppercase">
            What&apos;s inside
          </p>
          <h2 className="text-3xl sm:text-4xl font-bold text-white tracking-tight">
            Everything in the wrap.
          </h2>
          <p className="text-slate-400 text-base mt-3 max-w-2xl mx-auto leading-relaxed">
            86+ tools across 15 connectors — plus the primitives to extend it with any API, no code
            required.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          {PILLARS.map((pillar) => (
            <FeatureCard key={pillar.title} {...pillar} />
          ))}
        </div>

        <p className="text-center text-xs text-slate-500 mt-8">
          Missing a connector?{" "}
          <a
            href="https://github.com/Yassinello/kebab-mcp#adding-a-connector"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-400 hover:text-blue-300 underline underline-offset-2"
          >
            Adding one
          </a>{" "}
          is ~40 lines of TypeScript.
        </p>
      </div>
    </section>
  );
}
