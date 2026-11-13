/**
 * Honest client matrix (spec phase 0, BRD-01/02 — mirrors the README
 * "Which AI clients?" table). Keep the ChatGPT caveat in sync with it.
 */
const FULL = ["Claude (web + desktop)", "Claude Code", "Cursor", "Codex"];
const COMPATIBLE = ["Windsurf", "VS Code", "n8n", "Any MCP client"];

export default function Compatibility() {
  return (
    <section className="py-20 px-6 border-t border-slate-800">
      <div className="max-w-4xl mx-auto text-center">
        <p className="text-xs font-mono text-blue-400 mb-3 tracking-widest uppercase">
          Compatibility
        </p>
        <h2 className="text-3xl sm:text-4xl font-bold text-white tracking-tight mb-4">
          One kitchen. Many AI clients.
        </h2>
        <p className="text-slate-400 text-base max-w-xl mx-auto mb-10 leading-relaxed">
          Point an MCP client at your instance URL with its own token. Here is what you get in each,
          honestly.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 sm:gap-4 mb-10 text-center">
          <div>
            <p className="text-xs font-mono text-amber-400 uppercase tracking-widest mb-4">Full</p>
            <div className="flex flex-wrap justify-center gap-2">
              {FULL.map((client) => (
                <span
                  key={client}
                  className="bg-amber-500/15 border border-amber-500/40 text-amber-300 font-semibold text-sm px-3 py-1.5 rounded-lg"
                >
                  {client}
                </span>
              ))}
            </div>
            <p className="text-xs text-slate-500 mt-3 leading-relaxed">
              Skills, profile, vault and write actions.
            </p>
          </div>

          <div>
            <p className="text-xs font-mono text-slate-300 uppercase tracking-widest mb-4">
              Partial
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              <span className="border border-slate-600 text-slate-200 font-semibold text-sm px-3 py-1.5 rounded-lg">
                ChatGPT
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-3 leading-relaxed">
              Custom MCP connectors work on the web only; write actions are limited to Business and
              Enterprise plans.
            </p>
          </div>

          <div>
            <p className="text-xs font-mono text-slate-500 uppercase tracking-widest mb-4">
              Compatible
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              {COMPATIBLE.map((client) => (
                <span
                  key={client}
                  className="border border-slate-700 text-slate-400 font-medium text-sm px-3 py-1.5 rounded-lg"
                >
                  {client}
                </span>
              ))}
            </div>
            <p className="text-xs text-slate-500 mt-3 leading-relaxed">
              Any client speaking MCP Streamable HTTP.
            </p>
          </div>
        </div>

        <div className="inline-flex flex-wrap justify-center items-center gap-x-3 gap-y-1 bg-slate-900 border border-blue-500/30 rounded-lg px-5 py-3 max-w-full">
          <span className="text-slate-500 text-xs font-mono">Endpoint</span>
          <code className="text-blue-300 font-mono text-sm tracking-tight break-all">
            https://your-instance.vercel.app/api/mcp
          </code>
        </div>
      </div>
    </section>
  );
}
