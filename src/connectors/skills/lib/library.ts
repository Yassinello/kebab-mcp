/**
 * Skills library v2 — the MCP-facing read surface (spec §5).
 *
 *  - `skills_list` / `skill_load` / `skill_read_file` payload builders
 *  - MCP server instructions (catalogue)
 *  - `skill://` resource provider (SEP-2640-style resource binding)
 *
 * Every entry point applies the caller token's tag scope
 * (`getCurrentSkillScope()`), so an out-of-scope skill is indistinguishable
 * from a missing one.
 */

import type { ResourceContent, ResourceProvider, ResourceSpec } from "@/core/resources";
import { getCurrentSkillScope, isSkillVisible } from "@/core/token-scope";
import { getSkillFiles, listSkills, listSkillsSync, type Skill } from "../store";
import { maybeRefreshRemote } from "./remote-fetcher";
import { renderSkill } from "./render";
import { normalizeTag, serializeSkillMd, toAgentName, toKebabId } from "./bundle";

export const MAX_INSTRUCTION_SKILLS = 60;
const MAX_INSTRUCTIONS_CHARS = 8000;

function normalize(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export function visibleSkills(all: Skill[], scope = getCurrentSkillScope()): Skill[] {
  return all.filter((s) => isSkillVisible(s.tags ?? [], scope));
}

/** Resolve by Agent Skills name (`meeting-prep`), Kebab id (`meeting_prep`) or display name. */
export function findSkill(all: Skill[], nameOrId: string): Skill | null {
  const id = toKebabId(nameOrId);
  const byId = all.find((s) => s.id === id);
  if (byId) return byId;
  const n = normalize(nameOrId.trim());
  return all.find((s) => normalize(s.name) === n) ?? null;
}

function suggestions(all: Skill[], query: string): string[] {
  const terms = normalize(query)
    .split(/[\s_-]+/)
    .filter(Boolean);
  return all
    .map((s) => {
      const hay = normalize(`${s.id} ${s.name} ${s.description}`);
      return { s, score: terms.filter((t) => hay.includes(t)).length };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((x) => toAgentName(x.s.id));
}

function bodyOf(skill: Skill): string {
  if (skill.content) return skill.content;
  if (skill.source.type === "remote") return skill.source.cachedContent ?? "";
  return "";
}

function kb(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

// ── skills_list ─────────────────────────────────────────────────────────

export interface SkillsListArgs {
  query?: string;
  tag?: string;
}

export async function skillsListPayload(args: SkillsListArgs): Promise<Record<string, unknown>> {
  const all = visibleSkills(await listSkills());
  const q = args.query ? normalize(args.query) : null;
  const tag = args.tag ? normalizeTag(args.tag) : null;
  const items = all
    .filter((s) => !tag || (s.tags ?? []).includes(tag))
    .filter((s) => !q || normalize(`${s.id} ${s.name} ${s.description}`).includes(q))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((s) => ({
      name: toAgentName(s.id),
      title: s.name,
      description: s.description,
      tags: s.tags ?? [],
      files: (s.files ?? []).map((f) => f.path),
      arguments: s.arguments.map((a) => ({ name: a.name, required: a.required })),
    }));
  return {
    count: items.length,
    skills: items,
    usage: "Call skill_load with a skill name to get its full instructions before using it.",
  };
}

// ── skill_load ──────────────────────────────────────────────────────────

export interface SkillLoadArgs {
  name: string;
  arguments?: Record<string, unknown>;
}

export async function skillLoadText(
  args: SkillLoadArgs
): Promise<{ ok: true; text: string } | { ok: false; payload: Record<string, unknown> }> {
  const all = visibleSkills(await listSkills());
  const skill = findSkill(all, args.name);
  if (!skill) {
    return {
      ok: false,
      payload: {
        error: "skill_not_found",
        name: args.name,
        suggestions: suggestions(all, args.name),
        hint: "Call skills_list to see available skills.",
      },
    };
  }
  const ready = await maybeRefreshRemote(skill);
  const body = renderSkill(ready, args.arguments ?? {});
  const name = toAgentName(skill.id);
  const parts = [`# Skill: ${name}`, skill.description ? `> ${skill.description}` : "", "", body];

  const missing = skill.arguments.filter(
    (a) => a.required && !Object.prototype.hasOwnProperty.call(args.arguments ?? {}, a.name)
  );
  if (skill.arguments.length) {
    parts.push(
      "",
      "---",
      `Arguments: ${skill.arguments
        .map(
          (a) =>
            `${a.name}${a.required ? " (required)" : ""}${a.description ? ` — ${a.description}` : ""}`
        )
        .join("; ")}`
    );
    if (missing.length) {
      parts.push(
        `Missing required argument(s): ${missing.map((a) => a.name).join(", ")}. Ask the user, or call skill_load again with "arguments".`
      );
    }
  }
  const files = skill.files ?? [];
  if (files.length) {
    parts.push(
      "",
      "---",
      `Bundled files — read on demand with skill_read_file(name="${name}", path=…):`,
      ...files.map((f) => `- ${f.path} (${kb(f.size)})`)
    );
  }
  return {
    ok: true,
    text: parts
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  };
}

// ── skill_read_file ─────────────────────────────────────────────────────

export async function skillReadFile(args: {
  name: string;
  path: string;
}): Promise<{ ok: true; text: string } | { ok: false; payload: Record<string, unknown> }> {
  const all = visibleSkills(await listSkills());
  const skill = findSkill(all, args.name);
  if (!skill) {
    return {
      ok: false,
      payload: {
        error: "skill_not_found",
        name: args.name,
        suggestions: suggestions(all, args.name),
      },
    };
  }
  const files = await getSkillFiles(skill.id);
  const wanted = args.path.replace(/^\.?\//, "");
  if (wanted.toUpperCase() === "SKILL.MD") {
    const loaded = await skillLoadText({ name: skill.id });
    return loaded;
  }
  const content = files[wanted];
  if (content === undefined) {
    return {
      ok: false,
      payload: {
        error: "file_not_found",
        name: toAgentName(skill.id),
        path: args.path,
        available: Object.keys(files).sort(),
      },
    };
  }
  return { ok: true, text: content };
}

// ── Server instructions ─────────────────────────────────────────────────

/**
 * Build the MCP `initialize.instructions` block from the warm cache
 * (sync). Empty string when the caller sees no skills.
 */
export function buildSkillsInstructions(scope: string[] | null): string {
  const skills = visibleSkills(listSkillsSync(), scope).sort((a, b) => a.id.localeCompare(b.id));
  if (skills.length === 0) return "";
  const lines = [
    "Kebab MCP holds the user's personal skills library (Agent Skills format).",
    "When a request matches one of the skills below, call `skill_load` with its name BEFORE answering and follow the returned instructions; fetch bundled files with `skill_read_file` only when needed. Use `skills_list` to search the full catalogue.",
    "",
    "Skills:",
  ];
  let used = lines.join("\n").length;
  let shown = 0;
  for (const s of skills) {
    if (shown >= MAX_INSTRUCTION_SKILLS) break;
    const desc = (s.description || s.name).replace(/\s+/g, " ").slice(0, 200);
    const line = `- ${toAgentName(s.id)}: ${desc}`;
    if (used + line.length + 1 > MAX_INSTRUCTIONS_CHARS) break;
    lines.push(line);
    used += line.length + 1;
    shown += 1;
  }
  if (shown < skills.length) {
    lines.push(`- … and ${skills.length - shown} more: call skills_list.`);
  }
  return lines.join("\n");
}

// ── skill:// resources ──────────────────────────────────────────────────

export function skillMdFor(skill: Skill): string {
  return serializeSkillMd({
    name: toAgentName(skill.id),
    description: skill.description || skill.name,
    body: bodyOf(skill),
    tags: skill.tags ?? [],
    arguments: skill.arguments,
    metadata: { source: "kebab-mcp", kebab_id: skill.id, title: skill.name },
  });
}

function mimeFor(path: string): string {
  if (/\.(md|markdown)$/i.test(path)) return "text/markdown";
  if (/\.json$/i.test(path)) return "application/json";
  return "text/plain";
}

export const skillResourceProvider: ResourceProvider = {
  scheme: "skill",
  async list(): Promise<ResourceSpec[]> {
    const out: ResourceSpec[] = [];
    for (const s of visibleSkills(await listSkills())) {
      const name = toAgentName(s.id);
      out.push({
        uri: `skill://${name}/SKILL.md`,
        name: `${name}/SKILL.md`,
        description: s.description || s.name,
        mimeType: "text/markdown",
      });
      for (const f of s.files ?? []) {
        out.push({
          uri: `skill://${name}/${f.path}`,
          name: `${name}/${f.path}`,
          mimeType: mimeFor(f.path),
        });
      }
    }
    return out;
  },
  async read(uri: string): Promise<ResourceContent> {
    const m = uri.match(/^skill:\/\/([^/]+)\/(.+)$/);
    if (!m) throw new Error(`Invalid skill URI: ${uri}`);
    const [, name, path] = m as unknown as [string, string, string];
    const skill = findSkill(visibleSkills(await listSkills()), name);
    if (!skill) throw new Error(`Unknown skill: ${name}`);
    if (path === "SKILL.md") {
      const ready = await maybeRefreshRemote(skill);
      return { uri, mimeType: "text/markdown", text: skillMdFor(ready) };
    }
    const files = await getSkillFiles(skill.id);
    const text = files[path];
    if (text === undefined) throw new Error(`Unknown file: ${path}`);
    return { uri, mimeType: mimeFor(path), text };
  },
};
