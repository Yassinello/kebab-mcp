/**
 * Who it's for / what you need — stated right under the hero so a visitor
 * knows in ten seconds whether this is for them and what it takes.
 */
const NEEDS = [
  "A GitHub account",
  "A free Vercel account",
  "About 10 minutes",
  "No code, no command line",
];

export default function Audience() {
  return (
    <section id="who" className="py-8 sm:py-10 px-6 border-t border-slate-800">
      <div className="max-w-5xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-5">
        <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-6">
          <h2 className="text-white font-semibold text-lg mb-2">Who it&apos;s for</h2>
          <p className="text-slate-400 text-sm leading-relaxed mb-3">
            People who juggle several AI clients and are tired of explaining themselves to each one.
          </p>
          <p className="text-slate-500 text-sm leading-relaxed">
            <span className="text-slate-300 font-medium">Not for you</span> if you only use one AI
            app: its built-in memory may be enough.
          </p>
        </div>
        <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-6">
          <h2 className="text-white font-semibold text-lg mb-2">What you need</h2>
          <ul className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm text-slate-300 mb-3">
            {NEEDS.map((need) => (
              <li key={need} className="flex gap-2">
                <span aria-hidden className="text-amber-400">
                  ✓
                </span>
                {need}
              </li>
            ))}
          </ul>
          <p className="text-slate-500 text-sm leading-relaxed">
            Free and open source (AGPL-3.0). It runs on your own Vercel and Upstash free plans.
          </p>
        </div>
      </div>
    </section>
  );
}
