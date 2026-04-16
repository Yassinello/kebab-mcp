import { promises as fs, readFileSync, existsSync } from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { z } from "zod";
import { getKVStore } from "@/core/kv-store";

/**
 * Skills store — persists user-authored skills.
 *
 * Storage backends:
 * - Legacy: if MYMCP_SKILLS_PATH is set, reads/writes a JSON file at that path
 *   (atomic tmp+rename). Preserves existing installs on upgrade.
 * - Default: uses the shared KVStore under key "skills:all" (JSON-serialized array).
 *   KVStore resolves to filesystem locally and Upstash on Vercel when configured.
 */

const KV_KEY = "skills:all";

export const skillArgumentSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "arg name must be a valid identifier"),
  description: z.string().optional().default(""),
  required: z.boolean().optional().default(false),
});

export const skillSourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("inline"),
  }),
  z.object({
    type: z.literal("remote"),
    url: z.string().url(),
    cachedContent: z.string().optional(),
    cachedAt: z.string().optional(),
    lastError: z.string().optional(),
  }),
]);

export const skillSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9_]+$/, "id must be slug-safe: [a-z0-9_]"),
  name: z.string().min(1),
  description: z.string().default(""),
  content: z.string().default(""),
  arguments: z.array(skillArgumentSchema).default([]),
  source: skillSourceSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type SkillArgument = z.infer<typeof skillArgumentSchema>;
export type SkillSource = z.infer<typeof skillSourceSchema>;
export type Skill = z.infer<typeof skillSchema>;

export const skillCreateInputSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).default(""),
  content: z.string().default(""),
  arguments: z.array(skillArgumentSchema).default([]),
  source: skillSourceSchema,
});

export const skillUpdateInputSchema = skillCreateInputSchema.partial();

export type SkillCreateInput = z.infer<typeof skillCreateInputSchema>;
export type SkillUpdateInput = z.infer<typeof skillUpdateInputSchema>;

// ── Storage backend selection ───────────────────────────────────────────

/** Legacy filesystem path override. When set, bypasses KVStore. */
function getLegacySkillsPath(): string | null {
  const override = process.env.MYMCP_SKILLS_PATH?.trim();
  return override ? path.resolve(override) : null;
}

async function ensureDir(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

function parseSkillsJson(buf: string): Skill[] {
  try {
    const parsed = JSON.parse(buf);
    if (!Array.isArray(parsed)) return [];
    const out: Skill[] = [];
    for (const row of parsed) {
      const res = skillSchema.safeParse(row);
      if (res.success) out.push(res.data);
    }
    return out;
  } catch {
    return [];
  }
}

// ── Slug generation ─────────────────────────────────────────────────────

export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return base || `skill_${randomBytes(3).toString("hex")}`;
}

async function uniqueId(base: string, existing: Set<string>): Promise<string> {
  if (!existing.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}_${i}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${base}_${randomBytes(3).toString("hex")}`;
}

// ── Raw I/O — routes to KV or legacy file path ──────────────────────────

async function readRaw(): Promise<Skill[]> {
  const legacy = getLegacySkillsPath();
  if (legacy) {
    try {
      const buf = await fs.readFile(legacy, "utf-8");
      return parseSkillsJson(buf);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }
  const kv = getKVStore();
  const raw = await kv.get(KV_KEY);
  if (!raw) return [];
  return parseSkillsJson(raw);
}

async function writeRaw(skills: Skill[]): Promise<void> {
  const legacy = getLegacySkillsPath();
  if (legacy) {
    await ensureDir(legacy);
    const tmp = `${legacy}.${randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(skills, null, 2), "utf-8");
    await fs.rename(tmp, legacy);
    return;
  }
  const kv = getKVStore();
  await kv.set(KV_KEY, JSON.stringify(skills));
}

// ── Write mutex ─────────────────────────────────────────────────────────
// Serialize all mutating operations to avoid lost-update races when the
// read-modify-write cycle of two callers interleaves.
let writeQueue: Promise<void> = Promise.resolve();
function enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(() => fn());
  writeQueue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

// ── Public API ──────────────────────────────────────────────────────────

export async function listSkills(): Promise<Skill[]> {
  return readRaw();
}

/** Synchronous snapshot — used by the pack manifest at registry scan time.
 *
 * For the KV filesystem backend we read the underlying JSON file synchronously.
 * For Upstash (or any non-filesystem backend) sync reads are impossible —
 * callers should fall back to the async `listSkills()` API. */
export function listSkillsSync(): Skill[] {
  const legacy = getLegacySkillsPath();
  const filePath =
    legacy ??
    (process.env.UPSTASH_REDIS_REST_URL ? null : path.resolve(process.cwd(), "data", "kv.json"));
  if (!filePath) return [];
  try {
    if (!existsSync(filePath)) return [];
    const buf = readFileSync(filePath, "utf-8");
    if (legacy) {
      return parseSkillsJson(buf);
    }
    // KV filesystem format: { "skills:all": "<json string>" }
    const map = JSON.parse(buf);
    if (!map || typeof map !== "object" || !(KV_KEY in map)) return [];
    const raw = (map as Record<string, string>)[KV_KEY];
    if (typeof raw !== "string") return [];
    return parseSkillsJson(raw);
  } catch {
    return [];
  }
}

export async function getSkill(id: string): Promise<Skill | null> {
  const all = await readRaw();
  return all.find((s) => s.id === id) ?? null;
}

export function createSkill(input: SkillCreateInput): Promise<Skill> {
  return enqueueWrite(async () => {
    const parsed = skillCreateInputSchema.parse(input);
    const all = await readRaw();
    const existingIds = new Set(all.map((s) => s.id));
    const id = await uniqueId(slugify(parsed.name), existingIds);
    const now = new Date().toISOString();
    const skill: Skill = {
      id,
      name: parsed.name,
      description: parsed.description ?? "",
      content: parsed.content ?? "",
      arguments: parsed.arguments ?? [],
      source: parsed.source,
      createdAt: now,
      updatedAt: now,
    };
    all.push(skill);
    await writeRaw(all);
    return skill;
  });
}

export function updateSkill(id: string, patch: SkillUpdateInput): Promise<Skill | null> {
  return enqueueWrite(async () => {
    const parsed = skillUpdateInputSchema.parse(patch);
    const all = await readRaw();
    const idx = all.findIndex((s) => s.id === id);
    if (idx === -1) return null;
    const prev = all[idx];
    const next: Skill = {
      ...prev,
      ...parsed,
      id: prev.id,
      createdAt: prev.createdAt,
      updatedAt: new Date().toISOString(),
      // preserve or update source carefully
      source: parsed.source ?? prev.source,
      arguments: parsed.arguments ?? prev.arguments,
    };
    all[idx] = next;
    await writeRaw(all);
    return next;
  });
}

export function deleteSkill(id: string): Promise<boolean> {
  return enqueueWrite(async () => {
    const all = await readRaw();
    const next = all.filter((s) => s.id !== id);
    if (next.length === all.length) return false;
    await writeRaw(next);
    return true;
  });
}

/** Replace a skill wholesale (used by refresh-cache write path). */
export function replaceSkill(skill: Skill): Promise<void> {
  return enqueueWrite(async () => {
    const all = await readRaw();
    const idx = all.findIndex((s) => s.id === skill.id);
    if (idx === -1) return;
    all[idx] = skill;
    await writeRaw(all);
  });
}

// ── Skill versioning ──────────────────────────────────────────────────
//
// Storage model:
// - `skill:<id>:meta` — JSON { currentVersion: N }
// - `skill:<id>:v<N>` — JSON snapshot { content, savedAt }
//
// On every create/update, the version is incremented and stored.

interface SkillVersionEntry {
  version: number;
  content: string;
  name: string;
  description: string;
  savedAt: string;
}

interface SkillVersionMeta {
  currentVersion: number;
}

function versionMetaKey(skillId: string): string {
  return `skill:${skillId}:meta`;
}

function versionKey(skillId: string, version: number): string {
  return `skill:${skillId}:v${version}`;
}

async function getVersionMeta(skillId: string): Promise<SkillVersionMeta | null> {
  const kv = getKVStore();
  const raw = await kv.get(versionMetaKey(skillId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SkillVersionMeta;
  } catch {
    return null;
  }
}

async function saveVersion(skill: Skill): Promise<number> {
  const kv = getKVStore();
  const meta = await getVersionMeta(skill.id);
  const nextVersion = (meta?.currentVersion ?? 0) + 1;
  const entry: SkillVersionEntry = {
    version: nextVersion,
    content: skill.content,
    name: skill.name,
    description: skill.description,
    savedAt: new Date().toISOString(),
  };
  await kv.set(versionKey(skill.id, nextVersion), JSON.stringify(entry));
  await kv.set(versionMetaKey(skill.id), JSON.stringify({ currentVersion: nextVersion }));
  return nextVersion;
}

/** List all version numbers for a skill, sorted ascending. */
export async function listSkillVersions(skillId: string): Promise<number[]> {
  const kv = getKVStore();
  const prefix = `skill:${skillId}:v`;
  const keys = await kv.list(prefix);
  const versions: number[] = [];
  for (const k of keys) {
    const suffix = k.slice(prefix.length);
    const n = parseInt(suffix, 10);
    if (Number.isFinite(n)) versions.push(n);
  }
  return versions.sort((a, b) => a - b);
}

/** Get a specific version of a skill. */
export async function getSkillVersion(
  skillId: string,
  version: number
): Promise<SkillVersionEntry | null> {
  const kv = getKVStore();
  const raw = await kv.get(versionKey(skillId, version));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SkillVersionEntry;
  } catch {
    return null;
  }
}

/** Get the current version number for a skill. */
export async function getSkillCurrentVersion(skillId: string): Promise<number> {
  const meta = await getVersionMeta(skillId);
  return meta?.currentVersion ?? 0;
}

/**
 * Rollback a skill to a previous version. Creates a new version (N+1)
 * with the old content, so the history is always append-only.
 */
export function rollbackSkill(skillId: string, version: number): Promise<Skill | null> {
  return enqueueWrite(async () => {
    const all = await readRaw();
    const idx = all.findIndex((s) => s.id === skillId);
    if (idx === -1) return null;

    const entry = await getSkillVersion(skillId, version);
    if (!entry) return null;

    const prev = all[idx];
    const now = new Date().toISOString();
    const updated: Skill = {
      ...prev,
      content: entry.content,
      name: entry.name,
      description: entry.description,
      updatedAt: now,
    };
    all[idx] = updated;
    await writeRaw(all);
    await saveVersion(updated);
    return updated;
  });
}

// Patch createSkill and updateSkill to auto-version
const _originalCreateSkill = createSkill;

/**
 * Wrapped createSkill that also saves the first version.
 */
export async function createSkillVersioned(input: SkillCreateInput): Promise<Skill> {
  const skill = await _originalCreateSkill(input);
  await saveVersion(skill);
  return skill;
}

/**
 * Wrapped updateSkill that also saves a new version.
 */
export async function updateSkillVersioned(
  id: string,
  patch: SkillUpdateInput
): Promise<Skill | null> {
  const result = await updateSkill(id, patch);
  if (result) await saveVersion(result);
  return result;
}
