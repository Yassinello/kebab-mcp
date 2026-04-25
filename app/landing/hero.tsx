import { VERCEL_DEPLOY_URL } from "./deploy-url";

export default function Hero() {
  return (
    <section id="deploy" className="pt-24 pb-20 px-6">
      <div className="max-w-4xl mx-auto text-center">
        <p className="text-sm font-mono text-amber-400 mb-4 tracking-wider uppercase">
          🌯 One self-hosted backend for every AI client
        </p>
        <h1 className="text-5xl sm:text-6xl font-bold text-white leading-tight tracking-tight mb-6">
          Give every AI client the same superpowers.
        </h1>
        <p className="text-xl text-slate-400 max-w-2xl mx-auto mb-8 leading-relaxed">
          One Vercel deploy. Claude, Cursor, Windsurf — and any MCP-compatible client — all get the
          same 86+ tools: Gmail, Calendar, Notion, GitHub, Slack, and more.
        </p>
        <p className="text-sm text-slate-500 max-w-xl mx-auto mb-10">
          Your keys, your data, your infra. Open source, MIT licensed, no SaaS middleman.
        </p>
        <div className="flex flex-col sm:flex-row gap-4 justify-center items-center">
          <a
            href={VERCEL_DEPLOY_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 bg-amber-500 hover:bg-amber-400 text-slate-900 transition-colors px-6 py-3 rounded-lg font-semibold text-sm"
          >
            Deploy your Kebab
          </a>
          <a
            href="#whats-inside"
            className="inline-flex items-center gap-2 border border-slate-700 text-slate-300 hover:border-slate-500 hover:text-white transition-colors px-6 py-3 rounded-lg font-semibold text-sm"
          >
            See what&apos;s inside
          </a>
        </div>
      </div>
    </section>
  );
}
