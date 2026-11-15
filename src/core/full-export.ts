/**
 * Kebab House phase 2 (EXP-01) — one zip with everything that is yours:
 * profiles, skills (Agent Skills folders), memory vault (Markdown), and a
 * filtered copy of the KV store. Readable without Kebab House: open the
 * vault folder in Obsidian, drop the skills in ~/.claude/skills.
 *
 * Never included: connector credentials and other secrets (SEC-02 list),
 * OAuth clients/codes/tokens, device entries, first-run claims, rate-limit
 * buckets, usage counters, and the vault/skill payloads already exported as
 * files.
 */

import { strToU8, zipSync, type Zippable } from "fflate";
import { exportBackup, isSecretKey } from "./backup";
import { listProfiles, getProfileContent, DEFAULT_PROFILE } from "./profiles";
import { listSkills, getSkillFiles } from "@/connectors/skills/store";
import { skillMdFor } from "@/connectors/skills/lib/library";
import { toAgentName } from "@/connectors/skills/lib/bundle";
import { getVaultBackend } from "@/connectors/vault/lib/select";
import { toMsg } from "./error-utils";

/** Key prefixes left out of kebab-house.json (tenant-relative). */
const EXCLUDED_PREFIXES = [
  "oauth:",
  "devices:",
  "ratelimit:",
  "usage:",
  "vault:note:",
  "vault:index",
  "skill:",
  "approvals:",
  "approval:",
  "onboarding:",
  "global:update-check",
];

function relativeKey(key: string): string {
  const m = /^tenant:[^:]+:(.*)$/.exec(key);
  return m?.[1] ?? key;
}

export function isExcludedFromExport(key: string): boolean {
  if (isSecretKey(key)) return true;
  const k = relativeKey(key);
  return EXCLUDED_PREFIXES.some((p) => k.startsWith(p));
}

export interface FullExportReport {
  profiles: number;
  skills: number;
  notes: number;
  kvKeys: number;
  warnings: string[];
}

const README = `Kebab House export
===================

- profiles/   your profiles (Markdown), one file per hat; default.md is the default one
- skills/     your skills in the Agent Skills format (folder per skill: SKILL.md + files)
              → copy them into ~/.claude/skills, or import the folders from the dashboard
- vault/      your memory vault (Markdown) → open it as an Obsidian vault
- kebab-house.json  other settings stored in the KV (secrets, tokens and devices are excluded)

Re-import into another Kebab House:
- skills: Skills tab → Import (zip of the skills/ folder)
- profiles: Settings → Profile (paste) or ask your AI client to save it with my_context_update
- vault: put vault/ in a GitHub repo and use "Import from GitHub" in the Memory Vault card
kebab-house.json is not re-imported automatically.
`;

export async function buildFullExport(): Promise<{ zip: Uint8Array; report: FullExportReport }> {
  const files: Zippable = {};
  const warnings: string[] = [];
  const enc = (s: string) => strToU8(s);

  // Profiles
  const profiles = await listProfiles();
  for (const p of profiles) {
    const content = (await getProfileContent(p.name)) ?? "";
    if (p.name === DEFAULT_PROFILE && p.mode === "vault") {
      warnings.push("The default profile lives in the vault: see vault/ for its content.");
    }
    files[`profiles/${p.name}.md`] = enc(content);
  }

  // Skills
  const skills = await listSkills();
  for (const s of skills) {
    const dir = `skills/${toAgentName(s.id)}`;
    files[`${dir}/SKILL.md`] = enc(skillMdFor(s));
    const extra = await getSkillFiles(s.id);
    for (const [path, body] of Object.entries(extra)) files[`${dir}/${path}`] = enc(body);
  }

  // Vault
  let notes = 0;
  try {
    const vault = getVaultBackend();
    const tree = await vault.tree();
    for (const f of tree) {
      if (!f.path.toLowerCase().endsWith(".md")) continue;
      try {
        const note = await vault.read(f.path);
        files[`vault/${f.path}`] = enc(note.content);
        notes++;
      } catch (err) {
        warnings.push(`vault/${f.path}: ${toMsg(err)}`);
      }
    }
  } catch (err) {
    warnings.push(`Memory vault not exported: ${toMsg(err)}`);
  }

  // Filtered KV
  const backup = await exportBackup();
  const entries: Record<string, string> = {};
  for (const [k, v] of Object.entries(backup.entries)) {
    if (!isExcludedFromExport(k)) entries[k] = v;
  }
  files["kebab-house.json"] = enc(
    JSON.stringify(
      { version: 1, exportedAt: backup.exportedAt, scope: backup.scope, entries },
      null,
      2
    )
  );
  files["README.txt"] = enc(README);

  return {
    zip: zipSync(files, { level: 6 }),
    report: {
      profiles: profiles.length,
      skills: skills.length,
      notes,
      kvKeys: Object.keys(entries).length,
      warnings,
    },
  };
}

// ── EXP-03: re-import an export zip ──────────────────────────────────

export interface FullImportReport {
  profiles: number;
  skills: { created: number; updated: number; failed: number };
  notes: { written: number; skipped: number; failed: number };
  warnings: string[];
}

const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

/**
 * Import profiles, skills and vault notes from a Kebab House export zip.
 * Additive: nothing is deleted; existing skills are updated as a new
 * version; existing notes are overwritten only when `overwriteNotes`.
 * kebab-house.json (settings) is never re-imported.
 */
export async function importFullExport(
  zip: Uint8Array,
  opts: { overwriteNotes?: boolean } = {}
): Promise<FullImportReport> {
  if (zip.byteLength > MAX_IMPORT_BYTES) throw new Error("Export too large (max 20 MB).");
  const { unzipSync, strFromU8 } = await import("fflate");
  const { saveProfile } = await import("./profiles");
  const { planImport, applyImport } = await import("@/connectors/skills/lib/importer");
  const files = unzipSync(zip);
  const report: FullImportReport = {
    profiles: 0,
    skills: { created: 0, updated: 0, failed: 0 },
    notes: { written: 0, skipped: 0, failed: 0 },
    warnings: [],
  };

  // Profiles
  for (const [path, body] of Object.entries(files)) {
    const m = /^profiles\/([a-z0-9][a-z0-9-]{0,39})\.md$/.exec(path);
    if (!m) continue;
    try {
      await saveProfile(m[1]!, strFromU8(body));
      report.profiles++;
    } catch (err) {
      report.warnings.push(`${path}: ${toMsg(err)}`);
    }
  }

  // Skills: re-zip the skills/ folders and go through the regular importer.
  const skillFiles: Zippable = {};
  for (const [path, body] of Object.entries(files)) {
    if (path.startsWith("skills/") && !path.endsWith("/")) skillFiles[path.slice(7)] = body;
  }
  if (Object.keys(skillFiles).length) {
    const plan = await planImport({ zip: zipSync(skillFiles) });
    if (!plan.ok) {
      report.warnings.push(`skills: ${plan.error}`);
    } else {
      for (const r of await applyImport(plan.items)) {
        if (r.error) report.skills.failed++;
        else if (r.action === "updated") report.skills.updated++;
        else report.skills.created++;
      }
    }
  }

  // Vault notes
  const vault = getVaultBackend();
  for (const [path, body] of Object.entries(files)) {
    if (!path.startsWith("vault/") || !path.toLowerCase().endsWith(".md")) continue;
    const notePath = path.slice(6);
    try {
      if (!opts.overwriteNotes) {
        const exists = await vault.read(notePath).then(
          () => true,
          () => false
        );
        if (exists) {
          report.notes.skipped++;
          continue;
        }
      }
      await vault.write(notePath, strFromU8(body), { message: "Import Kebab House export" });
      report.notes.written++;
    } catch (err) {
      report.notes.failed++;
      report.warnings.push(`${path}: ${toMsg(err)}`);
    }
  }
  return report;
}
