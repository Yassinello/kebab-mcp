const STEPS: {
  n: number;
  title: string;
  body: string;
  icon: React.ReactNode;
}[] = [
  {
    n: 1,
    title: "Deploy",
    body: "One click on the Deploy button forks the repo, provisions Upstash Redis for durable storage, and boots the instance on your Vercel account. No CLI, no env-var wrangling.",
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
    body: "Paste the HTTP endpoint and your token into Claude Desktop, Claude Code, Cursor, Windsurf, or any MCP-compatible client. One URL, every tool on it.",
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
    title: "Serve",
    body: "All 86+ built-in tools are live immediately. Your AI clients share one backend — same tools, same data, zero duplication.",
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
  {
    n: 4,
    title: "Extend",
    body: "Add new tools via API Connections (any HTTP API, no code) or Skills (prompt-driven workflows). Your backend grows with your stack.",
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
        <path d="M12 4v16m8-8H4" />
      </svg>
    ),
  },
];

export default function HowItWorks() {
  return (
    <section className="py-20 px-6 border-t border-slate-800">
      <div className="max-w-5xl mx-auto">
        <div className="text-center mb-14">
          <p className="text-xs font-mono text-blue-400 mb-3 tracking-widest uppercase">
            How it works
          </p>
          <h2 className="text-3xl sm:text-4xl font-bold text-white tracking-tight">
            From zero to fully loaded in minutes.
          </h2>
          <p className="text-slate-400 text-base mt-3 max-w-xl mx-auto leading-relaxed">
            No infra, no YAML, no serverless debugging. The happy path fits in one short session.
          </p>
        </div>

        <ol className="grid grid-cols-1 md:grid-cols-4 gap-5">
          {STEPS.map((step) => (
            <li
              key={step.n}
              className="relative bg-slate-900/60 border border-slate-800 rounded-xl p-6"
            >
              <div className="flex items-center gap-3 mb-4">
                <span
                  aria-hidden
                  className="flex items-center justify-center w-7 h-7 rounded-full bg-blue-500/20 border border-blue-500/40 text-blue-300 text-xs font-bold"
                >
                  {step.n}
                </span>
                <span className="text-blue-300">{step.icon}</span>
              </div>
              <h3 className="text-white font-semibold text-lg mb-2">{step.title}</h3>
              <p className="text-slate-400 text-sm leading-relaxed">{step.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
