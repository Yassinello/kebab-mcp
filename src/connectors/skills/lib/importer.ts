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

  let files = src.files;
  const v = validateFiles(files);
  if (!v.ok) {
    warnings.push(`bundled files dropped: ${v.error}`);
    files = {};
  }

  const id = toKebabId(name).replace(/[^a-z0-9_]/g, "_");
  const match = existing.find((s) => s.id === id);
  return {
    name: toAgentName(id),
    id,
    title: parsed.title ?? match?.name ?? name,
    description: parsed.description,
    body: parsed.body,
    tags: parsed.tags,
    arguments: parsed.arguments,
    files,
    action: match ? "update" : "create",
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
  const items = sources.filter((s) => s.skillMd.trim()).map((s) => planOne(s, existing));
  if (items.length === 0) return { ok: false, error: "No usable SKILL.md found." };
  const seen = new Set<string>();
  for (const it of items) {
    if (seen.has(it.id))
      it.warnings.push(`duplicate name "${it.name}" in this import — last one wins`);
    seen.add(it.id);
  }
  return { ok: true, items };
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
      const filesRes = await setSkillFiles(skillId, it.files);
      if ("error" in filesRes) throw new Error(filesRes.error);
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
