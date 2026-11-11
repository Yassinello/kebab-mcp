/**
 * Agent Skills bundle helpers (spec skills-library-v2 §4, §7, §9).
 *
 * Pure functions — no KV, no network:
 *  - name mapping between Kebab ids (`meeting_prep`) and Agent Skills names (`meeting-prep`);
 *  - bundled-file path validation + size limits;
 *  - SKILL.md serialization / parsing (frontmatter via js-yaml);
 *  - zip build / parse (fflate) with zip-bomb guards;
 *  - relay-skill generation.
 */

import yaml from "js-yaml";
import { toMsg } from "@/core/error-utils";
import { strFromU8, strToU8, unzipSync, zipSync, type Unzipped } from "fflate";
import { parseFrontmatter } from "@/core/frontmatter";

// ── Limits ──────────────────────────────────────────────────────────────

export const MAX_FILES_PER_SKILL = 30;
export const MAX_FILE_BYTES = 100 * 1024;
export const MAX_SKILL_FILES_BYTES = 512 * 1024;
export const MAX_ZIP_UPLOAD_BYTES = 2 * 1024 * 1024;
export const MAX_ZIP_INFLATED_BYTES = 5 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 200;
export const MAX_DESCRIPTION_CHARS = 1024;
export const MAX_TAGS = 10;

/** Text extensions accepted as bundled files (UTF-8 only in v2). */
const TEXT_EXTENSIONS = new Set([
  "md",
  "markdown",
  "txt",
  "py",
  "sh",
  "bash",
  "js",
  "mjs",
  "cjs",
  "ts",
  "json",
  "yaml",
  "yml",
  "toml",
  "csv",
  "tsv",
  "html",
  "css",
  "xml",
  "sql",
  "rb",
  "go",
  "rs",
  "java",
  "ini",
  "cfg",
  "env.example",
  "tex",
  "r",
  "ps1",
]);

// ── Names ───────────────────────────────────────────────────────────────

/** Kebab id (`[a-z0-9_]`) → Agent Skills name (`[a-z0-9-]`). */
export function toAgentName(id: string): string {
  return id.replace(/_/g, "-");
}

/** Agent Skills name or Kebab id → Kebab id. */
export function toKebabId(name: string): string {
  return name.trim().toLowerCase().replace(/-/g, "_");
}

export function normalizeTag(tag: string): string {
  return tag
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

export function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const out: string[] = [];
  for (const t of tags) {
    if (typeof t !== "string") continue;
    const n = normalizeTag(t);
    if (n && !out.includes(n)) out.push(n);
  }
  return out.slice(0, MAX_TAGS);
}

// ── Paths & files ───────────────────────────────────────────────────────

/**
 * Validate + normalize a bundled-file path. Returns null when unsafe:
 * absolute, backslashes, `..` / `.` segments, empty segments, hidden
 * top-level metadata (`__MACOSX`), the reserved `SKILL.md`, or too long.
 */
export function normalizeFilePath(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const p = raw.trim();
  if (!p || p.length > 200) return null;
  if (p.startsWith("/") || p.includes("\\") || p.includes("\0")) return null;
  const segments = p.split("/");
  for (const seg of segments) {
    if (!seg || seg === "." || seg === "..") return null;
    if (!/^[A-Za-z0-9._ -]+$/.test(seg)) return null;
  }
  if (segments[0] === "__MACOSX") return null;
  if (p.toLowerCase() === "skill.md") return null;
  return p;
}

export function isTextPath(path: string): boolean {
  const base = path.split("/").pop() ?? "";
  if (!base.includes(".")) return true; // e.g. LICENSE, Makefile
  const lower = base.toLowerCase();
  if (lower.endsWith(".env.example")) return true;
  const ext = lower.slice(lower.lastIndexOf(".") + 1);
  return TEXT_EXTENSIONS.has(ext);
}

export function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf-8");
}

export type FilesValidation =
  | { ok: true; files: Record<string, string> }
  | { ok: false; error: string };

/** Validate a full files map against path rules and limits. */
export function validateFiles(input: Record<string, string>): FilesValidation {
  const out: Record<string, string> = {};
  let total = 0;
  const entries = Object.entries(input ?? {});
  if (entries.length > MAX_FILES_PER_SKILL) {
    return { ok: false, error: `Too many files (${entries.length} > ${MAX_FILES_PER_SKILL}).` };
  }
  for (const [rawPath, content] of entries) {
    const p = normalizeFilePath(rawPath);
    if (!p) return { ok: false, error: `Invalid file path: "${rawPath}".` };
    if (typeof content !== "string") return { ok: false, error: `File ${p} must be text.` };
    const size = byteLength(content);
    if (size > MAX_FILE_BYTES) {
      return { ok: false, error: `File ${p} is ${size} bytes (limit ${MAX_FILE_BYTES}).` };
    }
    total += size;
    if (out[p] !== undefined) return { ok: false, error: `Duplicate file path: ${p}.` };
    out[p] = content;
  }
  if (total > MAX_SKILL_FILES_BYTES) {
    return {
      ok: false,
      error: `Bundled files total ${total} bytes (limit ${MAX_SKILL_FILES_BYTES}).`,
    };
  }
  return { ok: true, files: out };
}

// ── SKILL.md ────────────────────────────────────────────────────────────

export interface SkillDoc {
  name: string; // agent name (hyphens)
  description: string;
  body: string;
  tags: string[];
  arguments: { name: string; description: string; required: boolean }[];
  /** Extra metadata to round-trip (kebab_id, version…). */
  metadata?: Record<string, unknown>;
}

/** Serialize to a standard SKILL.md (frontmatter + body). */
export function serializeSkillMd(doc: SkillDoc): string {
  const front: Record<string, unknown> = {
    name: doc.name,
    description: doc.description.slice(0, MAX_DESCRIPTION_CHARS),
  };
  const metadata: Record<string, unknown> = { ...(doc.metadata ?? {}) };
  if (doc.tags.length) metadata.tags = doc.tags;
  if (Object.keys(metadata).length) front.metadata = metadata;
  if (doc.arguments.length) front.arguments = doc.arguments;
  const fm = yaml.dump(front, { lineWidth: -1, noRefs: true }).trimEnd();
  const body = doc.body.replace(/^\s+/, "");
  return `---\n${fm}\n---\n\n${body}${body.endsWith("\n") ? "" : "\n"}`;
}

export interface ParsedSkillMd {
  name: string | null;
  /** Kebab display title round-tripped via `metadata.title`. */
  title: string | null;
  description: string;
  body: string;
  tags: string[];
  arguments: { name: string; description: string; required: boolean }[];
  warnings: string[];
}

export function parseSkillMd(raw: string): ParsedSkillMd {
  const { meta, body, warnings } = parseFrontmatter(raw);
  const w = [...warnings];
  const name = typeof meta.name === "string" && meta.name.trim() ? meta.name.trim() : null;
  let description = typeof meta.description === "string" ? meta.description.trim() : "";
  if (description.length > MAX_DESCRIPTION_CHARS) {
    w.push(`description truncated to ${MAX_DESCRIPTION_CHARS} characters`);
    description = description.slice(0, MAX_DESCRIPTION_CHARS);
  }
  const metaObj =
    meta.metadata && typeof meta.metadata === "object"
      ? (meta.metadata as Record<string, unknown>)
      : {};
  const tags = normalizeTags(metaObj.tags ?? meta.tags);
  const args: ParsedSkillMd["arguments"] = [];
  if (Array.isArray(meta.arguments)) {
    for (const a of meta.arguments as Array<Record<string, unknown>>) {
      if (a && typeof a.name === "string" && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(a.name)) {
        args.push({
          name: a.name,
          description: typeof a.description === "string" ? a.description : "",
          required: a.required === true,
        });
      }
    }
  }
  const title =
    typeof metaObj.title === "string" && metaObj.title.trim() ? metaObj.title.trim() : null;
  return {
    name,
    title,
    description,
    body: body.replace(/^\s+/, ""),
    tags,
    arguments: args,
    warnings: w,
  };
}

/** First markdown heading, used to infer a name when frontmatter lacks one. */
export function firstHeading(body: string): string | null {
  const m = body.match(/^#{1,3}\s+(.+)$/m);
  return m?.[1]?.trim() ?? null;
}

// ── Relay skill ─────────────────────────────────────────────────────────

export function relaySkillMd(name: string, description: string): string {
  return serializeSkillMd({
    name,
    description,
    tags: [],
    arguments: [],
    body: [
      `This skill is stored in Kebab MCP so it stays identical across all your AI clients.`,
      ``,
      `Before doing anything else, call the \`skill_load\` tool of the Kebab MCP connector with name "${name}" and follow the returned instructions exactly (they replace this text).`,
      `If the skill mentions bundled files, fetch them with \`skill_read_file\`.`,
      `If the Kebab MCP connector is not available in this conversation, tell the user and stop.`,
    ].join("\n"),
  });
}

// ── Zip ─────────────────────────────────────────────────────────────────

export interface ZipSkillInput {
  name: string; // agent name → folder
  skillMd: string;
  files: Record<string, string>;
}

/** Build a zip with one `<name>/` folder per skill (+ optional extra root files). */
export function buildSkillsZip(
  skills: ZipSkillInput[],
  extraRootFiles: Record<string, string> = {}
): Uint8Array {
  const tree: Record<string, Uint8Array> = {};
  for (const s of skills) {
    tree[`${s.name}/SKILL.md`] = strToU8(s.skillMd);
    for (const [p, c] of Object.entries(s.files)) tree[`${s.name}/${p}`] = strToU8(c);
  }
  for (const [p, c] of Object.entries(extraRootFiles)) tree[p] = strToU8(c);
  return zipSync(tree, { level: 6 });
}

export interface ImportedSkill {
  folder: string | null;
  skillMd: string;
  files: Record<string, string>;
  warnings: string[];
}

export type ZipParseResult = { ok: true; skills: ImportedSkill[] } | { ok: false; error: string };

/**
 * Parse an uploaded zip into skills. Accepts:
 *  - a single skill folder zipped with or without its parent folder
 *    (`SKILL.md` at root, or `<name>/SKILL.md`);
 *  - a library zip with several `<name>/SKILL.md` folders (any depth ≤ 3).
 * Guards: compressed size, entry count, inflated size (checked per entry
 * through the filter before inflation).
 */
export function parseSkillsZip(data: Uint8Array): ZipParseResult {
  if (data.byteLength > MAX_ZIP_UPLOAD_BYTES) {
    return { ok: false, error: `Zip too large (limit ${MAX_ZIP_UPLOAD_BYTES} bytes).` };
  }
  let entries = 0;
  let inflated = 0;
  let tooBig = false;
  let unzipped: Unzipped;
  try {
    unzipped = unzipSync(data, {
      filter: (f) => {
        entries += 1;
        inflated += f.originalSize;
        if (entries > MAX_ZIP_ENTRIES || inflated > MAX_ZIP_INFLATED_BYTES) {
          tooBig = true;
          // Throwing (not returning false) aborts fflate's central-directory
          // loop: a tiny zip64 can declare billions of entries.
          throw new Error("zip limits exceeded");
        }
        return !f.name.endsWith("/");
      },
    });
  } catch (err) {
    if (tooBig) {
      return {
        ok: false,
        error: `Zip exceeds limits (${MAX_ZIP_ENTRIES} entries / ${MAX_ZIP_INFLATED_BYTES} bytes inflated).`,
      };
    }
    return { ok: false, error: `Not a valid zip: ${toMsg(err)}` };
  }
  if (tooBig) {
    return {
      ok: false,
      error: `Zip exceeds limits (${MAX_ZIP_ENTRIES} entries / ${MAX_ZIP_INFLATED_BYTES} bytes inflated).`,
    };
  }

  const paths = Object.keys(unzipped).filter(
    (p) => !p.startsWith("__MACOSX/") && !p.split("/").some((s) => s === ".DS_Store")
  );
  const skillRoots = paths
    .filter((p) => /(^|\/)SKILL\.md$/i.test(p) && p.split("/").length <= 4)
    .map((p) => p.slice(0, p.length - "SKILL.md".length));
  if (skillRoots.length === 0) return { ok: false, error: "No SKILL.md found in the zip." };

  // Most specific (longest) root wins for each file.
  const roots = [...new Set(skillRoots)].sort((a, b) => b.length - a.length);
  const skills: ImportedSkill[] = roots.map((root) => ({
    folder: root ? (root.replace(/\/$/, "").split("/").pop() ?? null) : null,
    skillMd: "",
    files: {},
    warnings: [],
  }));

  for (const p of paths) {
    const idx = roots.findIndex((r) => p.startsWith(r));
    if (idx === -1) continue;
    const skill = skills[idx]!;
    const rel = p.slice(roots[idx]!.length);
    const bytes = unzipped[p]!;
    if (/^SKILL\.md$/i.test(rel)) {
      skill.skillMd = strFromU8(bytes);
      continue;
    }
    const safe = normalizeFilePath(rel);
    if (!safe) {
      skill.warnings.push(`skipped unsafe path: ${rel}`);
      continue;
    }
    if (!isTextPath(safe)) {
      skill.warnings.push(`skipped non-text file: ${safe}`);
      continue;
    }
    if (bytes.byteLength > MAX_FILE_BYTES) {
      skill.warnings.push(`skipped ${safe}: larger than ${MAX_FILE_BYTES} bytes`);
      continue;
    }
    skill.files[safe] = strFromU8(bytes);
  }
  return { ok: true, skills };
}
