import { REPO_URL } from "./deploy-url";

/**
 * Tools section — only what the clients' own connectors lack. Gmail, Slack,
 * Notion and friends still exist in Kebab House but are no longer promoted:
 * most clients ship them natively, so the landing says to use those.
 *
 * Kebab House (ADR 0004): no tool counts in marketing copy — each item says
 * what it does instead.
 */
const LONG_TAIL = [
  { name: "LinkedIn", what: "Profiles, posts, messages" },
  { name: "WhatsApp", what: "Inbox, search, send" },
  { name: "Browser automation", what: "Browse, extract, act" },
  { name: "Paywalled articles", what: "Read the full text" },
  { name: "Apify scrapers", what: "Ready-made web scrapers" },
  { name: "Webhooks", what: "Receive outside events" },
  { name: "Any HTTP API", what: "Becomes a tool, no code" },
  { name: "Custom tools", what: "Combine tools into one" },
];

const ALSO_AVAILABLE = ["Google Workspace", "Slack", "Notion", "GitHub", "Linear", "Airtable"];

export default function Connectors() {
  return (
    <section id="whats-inside" className="py-10 sm:py-12 px-6 border-t border-slate-800">
      <div className="max-w-5xl mx-auto">
        <div className="text-center mb-6 sm:mb-8">
          <p className="text-xs font-mono text-amber-400 mb-3 tracking-widest uppercase">Tools</p>
          <h2 className="text-2xl sm:text-4xl font-bold text-white tracking-tight">
            What your clients don&apos;t ship.
          </h2>
          <p className="text-slate-400 text-base mt-3 max-w-2xl mx-auto leading-relaxed">
            Turn one on once, with your own key, and it works in every connected client.
          </p>
        </div>

        <ul className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-3 mb-6">
          {LONG_TAIL.map((tool) => (
            <li
              key={tool.name}
              className="bg-slate-900/60 border border-slate-800 rounded-lg px-3 sm:px-4 py-3"
            >
              <p className="text-sm font-semibold text-white">{tool.name}</p>
              <p className="text-xs text-slate-500 mt-0.5">{tool.what}</p>
            </li>
          ))}
        </ul>

        <p className="text-center text-sm text-slate-400 leading-relaxed">
          <span className="text-slate-300 font-medium">Also available:</span>{" "}
          {ALSO_AVAILABLE.join(", ")} — but use your client&apos;s own when it has one.
        </p>
        <p className="text-center text-xs text-slate-500 mt-3">
          Missing one?{" "}
          <a
            href={`${REPO_URL}/blob/main/docs/CONNECTOR-AUTHORING.md`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-slate-300 hover:text-white underline"
          >
            Write a connector
          </a>{" "}
          in a few dozen lines of TypeScript.
        </p>
      </div>
    </section>
  );
}
