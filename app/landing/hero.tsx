import { VERCEL_DEPLOY_URL } from "./deploy-url";
import SkewerIllustration from "./skewer-illustration";
import SocialProof from "./social-proof";

export default function Hero() {
  return (
    <section id="deploy" className="pt-20 pb-16 px-6 overflow-hidden">
      <div className="max-w-6xl mx-auto">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 lg:gap-16 items-center">
          {/* Copy column */}
          <div className="text-center lg:text-left">
            <p className="text-xs font-mono text-amber-400 mb-4 tracking-widest uppercase">
              One self-hosted backend for every AI client
            </p>
            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold text-white leading-[1.05] tracking-tight mb-6">
              Give every AI client the same superpowers.
            </h1>
            <p className="text-lg text-slate-400 leading-relaxed mb-6 max-w-xl mx-auto lg:mx-0">
              One Vercel deploy. Claude, Cursor, Windsurf — and any MCP-compatible client — all get
              the same 86+ tools: Gmail, Calendar, Notion, GitHub, Slack, and more.
            </p>
            <p className="text-sm text-slate-500 mb-8 max-w-lg mx-auto lg:mx-0">
              Your keys, your data, your infra. Open source, MIT licensed, no SaaS middleman.
            </p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center lg:justify-start items-center mb-8">
              <a
                href={VERCEL_DEPLOY_URL}
                target="_blank"
                rel="noopener noreferrer"
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
