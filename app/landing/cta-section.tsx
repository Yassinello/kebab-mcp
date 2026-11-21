import { REPO_URL, VERCEL_DEPLOY_BUTTON_URL } from "./deploy-url";

export default function CtaSection() {
  return (
    <section className="py-10 sm:py-14 px-6 border-t border-slate-800">
      <div className="max-w-3xl mx-auto text-center">
        <h2 className="text-3xl sm:text-4xl font-bold text-white mb-4 tracking-tight">
          Stock the kitchen once. Eat everywhere.
        </h2>
        <p className="text-slate-400 text-base sm:text-lg mb-6 sm:mb-8 leading-relaxed">
          One deploy. Every AI client you use gets the same skills, the same profile and the same
          memory.
        </p>
        <div className="flex flex-wrap gap-3 sm:gap-4 justify-center items-center">
          <a
            href={VERCEL_DEPLOY_BUTTON_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 bg-amber-500 hover:bg-amber-400 text-slate-900 transition-colors px-6 sm:px-8 py-3.5 rounded-lg font-semibold text-sm"
          >
            Deploy Kebab House
          </a>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 border border-slate-700 text-slate-300 hover:border-slate-500 hover:text-white transition-colors px-6 sm:px-8 py-3.5 rounded-lg font-semibold text-sm"
          >
            View on GitHub
          </a>
        </div>
        <p className="text-sm text-slate-400 mt-6">
          Then connect Claude and say &ldquo;Set up my Kebab House&rdquo;: Claude does the rest.{" "}
          <a
            href={`${REPO_URL}/blob/main/docs/CONNECT-CLAUDE.md`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-slate-200 hover:text-white underline"
          >
            Set it up from Claude
          </a>
        </p>
        <p className="text-xs text-slate-500 mt-3">
          Prefer Docker or the CLI, or want to contribute?{" "}
          <a href="/deploy" className="text-slate-300 hover:text-white underline">
            Other ways to deploy
          </a>
        </p>
      </div>
    </section>
  );
}
