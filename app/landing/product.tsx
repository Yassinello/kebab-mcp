import { PRODUCT } from "@/core/constants/brand";

/**
 * Product section — gives the visitor a tangible look at the dashboard
 * before they're asked to deploy. SVG/HTML mockup so we don't ship binary
 * screenshots (keeps bundle in budget and survives rebrands).
 *
 * Kebab House: the mockup shows the Skills tab — the library is the
 * product, connectors are the long tail.
 */
const MOCK_SKILLS: { name: string; description: string; tags: string[] }[] = [
  {
    name: "meeting-prep",
    description: "Brief me before a meeting: attendees, history, open points.",
    tags: ["work"],
  },
  {
    name: "morning-brief",
    description: "Today's agenda, priorities and what's waiting on me.",
    tags: ["rituals"],
  },
  {
    name: "linkedin-reply",
    description: "Draft a reply in my voice. Never send without asking.",
    tags: ["work", "social"],
  },
  {
    name: "read-later",
    description: "Clip an article into my vault with a three-line summary.",
    tags: ["perso"],
  },
];

export default function Product() {
  return (
    <section id="product" className="py-20 px-6 border-t border-slate-800">
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-12">
          <p className="text-xs font-mono text-blue-400 mb-3 tracking-widest uppercase">
            The dashboard
          </p>
          <h2 className="text-3xl sm:text-4xl font-bold text-white tracking-tight">
            Your recipes, in one kitchen.
          </h2>
          <p className="text-slate-400 text-base mt-3 max-w-2xl mx-auto leading-relaxed">
            Write, import and version your skills, decide which client sees which, and keep an eye
            on every call — all behind one auth-gated dashboard.
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
              label: "Skills library",
              body: "Agent Skills (SKILL.md) with bundled files. Import from Claude or ChatGPT, version, roll back in one click.",
            },
            {
              label: "One token per client",
              body: "Scope each client to its hat: which skills and connectors it sees. Rotate or revoke anytime.",
            },
            {
              label: "Structured logs",
              body: "Every tool call traced with duration, status and client. Filter, search, export.",
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
        <div className="ml-3 flex-1 min-w-0 max-w-md">
          <div className="bg-slate-800/60 rounded px-3 py-1 text-xs font-mono text-slate-400 truncate">
            your-instance.vercel.app/config?tab=skills
          </div>
        </div>
      </div>

      {/* Dashboard body */}
      <div className="grid grid-cols-12 min-h-[340px] sm:min-h-[420px]">
        {/* Sidebar */}
        <aside className="col-span-3 bg-slate-950/60 border-r border-slate-800 p-4 hidden sm:block">
          <div className="flex items-center gap-2 mb-6">
            <div className="w-5 h-5 rounded bg-amber-500/20 border border-amber-500/40" />
            <span className="text-xs font-mono text-white font-semibold">{PRODUCT.name}</span>
          </div>
          <nav className="space-y-1">
            {[
              { label: "Overview" },
              { label: "Skills", active: true },
              { label: "Connectors" },
              { label: "Tools" },
              { label: "Devices" },
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
          <div className="flex items-start justify-between gap-3 mb-5">
            <div className="min-w-0">
              <h3 className="text-white font-semibold text-base">Skills</h3>
              <p className="text-xs text-slate-500 mt-0.5">One library, every AI client.</p>
            </div>
            <span className="shrink-0 text-[10px] font-mono uppercase tracking-widest text-amber-300 border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 rounded">
              + Import
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {MOCK_SKILLS.map((s) => (
              <div
                key={s.name}
                className="border rounded-lg p-3 bg-amber-500/5 border-amber-500/30"
              >
                <p className="text-xs font-mono font-semibold text-white mb-1">{s.name}</p>
                <p className="text-[11px] text-slate-400 leading-snug mb-2">{s.description}</p>
                <div className="flex flex-wrap gap-1">
                  {s.tags.map((t) => (
                    <span
                      key={t}
                      className="text-[10px] font-mono text-slate-400 border border-slate-700 rounded px-1.5"
                    >
                      #{t}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4 border border-slate-800 rounded-lg px-3 py-2.5 bg-slate-950/40">
            <p className="text-[10px] font-mono uppercase tracking-widest text-slate-500 mb-1.5">
              Served to
            </p>
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-300">
              <span>Claude · #perso #rituals</span>
              <span>Cursor · #work</span>
              <span>Codex · #work</span>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
