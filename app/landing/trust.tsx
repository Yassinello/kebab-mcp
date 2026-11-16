import { REPO_URL } from "./deploy-url";

/** LND-01 — "at home": your data, your infra, your code. Rendered inside the guardrails section. */
const BADGES = [
  {
    label: "Open source",
    description: "AGPL-3.0, full source on GitHub. Audit it, fork it, make it yours.",
    href: REPO_URL,
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
    description:
      "Runs on your own Vercel account (or Docker). Your keys stay in your accounts, and updates are one click from the dashboard.",
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
    label: "Your data, portable",
    description:
      "Export one zip with your profiles, skills, notes and settings (secrets excluded), and import it into another instance from the dashboard.",
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
    <div id="at-home" className="mt-10 sm:mt-12">
      <div>
        <div className="text-center mb-6">
          <p className="text-xs font-mono text-amber-400 mb-2 tracking-widest uppercase">At home</p>
          <h3 className="text-xl sm:text-2xl font-bold text-white tracking-tight">
            Your data stays yours.
          </h3>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
          {BADGES.map((badge) => (
            <div
              key={badge.label}
              className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 sm:p-5 hover:border-slate-700 transition-colors"
            >
              <div className="flex items-center gap-2.5 mb-2">
                <span className="text-amber-400">{badge.icon}</span>
                {badge.href ? (
                  <a
                    href={badge.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-white font-semibold text-base hover:text-amber-300 transition-colors"
                  >
                    {badge.label}
                  </a>
                ) : (
                  <p className="text-white font-semibold text-base">{badge.label}</p>
                )}
              </div>
              <p className="text-slate-400 text-sm leading-relaxed">{badge.description}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
