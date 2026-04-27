import type { Metadata } from "next";
import LandingHeader from "../landing/header";
import LandingFooter from "../landing/footer";
import { REPO_URL, GITHUB_FORK_URL, VERCEL_IMPORT_URL } from "../landing/deploy-url";

export const metadata: Metadata = {
  title: "Deploy Kebab MCP — Choose your path",
  description:
    "Pick how you want to run Kebab MCP. Fork + Vercel is the recommended path. CLI, Docker, and self-hosted options are available if you want more control.",
  openGraph: {
    title: "Deploy Kebab MCP",
    description:
      "Fork on GitHub, import to Vercel, mint your token. ~5 minutes. Or roll your own with Docker or the CLI installer.",
  },
};

export default function DeployPage() {
  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <LandingHeader />
      <main className="px-6 py-16">
        <div className="max-w-5xl mx-auto">
          <PageIntro />
          <RecommendedCard />
          <SecondaryGrid />
          <AfterDeployment />
        </div>
      </main>
      <LandingFooter />
    </div>
  );
}

function PageIntro() {
  return (
    <header className="text-center mb-14">
      <p className="text-xs font-mono text-amber-400 mb-3 tracking-widest uppercase">
        Deploy Kebab MCP
      </p>
      <h1 className="text-4xl sm:text-5xl font-bold text-white leading-tight tracking-tight mb-4">
        Choose how to run your AI backend.
      </h1>
      <p className="text-lg text-slate-400 max-w-2xl mx-auto leading-relaxed">
        Fork + Vercel is the recommended path — your deployment stays linked to upstream and updates
        land in one click. CLI and self-hosted options are available if you want more control.
      </p>
    </header>
  );
}

// ── Recommended: Fork + Vercel Import ──────────────────────────────────

function RecommendedCard() {
  return (
    <section
      aria-labelledby="recommended-heading"
      className="relative rounded-2xl border border-amber-500/40 bg-slate-900/60 p-8 sm:p-10 mb-10 overflow-hidden"
    >
      <div className="pointer-events-none absolute -top-20 -right-20 h-64 w-64 rounded-full bg-amber-500/10 blur-3xl" />

      <div className="relative grid grid-cols-1 lg:grid-cols-[1.4fr_1fr] gap-8 items-start">
        <div>
          <div className="flex items-center gap-3 mb-4 flex-wrap">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-xs font-semibold text-amber-300">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
              Recommended
            </span>
            <span className="text-xs font-mono text-slate-500">~ 5 min</span>
            <span className="text-xs font-mono text-slate-500">·</span>
            <span className="text-xs text-slate-500">Stays updateable</span>
          </div>
          <h2
            id="recommended-heading"
            className="text-2xl sm:text-3xl font-bold text-white tracking-tight mb-3"
          >
            Fork on GitHub, deploy on Vercel
          </h2>
          <p className="text-slate-400 leading-relaxed mb-4">
            You fork{" "}
            <code className="font-mono text-xs bg-slate-800/80 text-slate-300 rounded px-1.5 py-0.5">
              Yassinello/kebab-mcp
            </code>{" "}
            into your own GitHub account, then import the fork into Vercel. That extra click buys
            you a real GitHub fork (with{" "}
            <code className="font-mono text-xs bg-slate-800/80 text-slate-300 rounded px-1.5 py-0.5">
              parent
            </code>{" "}
            set), so the dashboard&apos;s one-click <em>Update now</em> flow and GitHub&apos;s{" "}
            <em>Sync fork</em> button both work.
          </p>
          <div className="rounded-md border border-amber-500/20 bg-amber-500/5 px-4 py-3 mb-6">
            <p className="text-xs text-amber-200/90 leading-relaxed">
              <strong className="text-amber-200">Why not the one-click Deploy Button?</strong>{" "}
              Vercel&apos;s <code className="font-mono">/new/clone</code> creates a standalone
              snapshot in your account — not a real fork. Such deployments cannot receive upstream
              updates. We tried and backed out.
            </p>
          </div>

          <div className="flex flex-col sm:flex-row gap-3">
            <a
              href={GITHUB_FORK_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-2 bg-amber-500 hover:bg-amber-400 text-slate-900 transition-colors px-6 py-3 rounded-lg font-semibold text-sm shadow-lg shadow-amber-500/20"
            >
              <GitHubMark />
              1. Fork on GitHub
            </a>
            <a
              href={VERCEL_IMPORT_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-2 border border-slate-700 hover:border-slate-500 text-slate-200 hover:text-white transition-colors px-6 py-3 rounded-lg font-semibold text-sm"
            >
              <VercelMark />
              2. Import to Vercel
            </a>
          </div>
        </div>

        <aside className="rounded-xl border border-slate-800 bg-slate-950/60 p-5">
          <p className="text-xs font-mono uppercase tracking-widest text-slate-500 mb-4">
            Step by step
          </p>
          <ol className="space-y-3 text-sm text-slate-400">
            <li className="flex gap-3">
              <StepBadge n={1} />
              <span>
                Click <strong>Fork on GitHub</strong>. Keep the source as{" "}
                <code className="font-mono text-xs bg-slate-800/80 text-slate-300 rounded px-1 py-0.5">
                  Yassinello/kebab-mcp
                </code>{" "}
                and confirm.
              </span>
            </li>
            <li className="flex gap-3">
              <StepBadge n={2} />
              <span>
                Open <strong>Import to Vercel</strong>. Find your fork in the list and click{" "}
                <strong>Import</strong>.
              </span>
            </li>
            <li className="flex gap-3">
              <StepBadge n={3} />
              <span>
                Add the <strong>Upstash Redis</strong> integration during setup — your auth token
                needs durable storage.
              </span>
            </li>
            <li className="flex gap-3">
              <StepBadge n={4} />
              <span>
                Open the deploy URL → mint your{" "}
                <code className="font-mono text-xs bg-slate-800/80 text-slate-300 rounded px-1 py-0.5">
                  MCP_AUTH_TOKEN
                </code>{" "}
                in the welcome flow.
              </span>
            </li>
            <li className="flex gap-3">
              <StepBadge n={5} />
              <span>
                Paste the token into Claude, Cursor, Windsurf, or any MCP-compatible client.
              </span>
            </li>
          </ol>
        </aside>
      </div>
    </section>
  );
}

function StepBadge({ n }: { n: number }) {
  return (
    <span
      aria-hidden
      className="shrink-0 grid place-items-center h-6 w-6 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-300 text-xs font-mono"
    >
      {n}
    </span>
  );
}

function GitHubMark() {
  return (
    <svg
      aria-hidden
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="currentColor"
      className="opacity-90"
    >
      <path d="M12 0C5.373 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.6.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.5 11.5 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
    </svg>
  );
}

function VercelMark() {
  return (
    <svg
      aria-hidden
      width="14"
      height="14"
      viewBox="0 0 76 65"
      fill="currentColor"
      className="opacity-90"
    >
      <path d="M37.5274 0L75.0548 65H0L37.5274 0Z" />
    </svg>
  );
}

// ── Secondary grid: CLI / Docker / Advanced ────────────────────────────

function SecondaryGrid() {
  return (
    <section aria-labelledby="other-options" className="mb-14">
      <h2
        id="other-options"
        className="text-xs font-mono uppercase tracking-widest text-slate-500 mb-5"
      >
        Other options
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <SecondaryCard
          title="Guided CLI"
          time="~ 10 min"
          description={
            <>
              Run the installer if you want help choosing connectors, generating your{" "}
              <code className="font-mono">.env</code>, and optionally deploying to Vercel from the
              terminal.
            </>
          }
          command="npx @yassinello/create-kebab-mcp@latest"
          href={`${REPO_URL}#option-c--npx-installer-interactive-cli`}
          ctaLabel="See CLI installer"
        />
        <SecondaryCard
          title="Docker / local"
          time="~ 10–20 min"
          description={
            <>
              Run on your own machine with Docker Compose. Best when you want full control over
              persistence and runtime.
            </>
          }
          command={[
            "git clone https://github.com/Yassinello/kebab-mcp.git",
            "cd kebab-mcp",
            "cp .env.example .env",
            "docker compose up",
          ].join("\n")}
          href={`${REPO_URL}#option-b--self-hosted-docker-or-local-dev`}
          ctaLabel="Self-host guide"
        />
        <SecondaryCard
          title="Advanced hosting"
          time="Fly · Render · Cloud Run"
          description={
            <>
              Multi-replica or non-Vercel runtimes need explicit persistence decisions. Read the
              host compatibility matrix before deploying.
            </>
          }
          command={null}
          href={`${REPO_URL}/blob/main/docs/HOSTING.md`}
          ctaLabel="Read hosting guide"
        />
      </div>
    </section>
  );
}

function SecondaryCard({
  title,
  time,
  description,
  command,
  href,
  ctaLabel,
}: {
  title: string;
  time: string;
  description: React.ReactNode;
  command: string | null;
  href: string;
  ctaLabel: string;
}) {
  return (
    <article className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-white">{title}</h3>
        <span className="text-[11px] font-mono text-slate-500">{time}</span>
      </div>
      <p className="text-sm text-slate-400 leading-relaxed mb-4 flex-1">{description}</p>
      {command && (
        <pre className="rounded-md bg-slate-950 border border-slate-800 px-3 py-2 mb-4 text-[11px] font-mono text-slate-300 leading-snug whitespace-pre overflow-x-auto">
          {command}
        </pre>
      )}
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-xs font-semibold text-slate-300 hover:text-white transition-colors mt-auto"
      >
        {ctaLabel} <span aria-hidden>→</span>
      </a>
    </article>
  );
}

// ── After deployment — common next steps ───────────────────────────────

function AfterDeployment() {
  return (
    <section
      aria-labelledby="after-deployment"
      className="rounded-xl border border-slate-800 bg-slate-900/40 p-6 sm:p-8"
    >
      <h2 id="after-deployment" className="text-base font-semibold text-white mb-4">
        After deployment
      </h2>
      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-y-3 gap-x-8 text-sm text-slate-400">
        <li>
          <strong className="text-slate-200">Open the welcome flow</strong> — mint your{" "}
          <code className="font-mono text-xs">MCP_AUTH_TOKEN</code> and copy it.
        </li>
        <li>
          <strong className="text-slate-200">Connect a client</strong> — paste the token into
          Claude, Cursor, Windsurf, or ChatGPT.
        </li>
        <li>
          <strong className="text-slate-200">Add connectors</strong> — drop Google, Slack, Notion,
          etc. credentials in Settings to activate tools.
        </li>
        <li>
          <strong className="text-slate-200">Stay up to date</strong> — open the dashboard&apos;s{" "}
          <em>Update now</em> banner, or click <em>Sync fork</em> on GitHub. New releases land in
          one click.
        </li>
      </ul>
    </section>
  );
}
