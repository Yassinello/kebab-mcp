import SkewerIllustration from "./skewer-illustration";
import SocialProof from "./social-proof";
import { VERCEL_DEPLOY_BUTTON_URL } from "./deploy-url";

/** Clients that get the full experience (see README "Which AI clients?"). */
const CLIENTS = ["Claude", "Claude Code", "Cursor", "Codex", "ChatGPT"];

export default function Hero() {
  return (
    <section id="deploy" className="pt-10 sm:pt-12 pb-10 px-6 overflow-hidden">
      <div className="max-w-6xl mx-auto">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 lg:gap-16 items-center">
          {/* Copy column — comes first on mobile so the deploy button stays above the fold. */}
          <div className="text-center lg:text-left">
            <p className="text-xs font-mono text-amber-400 mb-4 tracking-widest uppercase">
              Your skills, profile and memory in every AI client
            </p>
            {/* The tagline is the headline (spec phase 0, BRD-02). */}
            <h1 className="text-4xl sm:text-5xl font-bold text-white leading-[1.08] tracking-tight mb-5">
              Create your personal AI brain with all the ingredients,{" "}
              <span className="text-amber-400">and eat it everywhere.</span>
            </h1>
            <p className="text-lg text-slate-400 leading-relaxed mb-5 max-w-xl mx-auto lg:mx-0">
              For people who use more than one AI client — say Claude, Cursor and ChatGPT. One
              library of skills, one profile of who you are, one memory: set them up once, and every
              client uses the same copy.
            </p>
            <ul
              aria-label="Works with"
              className="flex flex-wrap justify-center lg:justify-start gap-2 mb-6"
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
            <div className="flex flex-col sm:flex-row gap-3 justify-center lg:justify-start items-center mb-3">
              <a
                href={VERCEL_DEPLOY_BUTTON_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 bg-amber-500 hover:bg-amber-400 text-slate-900 transition-colors px-6 py-3 rounded-lg font-semibold text-sm shadow-lg shadow-amber-500/20"
              >
                Deploy Kebab House
              </a>
              <a
                href="#how-it-works"
                className="inline-flex items-center gap-2 border border-slate-700 text-slate-300 hover:border-slate-500 hover:text-white transition-colors px-6 py-3 rounded-lg font-semibold text-sm"
              >
                See how it works
              </a>
            </div>
            <p className="text-xs text-slate-500 mb-6">
              Free and open source. One click on Vercel creates your GitHub copy, your project and a
              free database.{" "}
              <a href="/deploy" className="text-slate-300 hover:text-white underline">
                Other ways to deploy
              </a>
            </p>
            <div className="flex justify-center lg:justify-start">
              <SocialProof />
            </div>
          </div>

          {/* Illustration column */}
          <div className="max-w-[280px] sm:max-w-md lg:max-w-none mx-auto w-full">
            <SkewerIllustration />
          </div>
        </div>
      </div>
    </section>
  );
}
