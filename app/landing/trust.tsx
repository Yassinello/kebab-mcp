const BADGES = [
  {
    label: "MIT licensed",
    description: "Full source on GitHub. Fork it, audit it, make it yours.",
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
        />
      </svg>
    ),
  },
  {
    label: "Self-hosted",
    description: "Runs on your own Vercel account. Your keys never leave your infra.",
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z"
        />
      </svg>
    ),
  },
  {
    label: "Durable bootstrap",
    description: "State survives cold starts via Upstash KV. No silent resets on wake-up.",
    href: "/docs/TROUBLESHOOTING.md",
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4"
        />
      </svg>
    ),
  },
];

export default function Trust() {
  return (
    <section className="py-20 px-6 border-t border-slate-800">
      <div className="max-w-4xl mx-auto">
        <div className="text-center mb-12">
          <h2 className="text-3xl sm:text-4xl font-bold text-white tracking-tight">
            No mystery meat.
          </h2>
          <p className="text-slate-400 text-base mt-3 max-w-xl mx-auto leading-relaxed">
            Open, verifiable, and built to last — even on serverless cold starts.
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
          {BADGES.map((badge) => (
            <div
              key={badge.label}
              className="bg-slate-900/60 border border-slate-800 rounded-xl p-6 text-center hover:border-slate-700 transition-colors"
            >
              <div className="flex justify-center text-amber-400 mb-4">{badge.icon}</div>
              {badge.href ? (
                <a
                  href={badge.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-white font-semibold text-lg mb-2 block hover:text-amber-300 transition-colors"
                >
                  {badge.label}
                </a>
              ) : (
                <p className="text-white font-semibold text-lg mb-2">{badge.label}</p>
              )}
              <p className="text-slate-400 text-sm leading-relaxed">{badge.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
