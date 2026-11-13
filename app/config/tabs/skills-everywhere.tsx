"use client";

import { useEffect, useState } from "react";

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

function MasterRelay({ tags }: { tags: string[] }) {
  const [tag, setTag] = useState("");
  const href = `/api/config/skills/relay-master${tag ? `?tag=${encodeURIComponent(tag)}` : ""}`;
  const steps: { client: string; items: string[] }[] = [
    {
      client: "claude.ai",
      items: [
        "Settings → Connectors: add your Kebab House MCP URL, if not done yet.",
        "Customize → Skills → Upload skill: pick the downloaded .zip.",
        "Check that the kebab-house skill is on, then ask e.g. “run my morning brief”.",
      ],
    },
    {
      client: "ChatGPT",
      items: [
        "Settings → Apps & Connectors: add your Kebab House MCP URL, if not done yet.",
        "Skills → Create → Upload from your computer: pick the downloaded .zip.",
        "Enable the connector in the chat, then ask e.g. “prepare my next meeting”.",
      ],
    },
  ];
  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-1">
        2 · claude.ai / ChatGPT — one master relay for the whole library
      </h4>
      <p className="mb-2">
        A single native skill, <code>kebab-house</code>, whose description lists your skills. When a
        request matches, the model reads your profile (<code>my_context</code>), finds the skill (
        <code>skills_list</code>) and loads it (<code>skill_load</code>). Install it once per
        account.
      </p>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <button
          type="button"
          onClick={() => download(href)}
          className="text-xs font-medium text-accent px-3 py-1.5 border border-accent/30 rounded-md hover:bg-accent/10 whitespace-nowrap"
        >
          Master relay (.zip)
        </button>
        {tags.length > 0 && (
          <label className="flex items-center gap-1.5 text-xs text-text-muted">
            Only skills tagged
            <select
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              className="text-xs bg-bg border border-border rounded-md px-2 py-1 text-text"
              aria-label="Limit the master relay to one tag"
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
      <div className="grid gap-3 sm:grid-cols-2">
        {steps.map((s) => (
          <div key={s.client} className="border border-border rounded-md px-3 py-2 bg-bg">
            <p className="text-xs font-semibold text-text mb-1">{s.client}</p>
            <ol className="list-decimal pl-4 space-y-0.5 text-xs">
              {s.items.map((it) => (
                <li key={it}>{it}</li>
              ))}
            </ol>
          </div>
        ))}
      </div>
      <p className="text-xs text-text-muted mt-2">
        The relay only carries skill <em>names</em>: edits to a skill are live right away, but
        download and re-upload the relay when you add, rename or remove many skills.
      </p>
    </div>
  );
}

function download(href: string) {
  window.location.href = href;
}

export function SkillsEverywherePanel({ tags = [] }: { tags?: string[] }) {
  const [open, setOpen] = useState(false);
  const [origin, setOrigin] = useState("https://your-kebab.vercel.app");
  useEffect(() => {
    if (typeof window !== "undefined") setOrigin(window.location.origin);
  }, []);

  return (
    <div className="border border-accent/30 rounded-lg overflow-hidden bg-accent/5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-accent/10 transition-colors"
        aria-expanded={open}
      >
        <div className="w-7 h-7 rounded-full bg-accent/15 text-accent flex items-center justify-center text-xs font-bold shrink-0">
          ⇄
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-text">Use your skills in every AI client</p>
          <p className="text-xs text-text-dim mt-0.5">
            One library here — Claude (all accounts), ChatGPT, Codex, Claude Code, Cadens…
          </p>
        </div>
        <span className="text-xs text-text-muted">{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <div className="border-t border-accent/20 px-4 py-4 text-sm text-text-dim space-y-4 bg-bg/40">
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-1">
              1 · Any client connected to Kebab — nothing to install
            </h4>
            <p>
              Clients see your catalogue in Kebab&apos;s server instructions and load a skill with{" "}
              <code>skill_load</code> when a request matches (plus <code>skills_list</code> and{" "}
              <code>skill_read_file</code>). Edits are live everywhere instantly. Tip: if a client
              doesn&apos;t pick a skill on its own, say &quot;use my <em>name</em> skill&quot;.
            </p>
          </div>
          <MasterRelay tags={tags} />
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-1">
              3 · Optional — a relay per skill
            </h4>
            <p>
              For a skill you want the app to trigger on its own exact description, download its{" "}
              <strong>relay .zip</strong> (skill → Actions) and upload it the same way. It only
              carries the description and tells the model to <code>skill_load</code> the real skill
              from Kebab, so you never have to re-upload after editing.
            </p>
          </div>
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-1">
              4 · Claude Code / Codex — native copy
            </h4>
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
            <h4 className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-1">
              5 · Profiles
            </h4>
            <p>
              Tag skills (<code>perso</code>, <code>cadens</code>…), then in{" "}
              <strong>Devices</strong> give each client token the tags it may see. A token without
              skill tags sees every skill.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
