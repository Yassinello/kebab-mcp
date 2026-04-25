/**
 * Product section — gives the visitor a tangible look at the dashboard
 * before they're asked to deploy. SVG mockup so we don't ship binary
 * screenshots (keeps bundle in budget and survives rebrands).
 */
export default function Product() {
  return (
    <section id="product" className="py-20 px-6 border-t border-slate-800">
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-12">
          <p className="text-xs font-mono text-blue-400 mb-3 tracking-widest uppercase">
            The dashboard
          </p>
          <h2 className="text-3xl sm:text-4xl font-bold text-white tracking-tight">
            Built-in admin UI. No extra tooling.
          </h2>
          <p className="text-slate-400 text-base mt-3 max-w-2xl mx-auto leading-relaxed">
            Health, logs, connector status, custom tools and skills — all behind one auth-gated
            dashboard. Configure your kebab without leaving the browser.
          </p>
        </div>

        <div className="relative max-w-5xl mx-auto">
          {/* Soft amber glow behind the mockup for warmth */}
          <div
            aria-hidden
            className="absolute inset-0 -z-10 blur-3xl opacity-30"
            style={{
              background:
                "radial-gradient(60% 40% at 50% 30%, rgba(245, 158, 11, 0.35), transparent 70%)",
            }}
          />

          <DashboardMockup />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-10 max-w-4xl mx-auto">
          {[
            {
              label: "Live connector status",
              body: "See at a glance which integrations are wired up — and exactly which env var is missing for the rest.",
            },
            {
              label: "Structured logs",
              body: "Every tool call traced with duration, status, payload size. Filter, search, export.",
            },
            {
              label: "Custom tool builder",
              body: "Define HTTP tools or skills from the UI. Schema inferred, registered at runtime.",
            },
          ].map((feat) => (
            <div
              key={feat.label}
              className="bg-slate-900/40 border border-slate-800 rounded-lg p-4"
            >
              <p className="text-sm font-semibold text-amber-300 mb-1">{feat.label}</p>
              <p className="text-xs text-slate-400 leading-relaxed">{feat.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function DashboardMockup() {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-2xl shadow-amber-500/5">
      {/* Browser chrome */}
      <div className="flex items-center gap-2 bg-slate-950/80 border-b border-slate-800 px-4 py-2.5">
        <span className="w-2.5 h-2.5 rounded-full bg-red-500/70" />
        <span className="w-2.5 h-2.5 rounded-full bg-yellow-500/70" />
        <span className="w-2.5 h-2.5 rounded-full bg-green-500/70" />
        <div className="ml-3 flex-1 max-w-md">
          <div className="bg-slate-800/60 rounded px-3 py-1 text-xs font-mono text-slate-400 truncate">
            your-instance.vercel.app/config
          </div>
        </div>
      </div>

      {/* Dashboard body */}
      <div className="grid grid-cols-12 min-h-[340px] sm:min-h-[420px]">
        {/* Sidebar */}
        <aside className="col-span-3 bg-slate-950/60 border-r border-slate-800 p-4 hidden sm:block">
          <div className="flex items-center gap-2 mb-6">
            <div className="w-5 h-5 rounded bg-amber-500/20 border border-amber-500/40" />
            <span className="text-xs font-mono text-white font-semibold">Kebab MCP</span>
          </div>
          <nav className="space-y-1">
            {[
              { label: "Connectors", active: true },
              { label: "Tools" },
              { label: "Skills" },
              { label: "API Connections" },
              { label: "Logs" },
              { label: "Settings" },
            ].map((item) => (
              <div
                key={item.label}
                className={`text-xs px-2.5 py-1.5 rounded ${
                  item.active
                    ? "bg-amber-500/15 text-amber-300 border-l-2 border-amber-400"
                    : "text-slate-500"
                }`}
              >
                {item.label}
              </div>
            ))}
          </nav>
        </aside>

        {/* Main content */}
        <main className="col-span-12 sm:col-span-9 p-5 sm:p-6">
          <div className="flex items-center justify-between mb-5">
            <div>
              <h3 className="text-white font-semibold text-base">Connectors</h3>
              <p className="text-xs text-slate-500 mt-0.5">15 available · 4 active</p>
            </div>
            <span className="text-[10px] font-mono uppercase tracking-widest text-emerald-400 border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 rounded">
              ● healthy
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
            {[
              { name: "Google", on: true, count: "18" },
              { name: "Slack", on: true, count: "6" },
              { name: "Notion", on: true, count: "5" },
              { name: "GitHub", on: true, count: "6" },
              { name: "Linear", on: false, count: "6" },
              { name: "Airtable", on: false, count: "7" },
              { name: "Apify", on: false, count: "8" },
              { name: "Vault", on: false, count: "14" },
              { name: "Browser", on: false, count: "4" },
            ].map((c) => (
              <div
                key={c.name}
                className={`border rounded-lg p-2.5 ${
                  c.on
                    ? "bg-amber-500/5 border-amber-500/30"
                    : "bg-slate-900/40 border-slate-800"
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span
                    className={`text-xs font-semibold ${c.on ? "text-white" : "text-slate-500"}`}
                  >
                    {c.name}
                  </span>
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      c.on ? "bg-amber-400" : "bg-slate-600"
                    }`}
                  />
                </div>
                <span className="text-[10px] font-mono text-slate-500">{c.count} tools</span>
              </div>
            ))}
          </div>
        </main>
      </div>
    </div>
  );
}
