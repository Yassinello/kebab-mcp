const TIER1 = ["Claude Desktop", "Claude Code", "Cursor", "Windsurf"];
const TIER2 = ["ChatGPT", "VS Code", "n8n", "Any MCP client"];

export default function Compatibility() {
  return (
    <section className="py-20 px-6 border-t border-slate-800">
      <div className="max-w-4xl mx-auto text-center">
        <p className="text-xs font-mono text-blue-400 mb-3 tracking-widest uppercase">
          Compatibility
        </p>
        <h2 className="text-3xl sm:text-4xl font-bold text-white tracking-tight mb-4">
          One endpoint. Many AI clients.
        </h2>
        <p className="text-slate-400 text-base max-w-xl mx-auto mb-10 leading-relaxed">
          Point any MCP-compatible client at your instance URL and it just works.
        </p>

        <div className="flex flex-col sm:flex-row gap-8 justify-center mb-10">
          <div>
            <p className="text-xs font-mono text-amber-400 uppercase tracking-widest mb-4">
              Tested
            </p>
            <div className="flex flex-wrap justify-center gap-3">
              {TIER1.map((client) => (
                <span
                  key={client}
                  className="bg-amber-500/15 border border-amber-500/40 text-amber-300 font-semibold text-sm px-4 py-2 rounded-lg"
                >
                  {client}
                </span>
              ))}
            </div>
          </div>

          <div className="hidden sm:block w-px bg-slate-800 self-stretch" />

          <div>
            <p className="text-xs font-mono text-slate-500 uppercase tracking-widest mb-4">
              Compatible via Streamable HTTP
            </p>
            <div className="flex flex-wrap justify-center gap-3">
              {TIER2.map((client) => (
                <span
                  key={client}
                  className="border border-slate-700 text-slate-400 font-medium text-sm px-4 py-2 rounded-lg"
                >
                  {client}
                </span>
              ))}
            </div>
          </div>
        </div>

        <div className="inline-flex items-center gap-3 bg-slate-900 border border-blue-500/30 rounded-lg px-5 py-3">
          <span className="text-slate-500 text-xs font-mono">Endpoint</span>
          <code className="text-blue-300 font-mono text-sm tracking-tight">
            https://your-instance.vercel.app/api/mcp
          </code>
        </div>
      </div>
    </section>
  );
}
