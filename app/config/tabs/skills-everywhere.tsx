"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Skills v2 — "Use your skills in every AI client" guide (spec §2 channels).
 * Pure guidance + copyable commands; no state is changed from here.
 */

function CopyLine({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-start gap-2">
      <pre className="flex-1 min-w-0 overflow-x-auto bg-bg-muted border border-border rounded-md px-3 py-2 text-[11px] font-mono text-text whitespace-pre">
        {text}
      </pre>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
        className="text-[11px] px-2 py-1 border border-border rounded-md text-text-dim hover:text-text shrink-0"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/**
 * Pull → prune → unzip. The prune step deletes only the folders listed in
 * the PREVIOUS `.kebab-skills.json` (i.e. skills Kebab installed), so skills
 * removed from Kebab disappear locally and hand-made skills are untouched.
 */
export function nativeSyncCommand(origin: string, dir: string): string {
  const prune =
    `node -e 'const f=require("fs"),p=require("path"),d=process.argv[1];` +
    `try{for(const s of JSON.parse(f.readFileSync(p.join(d,".kebab-skills.json"))).skills)` +
    `f.rmSync(p.join(d,s),{recursive:true,force:true})}catch{}' ${dir}`;
  return [
    `curl -fsS -H "Authorization: Bearer $KEBAB_TOKEN" ${origin}/api/skills/bundle -o /tmp/kebab-skills.zip \\`,
    `  && mkdir -p ${dir} && ${prune} \\`,
    `  && unzip -oq /tmp/kebab-skills.zip -d ${dir}`,
  ].join("\n");
}

/** Contract 3: dashboard deep link to the Kebab House skill panel. */
export const KEBAB_SKILL_PANEL = "kebab-skill";

const KEBAB_SKILL_STEPS: { client: string; text: string }[] = [
  {
    client: "claude.ai and Claude Desktop",
    text: "Settings → Capabilities → Skills → Upload skill, then pick the downloaded .zip.",
  },
  {
    client: "Claude Code",
    text: "Unzip it into ~/.claude/skills/ (you get ~/.claude/skills/kebab-house/).",
  },
  {
    client: "ChatGPT",
    text: "Skills → Create → Upload from your computer, then pick the .zip.",
  },
];

/**
 * Contract 3 — "the Kebab House skill": one native skill (`kebab-house`)
 * to add to Claude once. It makes Claude use the owner's profile, skills
 * and Kebab House rules on its own. Formerly "Master relay".
 *
 * `focus` (from `/config?tab=skills&panel=kebab-skill`) scrolls the panel
 * into view and highlights it briefly. Downloading records the step on the
 * Overview checklist (POST /api/config/hub).
 */
export function KebabSkillPanel({
  tags = [],
  focus = false,
}: {
  tags?: string[];
  focus?: boolean;
}) {
  const [tag, setTag] = useState("");
  const [highlight, setHighlight] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const href = `/api/config/skills/relay-master${tag ? `?tag=${encodeURIComponent(tag)}` : ""}`;

  useEffect(() => {
    if (!focus) return;
    ref.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    setHighlight(true);
    const t = setTimeout(() => setHighlight(false), 2500);
    return () => clearTimeout(t);
  }, [focus]);

  const onDownload = () => {
    // fire-and-forget OK: the checklist mark must never block the download
    void fetch("/api/config/hub", {
      method: "POST",
      credentials: "include",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mark: "kebab-skill" }),
    }).catch(() => {});
    download(href);
  };

  return (
    <section
      ref={ref}
      id={KEBAB_SKILL_PANEL}
      aria-labelledby="kebab-skill-title"
      data-highlighted={highlight ? "true" : undefined}
      className={`border rounded-xl px-5 py-5 scroll-mt-24 transition-shadow duration-500 ${
        highlight ? "border-accent ring-2 ring-accent/40 bg-accent/10" : "border-border bg-bg"
      }`}
    >
      <h2 id="kebab-skill-title" className="text-base font-semibold text-text">
        Add the Kebab House skill to Claude
      </h2>
      <p className="text-sm text-text-dim mt-1 leading-relaxed max-w-2xl">
        One small skill that makes Claude use your profile, your skills and the Kebab House rules on
        its own, without you asking. Add it once per Claude account.
      </p>
      <div className="flex flex-wrap items-center gap-2 mt-3">
        <button
          type="button"
          onClick={onDownload}
          className="text-sm font-medium bg-accent text-white px-3.5 py-2 rounded-lg hover:bg-accent/90 whitespace-nowrap"
        >
          Download the Kebab House skill (.zip)
        </button>
        {tags.length > 0 && (
          <label className="flex items-center gap-1.5 text-xs text-text-muted">
            Only skills tagged
            <select
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              className="text-xs bg-bg border border-border rounded-md px-2 py-1 text-text"
              aria-label="Limit the Kebab House skill to one tag"
            >
              <option value="">all skills</option>
              {tags.map((t) => (
                <option key={t} value={t}>
                  #{t}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <ul className="mt-4 space-y-1 text-[13px] text-text-dim">
        {KEBAB_SKILL_STEPS.map((s) => (
          <li key={s.client}>
            <strong className="text-text">{s.client}:</strong> {s.text}
          </li>
        ))}
      </ul>
      <p className="text-xs text-text-muted mt-3">
        It lists your skill names only: edits to a skill are live right away. Download it again when
        you add, rename or remove many skills.
      </p>
    </section>
  );
}

function download(href: string) {
  window.location.href = href;
}

export function SkillsEverywherePanel({ defaultOpen = false }: { defaultOpen?: boolean } = {}) {
  const [open, setOpen] = useState(defaultOpen);
  const [origin, setOrigin] = useState("https://your-kebab.vercel.app");
  useEffect(() => {
    if (typeof window !== "undefined") setOrigin(window.location.origin);
  }, []);

  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-3 py-2 text-left rounded-md focus-visible:outline-2 focus-visible:outline-accent group"
        aria-expanded={open}
      >
        <div className="flex-1 min-w-0">
          <p className="text-base font-semibold text-text">Use your skills in every AI client</p>
          <p className="text-sm text-text-dim mt-1">
            One library here — Claude (all accounts), ChatGPT, Codex, Claude Code, Cadens…
          </p>
        </div>
        <span className="text-sm text-text-dim group-hover:text-text">
          {open ? "Hide" : "Show"}
        </span>
      </button>
      {open && (
        <div className="mt-4 border-t border-border text-sm text-text-dim divide-y divide-border [&>div]:py-4">
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-1">
              1 · Any client connected to Kebab — nothing to install
            </h3>
            <p>
              Clients see your catalogue in Kebab&apos;s server instructions and load a skill with{" "}
              <code>skill_load</code> when a request matches (plus <code>skills_list</code> and{" "}
              <code>skill_read_file</code>). Edits are live everywhere instantly. Tip: if a client
              doesn&apos;t pick a skill on its own, say &quot;use my <em>name</em> skill&quot;.
            </p>
          </div>
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-1">
              2 · claude.ai, Claude Desktop, ChatGPT — the Kebab House skill
            </h3>
            <p>
              Add the Kebab House skill once (see{" "}
              <a href={`#${KEBAB_SKILL_PANEL}`} className="text-accent">
                Add the Kebab House skill to Claude
              </a>
              ): its description lists your skills, so the app reads your profile (
              <code>my_context</code>), finds the skill (<code>skills_list</code>) and loads it (
              <code>skill_load</code>) on its own.
            </p>
          </div>
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-1">
              3 · Optional — a relay per skill
            </h3>
            <p>
              For a skill you want the app to trigger on its own exact description, download its{" "}
              <strong>relay .zip</strong> (skill → Actions) and upload it the same way. It only
              carries the description and tells the model to <code>skill_load</code> the real skill
              from Kebab, so you never have to re-upload after editing.
            </p>
          </div>
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-1">
              4 · Claude Code / Codex — native copy
            </h3>
            <p className="mb-2">
              Pull the whole library (scoped to the token&apos;s skill tags) into the agent&apos;s
              skills folder. Re-run (or cron) to update. <code>KEBAB_TOKEN</code> is your MCP token.
            </p>
            <div className="space-y-2">
              <p className="text-xs text-text-muted">Claude Code</p>
              <CopyLine text={nativeSyncCommand(origin, "~/.claude/skills")} />
              <p className="text-xs text-text-muted">Codex</p>
              <CopyLine text={nativeSyncCommand(origin, "~/.codex/skills")} />
            </div>
          </div>
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-1">
              5 · Profiles
            </h3>
            <p>
              Tag skills (<code>perso</code>, <code>cadens</code>…), then in{" "}
              <strong>Devices</strong> give each client token the tags it may see. A token without
              skill tags sees every skill.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
