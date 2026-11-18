"use client";

import { useState, type ReactNode } from "react";
import {
  claudeAddConnectorUrl,
  claudeCodeAddCommand,
  cursorInstallUrl,
  SETUP_PHRASE,
} from "@/core/client-links";

/**
 * "Connect Claude, then say one sentence" — the first thing to do after
 * deploying. Shared by the last /welcome step (dark wizard theme) and the
 * dashboard Overview while no AI client is connected yet (dashboard theme).
 *
 * Order: one button that opens Claude with the URL filled in, the same URL
 * to copy, three illustrated steps (add, authorise, choose the access
 * level), then the setup phrase. Other clients sit in a closed section.
 */

export type ConnectCardTone = "dark" | "light";

const TONES = {
  dark: {
    card: "rounded-lg border border-slate-800 bg-slate-900/40",
    title: "text-white",
    body: "text-slate-400",
    strong: "text-slate-200",
    primary: "bg-blue-500 hover:bg-blue-400 text-white",
    secondary: "bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700",
    code: "text-blue-200 bg-slate-950/50 border border-slate-800",
    phrase: "text-white bg-slate-950/60 border border-blue-500/40",
    frame: "border border-slate-800 bg-slate-950/60 text-slate-600",
    accent: "text-blue-400",
    badge: "bg-blue-500/20 border border-blue-500/40 text-blue-300",
    link: "text-blue-300 hover:text-blue-200 underline underline-offset-2",
    divider: "border-slate-800",
  },
  light: {
    card: "rounded-lg border border-accent/30 bg-accent/5",
    title: "text-text",
    body: "text-text-dim",
    strong: "text-text",
    primary: "bg-accent hover:bg-accent/90 text-white",
    secondary: "bg-bg hover:bg-bg-muted text-text-dim border border-border",
    code: "text-text bg-bg border border-border",
    phrase: "text-text bg-bg border border-accent/40",
    frame: "border border-border bg-bg text-text-muted",
    accent: "text-accent",
    badge: "bg-accent/10 border border-accent/30 text-accent",
    link: "text-accent hover:underline",
    divider: "border-border",
  },
} as const;

type Tone = (typeof TONES)[ConnectCardTone];

export interface ConnectClaudeCardProps {
  /** The instance's MCP endpoint, e.g. https://house.example.org/api/mcp. */
  mcpUrl: string;
  tone?: ConnectCardTone;
  /** Where the "Kebab House skill" link goes (dashboard Skills panel). */
  skillHref?: string;
  /** DOM id of the card, for in-page links. */
  id?: string;
}

export function ConnectClaudeCard({
  mcpUrl,
  tone = "light",
  skillHref,
  id = "connect-claude",
}: ConnectClaudeCardProps) {
  const t = TONES[tone];
  const titleId = `${id}-title`;
  return (
    <section id={id} aria-labelledby={titleId} className={`${t.card} p-5 sm:p-6 scroll-mt-6`}>
      <h2 id={titleId} className={`text-lg font-semibold ${t.title}`}>
        Connect Claude
      </h2>
      <p className={`text-sm mt-1 leading-relaxed ${t.body}`}>
        Add Kebab House to Claude once (web, desktop or mobile), then say one sentence. Claude does
        the rest with you.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <a
          href={claudeAddConnectorUrl(mcpUrl)}
          target="_blank"
          rel="noopener noreferrer"
          className={`inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold transition-colors ${t.primary}`}
        >
          Connect Claude
          <span aria-hidden="true">↗</span>
        </a>
      </div>

      <p className={`text-xs mt-4 mb-1.5 ${t.body}`}>
        Or add it by hand in Claude (Settings → Connectors → Add custom connector) with this URL:
      </p>
      <CopyLine value={mcpUrl} label="Copy URL" tone={t} />

      <ol className="mt-5 grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Step
          n={1}
          tone={t}
          title="Add the connector"
          art={<AddArt accent={t.accent} />}
          text="The button opens Claude with your URL filled in. Click Add, then Connect."
        />
        <Step
          n={2}
          tone={t}
          title="Authorise"
          art={<AuthoriseArt accent={t.accent} />}
          text="Claude opens your Kebab House page. Sign in with your admin key if it asks."
        />
        <Step
          n={3}
          tone={t}
          title="Choose the access level"
          art={<AccessArt accent={t.accent} />}
          text="Pick “Read + my profile and notes” (recommended), then Approve."
        />
      </ol>

      <div className={`mt-6 pt-5 border-t ${t.divider}`}>
        <p className={`text-sm font-semibold mb-2 ${t.title}`}>Now say this in Claude:</p>
        <div className="flex items-center gap-2">
          <p
            className={`flex-1 min-w-0 rounded-md px-3 py-2.5 text-base font-semibold ${t.phrase}`}
          >
            {SETUP_PHRASE}
          </p>
          <CopyButton value={SETUP_PHRASE} label="Copy phrase" tone={t} />
        </div>
        <p className={`text-xs mt-2 leading-relaxed ${t.body}`}>
          Claude interviews you, writes your profile, installs your rituals and helps you plug in
          your connectors. You confirm settings changes in your browser, and secrets are never typed
          in the chat.
        </p>
        {skillHref && (
          <p className={`text-xs mt-2 leading-relaxed ${t.body}`}>
            Optional:{" "}
            <a href={skillHref} className={t.link}>
              add the Kebab House skill
            </a>{" "}
            so Claude uses your profile, skills and Kebab House rules on its own.
          </p>
        )}
      </div>

      <OtherClients mcpUrl={mcpUrl} tone={t} />
    </section>
  );
}

function Step({
  n,
  title,
  text,
  art,
  tone,
}: {
  n: number;
  title: string;
  text: string;
  art: ReactNode;
  tone: Tone;
}) {
  return (
    <li className="flex sm:flex-col gap-3 sm:gap-2">
      <div
        className={`shrink-0 w-24 sm:w-full h-16 sm:h-20 rounded-md flex items-center justify-center ${tone.frame}`}
      >
        {art}
      </div>
      <div className="min-w-0">
        <p className={`text-sm font-medium flex items-center gap-2 ${tone.strong}`}>
          <span
            aria-hidden="true"
            className={`w-5 h-5 shrink-0 rounded-full flex items-center justify-center text-[11px] font-bold ${tone.badge}`}
          >
            {n}
          </span>
          {title}
        </p>
        <p className={`text-xs mt-1 leading-relaxed ${tone.body}`}>{text}</p>
      </div>
    </li>
  );
}

function OtherClients({ mcpUrl, tone }: { mcpUrl: string; tone: Tone }) {
  return (
    <details className={`mt-5 pt-4 border-t ${tone.divider} group`}>
      <summary className={`cursor-pointer text-sm font-medium select-none ${tone.strong}`}>
        Other AI clients: Cursor, Claude Code, ChatGPT…
      </summary>
      <ul className={`mt-3 space-y-4 text-xs leading-relaxed ${tone.body}`}>
        <li>
          <p className={`font-semibold mb-1 ${tone.strong}`}>Cursor</p>
          <a
            href={cursorInstallUrl(mcpUrl)}
            className={`inline-flex items-center px-3 py-1.5 rounded-md text-xs font-semibold ${tone.secondary}`}
          >
            Add to Cursor
          </a>
        </li>
        <li>
          <p className={`font-semibold mb-1 ${tone.strong}`}>Claude Code</p>
          <CopyLine value={claudeCodeAddCommand(mcpUrl)} label="Copy command" tone={tone} />
        </li>
        <li>
          <p className={`font-semibold mb-1 ${tone.strong}`}>ChatGPT</p>
          In ChatGPT on the web: Settings → Apps &amp; Connectors → turn on Developer mode, then
          create a connector with your Kebab House URL. You sign in the same way as for Claude.
        </li>
        <li>
          <p className={`font-semibold mb-1 ${tone.strong}`}>Other clients</p>
          Clients that cannot sign in need a token instead. Give each one its own: open your
          dashboard and go to <strong className={tone.strong}>Devices → Add device</strong>. Do not
          use your admin key in an AI client.
        </li>
      </ul>
    </details>
  );
}

function CopyButton({ value, label, tone }: { value: string; label: string; tone: Tone }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => {
        // fire-and-forget OK: clipboard copy in a click handler; failures are caught below
        void Promise.resolve()
          .then(() => navigator.clipboard.writeText(value))
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => {
            // Clipboard unavailable (insecure origin, older browser): the text stays selectable.
          });
      }}
      className={`shrink-0 px-3 py-1.5 rounded-md text-xs font-semibold ${tone.secondary}`}
    >
      {copied ? "Copied ✓" : "Copy"}
    </button>
  );
}

function CopyLine({ value, label, tone }: { value: string; label: string; tone: Tone }) {
  return (
    <div className="flex items-center gap-2">
      <code
        className={`flex-1 min-w-0 break-all text-xs font-mono rounded-md px-3 py-2 ${tone.code}`}
      >
        {value}
      </code>
      <CopyButton value={value} label={label} tone={tone} />
    </div>
  );
}

// ── Illustrations (schematic, decorative) ─────────────────────────────

function AddArt({ accent }: { accent: string }) {
  return (
    <svg viewBox="0 0 96 56" className="w-20 h-12" fill="none" aria-hidden="true">
      <rect x="6" y="4" width="84" height="48" rx="5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M14 13h30" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <rect x="14" y="20" width="68" height="10" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M18 25h40" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <rect x="56" y="36" width="26" height="10" rx="3" className={accent} fill="currentColor" />
    </svg>
  );
}

function AuthoriseArt({ accent }: { accent: string }) {
  return (
    <svg viewBox="0 0 96 56" className="w-20 h-12" fill="none" aria-hidden="true">
      <rect x="6" y="4" width="84" height="48" rx="5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6 12h84" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="12" cy="8" r="1.5" fill="currentColor" />
      <circle cx="17" cy="8" r="1.5" fill="currentColor" />
      <g className={accent}>
        <path
          d="M48 18l9 3.5v6.5c0 5-4 8.5-9 10-5-1.5-9-5-9-10v-6.5z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <path
          d="M44 28l3 3 5-6"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
      <rect x="36" y="42" width="24" height="6" rx="2" className={accent} fill="currentColor" />
    </svg>
  );
}

function AccessArt({ accent }: { accent: string }) {
  return (
    <svg viewBox="0 0 96 56" className="w-20 h-12" fill="none" aria-hidden="true">
      <rect x="6" y="4" width="84" height="48" rx="5" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="18" cy="16" r="4" stroke="currentColor" strokeWidth="1.5" />
      <path d="M27 16h40" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <g className={accent}>
        <circle cx="18" cy="28" r="4" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="18" cy="28" r="2" fill="currentColor" />
        <path d="M27 28h52" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </g>
      <circle cx="18" cy="40" r="4" stroke="currentColor" strokeWidth="1.5" />
      <path d="M27 40h30" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
