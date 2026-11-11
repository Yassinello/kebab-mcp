/**
 * Skills v2 — import of Agent Skills bundles (spec §7).
 *
 * Input: a raw SKILL.md text, or a zip (one skill folder or a library of
 * folders). Output: a preview (what would be created / updated, warnings),
 * and on save the actual store writes. An existing skill with the same
 * name is UPDATED (new version) rather than duplicated.
 */

import { toMsg } from "@/core/error-utils";
import {
  createSkillVersioned,
  listSkills,
  setSkillFiles,
  updateSkillVersioned,
  type Skill,
} from "../store";
import {
  firstHeading,
  parseSkillMd,
  parseSkillsZip,
  toAgentName,
  toKebabId,
  validateFiles,
  type ImportedSkill,
} from "./bundle";

export interface ImportPlanItem {
  name: string; // agent name
  id: string; // kebab id it maps to
  title: string;
  description: string;
  body: string;
  tags: string[];
  arguments: { name: string; description: string; required: boolean }[];
  files: Record<string, string>;
  action: "create" | "update";
  /** On update: keep the existing bundled files (none supplied / invalid). */
  keepFiles: boolean;
  warnings: string[];
}

export type ImportPlan = { ok: true; items: ImportPlanItem[] } | { ok: false; error: string };

function slug(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function planOne(src: ImportedSkill, existing: Skill[]): ImportPlanItem {
  const parsed = parseSkillMd(src.skillMd);
  const warnings = [...src.warnings, ...parsed.warnings];
  let name = parsed.name ? slug(parsed.name) : "";
  if (!name && src.folder) {
    name = slug(src.folder);
    warnings.push("frontmatter has no name — using the folder name");
  }
  if (!name) {
    const h = firstHeading(parsed.body);
    name = h ? slug(h) : "imported-skill";
    warnings.push("frontmatter has no name — inferred from the first heading");
  }
  if (parsed.name && slug(parsed.name) !== parsed.name) {
    warnings.push(`name normalized to "${name}" (Agent Skills names are lower-case with hyphens)`);
  }
  if (!parsed.description) warnings.push("no description — the skill will be hard to trigger");

  const id = toKebabId(name).replace(/[^a-z0-9_]/g, "_");
  const match = existing.find((s) => s.id === id);

  let files = src.files;
  let filesValid = true;
  const v = validateFiles(files);
  if (!v.ok) {
    warnings.push(`bundled files not imported: ${v.error}`);
    files = {};
    filesValid = false;
  }
  const supplied = Object.keys(files).length > 0;
  // An update never silently wipes what the import does not carry: a pasted
  // SKILL.md (or a Claude/ChatGPT export without files / tags) keeps the
  // skill's existing bundled files and profile tags.
  const keepFiles = !!match && (!supplied || !filesValid);
  const existingFiles = match?.files?.length ?? 0;
  if (keepFiles && existingFiles > 0) {
    warnings.push(`keeps its ${existingFiles} existing bundled file(s)`);
  } else if (match && supplied && existingFiles > 0) {
    warnings.push(`replaces its ${existingFiles} existing bundled file(s)`);
  }
  let tags = parsed.tags;
  if (match && tags.length === 0 && (match.tags?.length ?? 0) > 0) {
    tags = match.tags;
    warnings.push(`keeps its tags (${tags.map((t) => `#${t}`).join(" ")})`);
  }

  return {
    name: toAgentName(id),
    id,
    title: parsed.title ?? match?.name ?? name,
    description: parsed.description,
    body: parsed.body,
    tags,
    arguments: parsed.arguments,
    files,
    action: match ? "update" : "create",
    keepFiles,
    warnings,
  };
}

export async function planImport(input: {
  skillMd?: string;
  zip?: Uint8Array;
}): Promise<ImportPlan> {
  let sources: ImportedSkill[];
  if (input.zip) {
    const z = parseSkillsZip(input.zip);
    if (!z.ok) return z;
    sources = z.skills;
  } else if (typeof input.skillMd === "string" && input.skillMd.trim()) {
    sources = [{ folder: null, skillMd: input.skillMd, files: {}, warnings: [] }];
  } else {
    return { ok: false, error: "Provide a SKILL.md text or a .zip file." };
  }
  const existing = await listSkills();
  const planned = sources.filter((s) => s.skillMd.trim()).map((s) => planOne(s, existing));
  if (planned.length === 0) return { ok: false, error: "No usable SKILL.md found." };
  // Same name twice in one import: keep the LAST occurrence only (otherwise
  // the second create would land as a duplicate `<id>_2`).
  const byId = new Map<string, ImportPlanItem>();
  for (const it of planned) {
    if (byId.has(it.id)) {
      it.warnings.push(`"${it.name}" appears more than once in this import — the last one is used`);
    }
    byId.set(it.id, it);
  }
  return { ok: true, items: [...byId.values()] };
}

export interface ImportResultItem {
  name: string;
  id: string;
  action: "created" | "updated";
  error?: string;
}

/** Apply a plan. Never throws; per-item errors are reported. */
export async function applyImport(items: ImportPlanItem[]): Promise<ImportResultItem[]> {
  const out: ImportResultItem[] = [];
  for (const it of items) {
    try {
      let skillId = it.id;
      if (it.action === "update") {
        const updated = await updateSkillVersioned(it.id, {
          name: it.title,
          description: it.description,
          content: it.body,
          arguments: it.arguments,
          tags: it.tags,
          source: { type: "inline" },
        });
        if (!updated) throw new Error("skill disappeared during import");
      } else {
        // Explicit id so export → import round-trips keep the same name.
        const created = await createSkillVersioned({
          id: it.id,
          name: it.title,
          description: it.description,
          content: it.body,
          arguments: it.arguments,
          tags: it.tags,
          exposeAsTool: false,
          source: { type: "inline" },
        });
        skillId = created.id;
      }
      if (!it.keepFiles) {
        const filesRes = await setSkillFiles(skillId, it.files);
        if ("error" in filesRes) throw new Error(filesRes.error);
      }
      out.push({
        name: toAgentName(skillId),
        id: skillId,
        action: it.action === "update" ? "updated" : "created",
      });
    } catch (err) {
      out.push({
        name: it.name,
        id: it.id,
        action: it.action === "update" ? "updated" : "created",
        error: toMsg(err),
      });
    }
  }
  return out;
}
