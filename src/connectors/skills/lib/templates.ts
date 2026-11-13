/**
 * Kebab House phase 0 — ritual templates (RIT-01..04).
 *
 * Templates are public, generic Agent Skills shipped with the app
 * (`content/skill-templates/<name>/SKILL.md`, inlined into
 * `templates.generated.ts` so serverless bundles always carry them).
 * Installing one goes through the regular import path (planImport →
 * applyImport): same parsing, versioning and update-instead-of-duplicate.
 *
 * Installing never touches other skills — in particular the pre-phase-0
 * starter skills a user may already have stay as they are (RIT-04).
 */

import { parseFrontmatter } from "@/core/frontmatter";
import { listSkills, type Skill } from "../store";
import { MAX_TAGS, parseSkillMd, toKebabId } from "./bundle";
import { applyImport, planImport } from "./importer";
import { SKILL_TEMPLATE_SOURCES } from "./templates.generated";

/** Tag carried by every ritual template (drives per-token tag scope, RIT-03). */
export const RITUALS_TAG = "rituals";

/** Display order; templates not listed here follow alphabetically. */
const ORDER = ["remember", "morning-brief", "meeting-prep", "weekly-review", "read-later"];

export interface SkillTemplate {
  /** Agent Skills name (`morning-brief`). */
  name: string;
  /** Kebab id it installs as (`morning_brief`). */
  id: string;
  title: string;
  description: string;
  icon: string;
  tags: string[];
  /** Instructions (SKILL.md body without frontmatter). */
  body: string;
  /** Raw SKILL.md, fed to the importer. */
  skillMd: string;
}

function iconOf(skillMd: string): string {
  const meta = parseFrontmatter(skillMd).meta.metadata;
  const icon =
    meta && typeof meta === "object" ? (meta as Record<string, unknown>).icon : undefined;
  return typeof icon === "string" && icon.trim() ? icon.trim() : "✨";
}

function loadTemplates(): SkillTemplate[] {
  const out = SKILL_TEMPLATE_SOURCES.map((src): SkillTemplate => {
    const parsed = parseSkillMd(src.skillMd);
    const name = parsed.name ?? src.folder;
    const tags = parsed.tags.includes(RITUALS_TAG) ? parsed.tags : [RITUALS_TAG, ...parsed.tags];
    return {
      name,
      id: toKebabId(name),
      title: parsed.title ?? name,
      description: parsed.description,
      icon: iconOf(src.skillMd),
      tags,
      body: parsed.body,
      skillMd: src.skillMd,
    };
  });
  const rank = (n: string) => {
    const i = ORDER.indexOf(n);
    return i === -1 ? ORDER.length : i;
  };
  return out.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

let cache: SkillTemplate[] | null = null;

export function listSkillTemplates(): SkillTemplate[] {
  if (!cache) cache = loadTemplates();
  return cache;
}

/** Accepts the Agent Skills name (`morning-brief`) or the Kebab id (`morning_brief`). */
function findSkillTemplate(nameOrId: string): SkillTemplate | null {
  const id = toKebabId(nameOrId);
  return listSkillTemplates().find((t) => t.id === id) ?? null;
}

// ── Install status ──────────────────────────────────────────────────────

/**
 * - `available`: no skill with this id yet.
 * - `installed`: the skill matches the template (instructions, description, tags).
 * - `modified`: a skill with this id exists but differs (edited by the user,
 *   or an older template version). Installing again saves a new version.
 */
export type TemplateStatus = "available" | "installed" | "modified";

function statusOf(t: SkillTemplate, existing: Skill[]): TemplateStatus {
  const s = existing.find((x) => x.id === t.id);
  if (!s) return "available";
  const same =
    s.content.trim() === t.body.trim() &&
    s.description.trim() === t.description.trim() &&
    t.tags.every((tag) => (s.tags ?? []).includes(tag));
  return same ? "installed" : "modified";
}

export interface TemplateCatalogEntry {
  id: string; // Agent Skills name — the stable template identifier in the API
  name: string;
  skillId: string;
  title: string;
  description: string;
  icon: string;
  tags: string[];
  status: TemplateStatus;
  installed: boolean;
}

/** Templates + install status against the current store (status `available` if KV is unreadable). */
export async function templateCatalog(): Promise<TemplateCatalogEntry[]> {
  let existing: Skill[] = [];
  try {
    existing = await listSkills();
  } catch {
    // silent-swallow-ok: the catalogue stays usable without KV; every template then reads "available"
    existing = [];
  }
  return listSkillTemplates().map((t) => {
    const status = statusOf(t, existing);
    return {
      id: t.name,
      name: t.name,
      skillId: t.id,
      title: t.title,
      description: t.description,
      icon: t.icon,
      tags: t.tags,
      status,
      installed: status !== "available",
    };
  });
}

// ── Install ─────────────────────────────────────────────────────────────

export type InstallTemplateResult =
  | { ok: true; id: string; name: string; action: "created" | "updated" | "unchanged" }
  | { ok: false; error: string; status: 400 | 404 | 500 };

/**
 * Install (or update) one template through the regular import path.
 * Idempotent: an up-to-date install is a no-op (no new version). An update
 * keeps the user's display name, bundled files and extra tags.
 */
export async function installSkillTemplate(nameOrId: string): Promise<InstallTemplateResult> {
  const t = findSkillTemplate(nameOrId);
  if (!t) return { ok: false, error: "Unknown template", status: 404 };

  const existing = await listSkills();
  if (statusOf(t, existing) === "installed") {
    return { ok: true, id: t.id, name: t.name, action: "unchanged" };
  }

  const plan = await planImport({ skillMd: t.skillMd });
  if (!plan.ok) return { ok: false, error: plan.error, status: 400 };
  const match = existing.find((s) => s.id === t.id);
  const items = plan.items.map((it) => {
    if (!match) return it;
    const extra = (match.tags ?? []).filter((tag) => !it.tags.includes(tag));
    return { ...it, title: match.name, tags: [...it.tags, ...extra].slice(0, MAX_TAGS) };
  });

  const [result] = await applyImport(items);
  if (!result) return { ok: false, error: "Nothing to install", status: 500 };
  if (result.error) return { ok: false, error: result.error, status: 500 };
  return { ok: true, id: result.id, name: result.name, action: result.action };
}
