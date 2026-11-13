/**
 * Connectors section — split into two tiers:
 * 1. Pre-wired integrations, long tail first (what native client
 *    connectors don't cover, or cover in one client only)
 * 2. Extension primitives (3 ways to grow the hub without forking)
 *
 * Kebab House (ADR 0004): no tool counts in marketing copy — each card
 * says what the connector does instead.
 */
const INTEGRATIONS = [
  { name: "LinkedIn", what: "Profiles, posts, messages" },
  { name: "WhatsApp", what: "Inbox, search, send" },
  { name: "Browser Automation", what: "Browse, extract, act" },
  { name: "Paywall Readers", what: "Read full articles" },
  { name: "Obsidian Vault", what: "Your notes on GitHub" },
  { name: "Google Workspace", what: "Gmail, Calendar, Drive" },
  { name: "Slack", what: "Channels and threads" },
  { name: "Notion", what: "Pages and databases" },
  { name: "GitHub Issues · Linear", what: "Issues and tickets" },
  { name: "Airtable", what: "Bases and records" },
  { name: "Composio Bridge", what: "1000+ apps" },
  { name: "Webhooks", what: "Inbound events" },
];

const PRIMITIVES = [
  {
    name: "API Connections",
    icon: <SkewerIcon variant="filled" />,
    body: "Wire any HTTP API as a tool — no code. URL, method, JSON Schema. Kebab infers types and registers the tool at runtime.",
  },
  {
    name: "Custom Tools",
    icon: <BookIcon />,
    body: "Compose existing tools into a new one with pre-filled arguments — declarative, from the dashboard.",
  },
  {
    name: "Admin & observability",
    icon: <GaugeIcon />,
    body: "Health checks, structured logs, rate limiting, durable bootstrap diagnostics — the back office is built in.",
  },
];

export default function Connectors() {
  return (
    <section id="whats-inside" className="py-20 px-6 border-t border-slate-800">
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-12">
          <p className="text-xs font-mono text-amber-400 mb-3 tracking-widest uppercase">
            Everything in the wrap
          </p>
          <h2 className="text-3xl sm:text-4xl font-bold text-white tracking-tight">
            The long tail, on the skewer.
          </h2>
          <p className="text-slate-400 text-base mt-3 max-w-2xl mx-auto leading-relaxed">
            The tools your clients don&apos;t ship natively, or ship in only one of them. Drop in an
            API key — the connector lights up, in every client at once.
          </p>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 mb-16">
          {INTEGRATIONS.map((conn) => (
            <div
              key={conn.name}
              className="bg-slate-900/60 border border-slate-800 rounded-lg px-4 py-3.5 hover:border-amber-500/40 hover:bg-amber-500/5 transition-colors"
            >
              <p className="text-sm font-semibold text-white">{conn.name}</p>
              <p className="text-xs text-slate-500 font-mono mt-0.5">{conn.what}</p>
            </div>
          ))}
        </div>

        <div className="text-center mb-10">
          <p className="text-xs font-mono text-blue-400 mb-3 tracking-widest uppercase">
            Bring your own sauce
          </p>
          <h3 className="text-2xl sm:text-3xl font-bold text-white tracking-tight">
            Extend without forking.
          </h3>
          <p className="text-slate-400 text-sm mt-3 max-w-xl mx-auto leading-relaxed">
            Three primitives that ship inside every Kebab — your hub grows with your stack.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
          {PRIMITIVES.map((p) => (
            <div
              key={p.name}
              className="bg-slate-900 border border-slate-800 rounded-xl p-6 hover:border-slate-700 transition-colors"
            >
              <div className="text-amber-400 mb-4">{p.icon}</div>
              <h4 className="text-white font-semibold text-base mb-2">{p.name}</h4>
              <p className="text-slate-400 text-sm leading-relaxed">{p.body}</p>
            </div>
          ))}
        </div>

        <p className="text-center text-xs text-slate-500 mt-10">
          Missing an integration?{" "}
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

function SkewerIcon({ variant = "outline" }: { variant?: "outline" | "filled" }) {
  const fill = variant === "filled" ? "currentColor" : "none";
  return (
    <svg
      className="w-7 h-7"
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <line x1="3" y1="20" x2="29" y2="14" strokeLinecap="round" strokeWidth="2" />
      <circle cx="10" cy="18.5" r="3" fill={fill} />
      <rect x="14" y="13.5" width="5" height="5" rx="0.8" fill={fill} />
      <circle cx="23" cy="14.5" r="2.6" fill={fill} />
    </svg>
  );
}

function BookIcon() {
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
        d="M4 5a2 2 0 012-2h12a2 2 0 012 2v14l-4-2-4 2-4-2-4 2V5z"
      />
      <path strokeLinecap="round" d="M8 8h8M8 12h6" />
    </svg>
  );
}

function GaugeIcon() {
  return (
    <svg
      className="w-7 h-7"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 13a9 9 0 0118 0" />
      <path strokeLinecap="round" d="M12 13l4-4" />
      <circle cx="12" cy="13" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}
