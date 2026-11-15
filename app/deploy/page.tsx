import type { Metadata } from "next";
import LandingHeader from "../landing/header";
import LandingFooter from "../landing/footer";
import {
  REPO_URL,
  GITHUB_FORK_URL,
  VERCEL_IMPORT_URL,
  VERCEL_DEPLOY_BUTTON_URL,
} from "../landing/deploy-url";

export const metadata: Metadata = {
  title: "Deploy Kebab House — Choose your path",
  description:
    "Deploy Kebab House on Vercel in one click: your own GitHub copy, a Vercel project and a free Upstash database. Fork + Import, Docker and CLI options are available too.",
  openGraph: {
    title: "Deploy Kebab House",
    description:
      "One click on Vercel creates your repo, your project and a free Upstash database. Or roll your own with a fork, Docker or the CLI installer.",
  },
};

export default function DeployPage() {
  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <LandingHeader />
      <main className="px-4 sm:px-6 py-12 sm:py-16">
        <div className="max-w-5xl mx-auto">
          <PageIntro />
          <RecommendedCard />
          <ForkAlternativeCard />
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
    <header className="text-center mb-12 sm:mb-14">
      <p className="text-xs font-mono text-amber-400 mb-3 tracking-widest uppercase">
        Deploy Kebab House
      </p>
      <h1 className="text-3xl sm:text-5xl font-bold text-white leading-tight tracking-tight mb-4">
        Choose how to run your AI backend.
      </h1>
      <p className="text-base sm:text-lg text-slate-400 max-w-2xl mx-auto leading-relaxed">
        The Vercel button is the recommended path — one click, free tier, updates from the
        dashboard. A GitHub fork, Docker and the CLI are there if you want more control.
      </p>
    </header>
  );
}

// ── Recommended: Vercel Deploy Button ──────────────────────────────────

function RecommendedCard() {
  return (
    <section
      aria-labelledby="recommended-heading"
      className="relative rounded-2xl border border-amber-500/40 bg-slate-900/60 p-6 sm:p-10 mb-8 overflow-hidden"
    >
      <div className="pointer-events-none absolute -top-20 -right-20 h-64 w-64 rounded-full bg-amber-500/10 blur-3xl" />

      <div className="relative grid grid-cols-1 lg:grid-cols-[1.3fr_1fr] gap-8 items-start">
        <div>
          <div className="flex items-center gap-3 mb-4 flex-wrap">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-xs font-semibold text-amber-300">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
              Recommended
            </span>
            <span className="text-xs font-mono text-slate-500">~ 3 min</span>
            <span className="text-xs font-mono text-slate-500">·</span>
            <span className="text-xs text-slate-500">Free tier</span>
            <span className="text-xs font-mono text-slate-500">·</span>
            <span className="text-xs text-slate-500">Updates in one click</span>
          </div>
          <h2
            id="recommended-heading"
            className="text-2xl sm:text-3xl font-bold text-white tracking-tight mb-3"
          >
            Deploy on Vercel in one click
          </h2>
          <p className="text-slate-400 leading-relaxed mb-6">
            Sign in to Vercel with GitHub, pick a name (or keep{" "}
            <code className="font-mono text-xs bg-slate-800/80 text-slate-300 rounded px-1.5 py-0.5">
              kebab-house
            </code>
            ), accept the free Upstash database, and click <strong>Deploy</strong>. When the build
            is done, open your instance: the welcome page mints your token and connects your first
            AI client.
          </p>

          <a
            href={VERCEL_DEPLOY_BUTTON_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex w-full sm:w-auto items-center justify-center gap-2 bg-amber-500 hover:bg-amber-400 text-slate-900 transition-colors px-6 py-3 rounded-lg font-semibold text-sm shadow-lg shadow-amber-500/20"
          >
            <VercelMark />
            Deploy with Vercel
          </a>
          <p className="text-xs text-slate-500 mt-3 leading-relaxed">
            Vercel doesn&apos;t bring you back here on its own yet: when the deploy finishes, click{" "}
            <strong className="text-slate-400">Continue to Dashboard</strong>, then{" "}
            <strong className="text-slate-400">Visit</strong> to open your instance.
          </p>
        </div>

        <aside className="rounded-xl border border-slate-800 bg-slate-950/60 p-5 space-y-5">
          <div>
            <p className="text-xs font-mono uppercase tracking-widest text-slate-500 mb-3">
              What gets created
            </p>
            <ul className="space-y-3 text-sm text-slate-400">
              <li className="flex gap-3">
                <StepBadge n={1} />
                <span>
                  <strong className="text-slate-200">A copy of the code</strong> in your GitHub
                  account (
                  <code className="font-mono text-xs bg-slate-800/80 text-slate-300 rounded px-1 py-0.5">
                    kebab-house
                  </code>
                  ). It&apos;s yours; Vercel redeploys on every push.
                </span>
              </li>
              <li className="flex gap-3">
                <StepBadge n={2} />
                <span>
                  <strong className="text-slate-200">A Vercel project</strong> on your account, free
                  Hobby plan.
                </span>
              </li>
              <li className="flex gap-3">
                <StepBadge n={3} />
                <span>
                  <strong className="text-slate-200">A free Upstash Redis database</strong>,
                  attached automatically — your token and settings survive restarts.
                </span>
              </li>
            </ul>
          </div>
          <div>
            <p className="text-xs font-mono uppercase tracking-widest text-slate-500 mb-3">
              What&apos;s left (optional)
            </p>
            <p className="text-sm text-slate-400 leading-relaxed">
              <strong className="text-slate-200">An update token</strong>, for one-click updates
              from the dashboard: a GitHub token with <em>Contents: read &amp; write</em> on your
              new repo, saved in <em>Settings → Advanced</em> as{" "}
              <code className="font-mono text-xs bg-slate-800/80 text-slate-300 rounded px-1 py-0.5">
                KEBAB_UPDATE_PAT
              </code>
              . Each update copies the latest release into your repo and stops if you edited one of
              the files it needs to change.
            </p>
          </div>
        </aside>
      </div>
    </section>
  );
}

// ── Alternative: Fork + Vercel Import ──────────────────────────────────

function ForkAlternativeCard() {
  return (
    <section
      aria-labelledby="fork-heading"
      className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6 sm:p-8 mb-12 sm:mb-14"
    >
      <div className="grid grid-cols-1 lg:grid-cols-[1.3fr_1fr] gap-8 items-start">
        <div>
          <div className="flex items-center gap-3 mb-3 flex-wrap">
            <span className="text-xs font-semibold text-slate-300 uppercase tracking-wide">
              Alternative
            </span>
            <span className="text-xs font-mono text-slate-500">~ 5 min</span>
          </div>
          <h2 id="fork-heading" className="text-xl sm:text-2xl font-bold text-white mb-3">
            Fork on GitHub, deploy on Vercel
          </h2>
          <p className="text-sm text-slate-400 leading-relaxed mb-6">
            Prefer a real GitHub fork of{" "}
            <code className="font-mono text-xs bg-slate-800/80 text-slate-300 rounded px-1.5 py-0.5">
              Yassinello/kebab-mcp
            </code>
            ? You keep the shared git history, GitHub&apos;s <em>Sync fork</em> button works, and
            the dashboard updates through GitHub&apos;s merge-upstream. You attach the Upstash
            database yourself.
          </p>
          <div className="flex flex-col sm:flex-row gap-3">
            <a
              href={GITHUB_FORK_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-2 border border-slate-700 hover:border-slate-500 text-slate-200 hover:text-white transition-colors px-5 py-2.5 rounded-lg font-semibold text-sm"
            >
              <GitHubMark />
              1. Fork on GitHub
            </a>
            <a
              href={VERCEL_IMPORT_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-2 border border-slate-700 hover:border-slate-500 text-slate-200 hover:text-white transition-colors px-5 py-2.5 rounded-lg font-semibold text-sm"
            >
              <VercelMark />
              2. Import to Vercel
            </a>
          </div>
        </div>

        <details className="rounded-xl border border-slate-800 bg-slate-950/60 p-5 group">
          <summary className="cursor-pointer text-xs font-mono uppercase tracking-widest text-slate-500 hover:text-slate-300">
            Step by step
          </summary>
          <ol className="space-y-3 text-sm text-slate-400 mt-4">
            <li className="flex gap-3">
              <StepBadge n={1} />
              <span>
                Click <strong>Fork on GitHub</strong>, keep the source as{" "}
                <code className="font-mono text-xs">Yassinello/kebab-mcp</code>, confirm.
              </span>
            </li>
            <li className="flex gap-3">
              <StepBadge n={2} />
              <span>
                Open <strong>Import to Vercel</strong>, pick your fork, keep the defaults, click{" "}
                <strong>Deploy</strong>.
              </span>
            </li>
            <li className="flex gap-3">
              <StepBadge n={3} />
              <span>
                In the project: <strong>Storage</strong> → <strong>Connect Database</strong> →{" "}
                <strong>Upstash for Redis</strong> (Free). Vercel injects{" "}
                <code className="font-mono text-xs">KV_REST_API_*</code> and redeploys.
              </span>
            </li>
            <li className="flex gap-3">
              <StepBadge n={4} />
              <span>
                Open your deploy URL → <code className="font-mono text-xs">/welcome</code> → mint
                your token and connect your AI client.
              </span>
            </li>
          </ol>
        </details>
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
          <code className="font-mono text-xs">MCP_AUTH_TOKEN</code> and copy it. With Upstash
          already attached, the storage step is skipped.
        </li>
        <li>
          <strong className="text-slate-200">Connect a client</strong> — <em>Add to Claude</em> in
          one click, or paste the token into Cursor, Codex or ChatGPT.
        </li>
        <li>
          <strong className="text-slate-200">Add connectors</strong> — drop Google, Slack, Notion,
          etc. credentials in Settings to activate tools.
        </li>
        <li>
          <strong className="text-slate-200">Stay up to date</strong> — click <em>Update now</em> in
          the dashboard when a release is out. It syncs a fork through GitHub, or copies the release
          into a Deploy Button repo.
        </li>
      </ul>
    </section>
  );
}
