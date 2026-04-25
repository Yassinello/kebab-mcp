import { REPO_URL, VERCEL_DEPLOY_URL } from "./deploy-url";

export default function CtaSection() {
  return (
    <section className="py-24 px-6 border-t border-slate-800">
      <div className="max-w-3xl mx-auto text-center">
        <h2 className="text-4xl font-bold text-white mb-4 tracking-tight">
          Build your AI backend. Add extra sauce later.
        </h2>
        <p className="text-slate-400 text-lg mb-10 leading-relaxed">
          One deploy. Every AI client gets the same superpowers.
        </p>
        <div className="flex flex-col sm:flex-row gap-4 justify-center items-center">
          <a
            href={VERCEL_DEPLOY_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 bg-amber-500 hover:bg-amber-400 text-slate-900 transition-colors px-8 py-3.5 rounded-lg font-semibold text-sm"
          >
            Deploy your Kebab
          </a>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 border border-slate-700 text-slate-300 hover:border-slate-500 hover:text-white transition-colors px-8 py-3.5 rounded-lg font-semibold text-sm"
          >
            View on GitHub
          </a>
        </div>
      </div>
    </section>
  );
}
