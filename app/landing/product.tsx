import { PRODUCT } from "@/core/constants/brand";

/**
 * Product section — a tangible look at the dashboard before the visitor is
 * asked to deploy. HTML mockup so we don't ship binary screenshots (keeps
 * the bundle in budget and survives rebrands).
 *
 * Keep it true to the product: the menu mirrors the dashboard's main menu
 * and the skills are the ritual templates that ship with Kebab House.
 */
const MENU = ["Overview", "Profile", "Skills", "Memory", "Connectors", "Devices", "Logs"];

/** `wide` skills are only shown from the `sm` breakpoint up, to keep the phone mockup short. */
const MOCK_SKILLS: { name: string; description: string; tags: string[]; wide?: boolean }[] = [
  {
    name: "remember",
    description: "Keep a fact about me or a note, from any client.",
    tags: ["rituals"],
  },
  {
    name: "morning-brief",
    description: "Today's agenda, priorities and what's waiting on me.",
    tags: ["rituals"],
  },
  {
    name: "meeting-prep",
    description: "Brief me before a meeting: people, history, open points.",
    tags: ["work"],
  },
  {
    name: "weekly-review",
    description: "What happened this week, and next week's priorities.",
    tags: ["rituals"],
    wide: true,
  },
  {
    name: "read-later",
    description: "Save an article to my notes with why it matters.",
    tags: ["perso"],
    wide: true,
  },
  {
    name: "handoff",
    description: "Hand this conversation to another client, pick it up there.",
    tags: ["work"],
  },
];

export default function Product() {
  return (
    <section id="product" className="py-10 sm:py-12 px-6 border-t border-slate-800">
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-6 sm:mb-8">
          <p className="text-xs font-mono text-blue-400 mb-3 tracking-widest uppercase">
            The dashboard
          </p>
          <h2 className="text-2xl sm:text-4xl font-bold text-white tracking-tight">
            See and edit what your AI clients know.
          </h2>
          <p className="text-slate-400 text-base mt-3 max-w-2xl mx-auto leading-relaxed">
            Your profile, your skills and your notes in one private dashboard. Connect a client,
            choose what it can do, and check what it did this week.
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
      <div className="grid grid-cols-12">
        {/* Sidebar */}
        <aside className="col-span-3 bg-slate-950/60 border-r border-slate-800 p-4 hidden sm:block">
          <div className="flex items-center gap-2 mb-6">
            <div className="w-5 h-5 rounded bg-amber-500/20 border border-amber-500/40" />
            <span className="text-xs font-mono text-white font-semibold">{PRODUCT.name}</span>
          </div>
          <nav className="space-y-1">
            {MENU.map((label) => (
              <div
                key={label}
                className={`text-xs px-2.5 py-1.5 rounded ${
                  label === "Skills"
                    ? "bg-amber-500/15 text-amber-300 border-l-2 border-amber-400"
                    : "text-slate-500"
                }`}
              >
                {label}
              </div>
            ))}
          </nav>
        </aside>

        {/* Main content */}
        <div className="col-span-12 sm:col-span-9 p-4 sm:p-6">
          <div className="flex items-start justify-between gap-3 mb-5">
            <div className="min-w-0">
              <p className="text-white font-semibold text-base">Skills</p>
              <p className="text-xs text-slate-500 mt-0.5">One library, every AI client.</p>
            </div>
            <span className="shrink-0 text-[10px] font-mono uppercase tracking-widest text-amber-300 border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 rounded">
              + Import
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
            {MOCK_SKILLS.map((s) => (
              <div
                key={s.name}
                className={`border rounded-lg p-3 bg-amber-500/5 border-amber-500/30 ${
                  s.wide ? "hidden sm:block" : ""
                }`}
              >
                <div className="flex items-center justify-between gap-2 mb-1">
                  <p className="text-xs font-mono font-semibold text-white">{s.name}</p>
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
                <p className="text-[11px] text-slate-400 leading-snug">{s.description}</p>
              </div>
            ))}
          </div>

          <div className="hidden sm:block mt-4 border border-slate-800 rounded-lg px-3 py-2.5 bg-slate-950/40">
            <p className="text-[10px] font-mono uppercase tracking-widest text-slate-500 mb-1.5">
              Served to
            </p>
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-300">
              <span>Claude · #perso #rituals</span>
              <span>Cursor · #work #rituals</span>
              <span>ChatGPT · #perso</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
