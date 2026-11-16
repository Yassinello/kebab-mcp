const STEPS: {
  n: number;
  title: string;
  body: string;
  icon: React.ReactNode;
}[] = [
  {
    n: 1,
    title: "Deploy",
    body: "One click on Vercel creates your GitHub copy, your project and a free database. The welcome page then gives you the admin key to your dashboard.",
    icon: (
      <svg
        className="w-5 h-5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 3v12m0 0-4-4m4 4 4-4" />
        <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
      </svg>
    ),
  },
  {
    n: 2,
    title: "Connect",
    body: "Add your instance URL to Claude, ChatGPT, Cursor or Claude Code and sign in. Other clients get a device token from the dashboard.",
    icon: (
      <svg
        className="w-5 h-5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
      </svg>
    ),
  },
  {
    n: 3,
    title: "Set up",
    body: "Say “Set up my Kebab House” in any client: a short interview writes your profile and installs the rituals you pick.",
    icon: (
      <svg
        className="w-5 h-5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M5 12h14" />
        <path d="M12 5v14" />
        <circle cx="12" cy="12" r="9" />
      </svg>
    ),
  },
];

export default function HowItWorks() {
  return (
    <section
      id="how-it-works"
      className="py-10 sm:py-12 px-6 border-t border-slate-800 scroll-mt-16"
    >
      <div className="max-w-5xl mx-auto">
        <div className="text-center mb-6 sm:mb-8">
          <p className="text-xs font-mono text-blue-400 mb-3 tracking-widest uppercase">
            How it works
          </p>
          <h2 className="text-2xl sm:text-4xl font-bold text-white tracking-tight">
            Three steps, about ten minutes.
          </h2>
        </div>

        <ol className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {STEPS.map((step) => (
            <li
              key={step.n}
              className="relative bg-slate-900/60 border border-slate-800 rounded-xl p-4 sm:p-5"
            >
              <div className="flex items-center gap-3 mb-2">
                <span
                  aria-hidden
                  className="flex items-center justify-center w-7 h-7 rounded-full bg-blue-500/20 border border-blue-500/40 text-blue-300 text-xs font-bold"
                >
                  {step.n}
                </span>
                <span className="text-blue-300">{step.icon}</span>
                <h3 className="text-white font-semibold text-lg">{step.title}</h3>
              </div>
              <p className="text-slate-400 text-sm leading-relaxed">{step.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
