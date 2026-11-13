import SkewerIllustration from "./skewer-illustration";
import SocialProof from "./social-proof";

/** Clients that get the full experience (see README "Which AI clients?"). */
const CLIENTS = ["Claude", "Claude Code", "Cursor", "Codex", "ChatGPT"];

export default function Hero() {
  return (
    <section id="deploy" className="pt-20 pb-16 px-6 overflow-hidden">
      <div className="max-w-6xl mx-auto">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 lg:gap-16 items-center">
          {/* Copy column */}
          <div className="text-center lg:text-left">
            <p className="text-xs font-mono text-amber-400 mb-4 tracking-widest uppercase">
              Kebab House · your personal AI hub
            </p>
            {/* The tagline is the headline (spec phase 0, BRD-02). */}
            <h1 className="text-4xl sm:text-5xl font-bold text-white leading-[1.08] tracking-tight mb-6">
              Create your personal AI brain with all the ingredients,{" "}
              <span className="text-amber-400">and eat it everywhere.</span>
            </h1>
            <p className="text-lg text-slate-400 leading-relaxed mb-5 max-w-xl mx-auto lg:mx-0">
              One library of skills, one profile of who you are, one memory vault — shared by every
              AI client you already use. Write a skill once; Claude, Cursor and Codex can all load
              it.
            </p>
            <ul
              aria-label="Works with"
              className="flex flex-wrap justify-center lg:justify-start gap-2 mb-5"
            >
              {CLIENTS.map((client) => (
                <li
                  key={client}
                  className="text-xs font-medium text-slate-300 border border-slate-700 bg-slate-900/60 rounded-full px-3 py-1"
                >
                  {client}
                  {client === "ChatGPT" && <span className="text-slate-500"> · partial</span>}
                </li>
              ))}
            </ul>
            <p className="text-sm text-slate-500 mb-8 max-w-lg mx-auto lg:mx-0">
              A hub, not an agent: your AI clients do the thinking. Self-hosted on your Vercel, with
              your keys. Open source, AGPL-3.0.
            </p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center lg:justify-start items-center mb-8">
              <a
                href="/deploy"
                className="inline-flex items-center gap-2 bg-amber-500 hover:bg-amber-400 text-slate-900 transition-colors px-6 py-3 rounded-lg font-semibold text-sm shadow-lg shadow-amber-500/20"
              >
                Deploy your Kebab
              </a>
              <a
                href="#product"
                className="inline-flex items-center gap-2 border border-slate-700 text-slate-300 hover:border-slate-500 hover:text-white transition-colors px-6 py-3 rounded-lg font-semibold text-sm"
              >
                See the dashboard
              </a>
            </div>
            <div className="flex justify-center lg:justify-start">
              <SocialProof />
            </div>
          </div>

          {/* Illustration column */}
          <div className="order-first lg:order-last">
            <SkewerIllustration />
          </div>
        </div>
      </div>
    </section>
  );
}
