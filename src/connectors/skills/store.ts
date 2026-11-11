import { promises as fs, readFileSync, existsSync } from "fs";
import { bumpConfigRevision } from "@/core/config-revision";
import path from "path";
import { randomBytes } from "crypto";
import { z } from "zod";
import { kvScanAll } from "@/core/kv-store";
import { getContextKVStore, getCurrentTenantId } from "@/core/request-context";
import { hasUpstashCreds } from "@/core/upstash-env";
import { getLogger } from "@/core/logging";
import { getConfig } from "@/core/config-facade";
import { toMsg } from "@/core/error-utils";

const skillsLog = getLogger("CONNECTOR:skills");

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

/**
 * Per-target sync state. Tracks whether a skill has been pushed to a
 * configured local path (e.g. Claude Code skills dir).
 */
export const skillSyncStateSchema = z.object({
  target: z.string(),
  lastSyncedHash: z.string(),
  lastSyncedAt: z.string(),
  lastSyncStatus: z.enum(["ok", "error"]),
  lastSyncError: z.string().optional(),
});

export type SkillSyncState = z.infer<typeof skillSyncStateSchema>;

export const skillSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9_]+$/, "id must be slug-safe: [a-z0-9_]"),
  name: z.string().min(1),
  description: z.string().default(""),
  content: z.string().default(""),
  arguments: z.array(skillArgumentSchema).default([]),
  /** Governance: explicit list of tool names this skill is allowed to invoke. */
  toolsAllowed: z.array(z.string()).default([]),
  source: skillSourceSchema,
  /** Per-target sync state. Keyed by target name. */
  syncState: z.record(z.string(), skillSyncStateSchema).default({}),
  /** Spec v2 — profile tags (lower-case slugs). Drive per-token visibility. */
  tags: z.array(z.string()).default([]),
  /**
   * Spec v2 — index of bundled files (bodies live under `skill:<id>:files`
   * so the hot `skills:all` record stays small).
   */
  files: z.array(z.object({ path: z.string(), size: z.number() })).default([]),
  /**
   * Spec v2 — expose a dedicated `skill_<id>` tool. Defaults to TRUE when
   * absent so skills created before v2 keep their tool; createSkill sets
   * false for new skills (they are reached through `skill_load`).
   */
  exposeAsTool: z.boolean().default(true),
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
  toolsAllowed: z.array(z.string()).default([]),
  source: skillSourceSchema,
  tags: z.array(z.string()).optional(),
  exposeAsTool: z.boolean().optional(),
  /** Spec v2 — preferred id (import round-trips). Uniquified if taken. */
  id: z
    .string()
    .regex(/^[a-z0-9_]+$/)
    .max(64)
    .optional(),
});

export const skillUpdateInputSchema = skillCreateInputSchema.omit({ id: true }).partial();

// Authored input type (what callers pass into createSkill / updateSkill).
// `toolsAllowed` is optional on input — defaults to [] after parse.
export type SkillCreateInput = z.input<typeof skillCreateInputSchema>;
export type SkillUpdateInput = z.input<typeof skillUpdateInputSchema>;

// ── Storage backend selection ───────────────────────────────────────────

/** Legacy filesystem path override. When set, bypasses KVStore. */
function getLegacySkillsPath(): string | null {
  const override = getConfig("KEBAB_SKILLS_PATH")?.trim();
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
  const kv = getContextKVStore();
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
  } else {
    const kv = getContextKVStore();
    await kv.set(KV_KEY, JSON.stringify(skills));
  }
  // Keep the sync cache in lock-step so the MCP transport picks up
  // newly-created/edited skills on the next tools iteration in this
  // lambda — without waiting for the next `primeSkillsCache()` roundtrip.
  _skillsCache.set(cacheKey(), skills);
  // REL-02: other lambdas re-prime.
  await bumpConfigRevision();
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

// Async-primed cache for the sync getter.
//
// The pack's `tools` getter is synchronous (driven by the MCP SDK's
// registration pattern), but on Upstash the underlying store is async.
// `listSkillsSync` therefore reads either:
//   1. The warm cache populated by `primeSkillsCache()`, if it's been
//      called at least once on this lambda — OR
//   2. The filesystem KV dump on disk (dev + Vercel without Upstash).
//
// Without the async primer, Upstash deploys would expose 0 skills to MCP
// clients on cold lambdas until /api/admin/status (which calls `diagnose()`)
// happened to fire first. The ConnectorManifest.refresh hook in the
// transport primes this cache before iterating `tools`.
// Keyed by tenant: a process-wide single value let one tenant's skills be
// served to another tenant's MCP request within the prime window.
const ROOT_TENANT = "__root__";
const _skillsCache = new Map<string, Skill[]>();

function cacheKey(): string {
  try {
    return getCurrentTenantId() ?? ROOT_TENANT;
  } catch {
    return ROOT_TENANT;
  }
}

/**
 * Populate the sync cache from the authoritative async store. Called by
 * the `refresh` manifest hook before the MCP transport iterates `tools`.
 * Idempotent; safe to call from any request frame.
 */
export async function primeSkillsCache(): Promise<void> {
  try {
    _skillsCache.set(cacheKey(), await readRaw());
  } catch (err) {
    // Q-01: keep the last good snapshot on transient failures.
    console.error(`[Kebab MCP] skills cache refresh failed: ${toMsg(err)}`);
    if (!_skillsCache.has(cacheKey())) _skillsCache.set(cacheKey(), []);
  }
}

/** Reset the sync cache. Exposed for tests — prevents cross-test bleed. */
export function _resetSkillsCacheForTests(): void {
  _skillsCache.clear();
}

/** Synchronous snapshot — used by the pack manifest at registry scan time.
 *
 * Resolution order:
 *   1. If `primeSkillsCache()` has run on this lambda, return its snapshot.
 *   2. Else for the KV filesystem backend (dev), read the underlying JSON
 *      file synchronously.
 *   3. Else (Upstash without a warm cache), return [] — callers that need
 *      a guaranteed fresh read must use the async `listSkills()` API. */
export function listSkillsSync(): Skill[] {
  const key = cacheKey();
  const cached = _skillsCache.get(key);
  if (cached) return cached;
  // The on-disk fallback below reads the ROOT tenant's record only; never
  // serve it to another tenant.
  if (key !== ROOT_TENANT) return [];
  const legacy = getLegacySkillsPath();
  const filePath =
    legacy ?? (hasUpstashCreds() ? null : path.resolve(process.cwd(), "data", "kv.json"));
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
  } catch (err) {
    // P1 fold-in (Phase 38): the pre-v0.10 behavior silently returned []
    // on any read/parse error. Now logs via the structured logger so a
    // misconfigured skills store surfaces in logs instead of being
    // invisible (which hid a bug during the 2026-04-20 session).
    skillsLog.warn("listSkillsSync fell back to empty list", {
      error: toMsg(err),
      filePath,
    });
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
    // `load` / `read_file` are reserved: their legacy tool names would
    // collide with the library tools skill_load / skill_read_file.
    const existingIds = new Set([...all.map((s) => s.id), "load", "read_file"]);
    const id = await uniqueId(parsed.id ?? slugify(parsed.name), existingIds);
    const now = new Date().toISOString();
    const skill: Skill = {
      id,
      name: parsed.name,
      description: parsed.description ?? "",
      content: parsed.content ?? "",
      arguments: parsed.arguments ?? [],
      toolsAllowed: parsed.toolsAllowed ?? [],
      source: parsed.source,
      syncState: {},
      tags: normalizeTags(parsed.tags ?? []),
      files: [],
      exposeAsTool: parsed.exposeAsTool ?? false,
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
    if (!prev) return null;
    // Phase 49 / exactOptionalPropertyTypes: spread `parsed` selectively —
    // parsed has optional fields as `T | undefined`, but Skill has them as
    // required strings. Use `??` to keep the previous value when parsed's
    // field is undefined.
    const next: Skill = {
      ...prev,
      id: prev.id,
      createdAt: prev.createdAt,
      updatedAt: new Date().toISOString(),
      name: parsed.name ?? prev.name,
      description: parsed.description ?? prev.description,
      content: parsed.content ?? prev.content,
      source: parsed.source ?? prev.source,
      arguments: parsed.arguments ?? prev.arguments,
      toolsAllowed: parsed.toolsAllowed ?? prev.toolsAllowed ?? [],
      syncState: prev.syncState ?? {},
      tags: parsed.tags !== undefined ? normalizeTags(parsed.tags) : (prev.tags ?? []),
      files: prev.files ?? [],
      exposeAsTool: parsed.exposeAsTool ?? prev.exposeAsTool ?? true,
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

    // Clean up all versioning keys for this skill
    const kv = getContextKVStore();
    const keys = await kvScanAll(kv, `skill:${id}:*`);
    await Promise.all(keys.map((k) => kv.delete(k)));

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

// ── Bundled files (spec v2) ─────────────────────────────────────────
//
// Bodies are stored under `skill:<id>:files` (one JSON map per skill). The
// `skill:<id>:*` prefix is already wiped by deleteSkill, and does not match
// the version scan (`skill:<id>:v*`). The skill record keeps only the index.

function filesKey(skillId: string): string {
  return `skill:${skillId}:files`;
}

/** All bundled files of a skill (path → UTF-8 content). */
export async function getSkillFiles(skillId: string): Promise<Record<string, string>> {
  const raw = await getContextKVStore().get(filesKey(skillId));
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Replace a skill's bundled files wholesale (validated: paths, count, sizes).
 * Returns the updated skill, or `{error}` on validation failure / unknown id.
 */
export function setSkillFiles(
  skillId: string,
  files: Record<string, string>
): Promise<Skill | { error: string }> {
  return enqueueWrite(async () => {
    const v = validateFiles(files);
    if (!v.ok) return { error: v.error };
    const all = await readRaw();
    const idx = all.findIndex((s) => s.id === skillId);
    const prev = idx === -1 ? undefined : all[idx];
    if (!prev) return { error: "skill_not_found" };
    const kv = getContextKVStore();
    const paths = Object.keys(v.files).sort();
    if (paths.length === 0) await kv.delete(filesKey(skillId));
    else await kv.set(filesKey(skillId), JSON.stringify(v.files));
    const next: Skill = {
      ...prev,
      files: paths.map((p) => ({ path: p, size: byteLength(v.files[p]!) })),
      updatedAt: new Date().toISOString(),
    };
    all[idx] = next;
    await writeRaw(all);
    return next;
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
  const kv = getContextKVStore();
  const raw = await kv.get(versionMetaKey(skillId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SkillVersionMeta;
  } catch {
    return null;
  }
}

async function saveVersion(skill: Skill): Promise<number> {
  const kv = getContextKVStore();
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

/** List all version numbers for a skill, sorted ascending.
 *
 * **Caveat**: KVStore.list() uses the Redis KEYS command on Upstash,
 * which is O(N) over all keys and blocks the server. For low-volume
 * usage (dashboard UI) this is acceptable, but a SCAN-based
 * implementation should replace it if skill count grows significantly.
 */
export async function listSkillVersions(skillId: string): Promise<number[]> {
  const kv = getContextKVStore();
  const prefix = `skill:${skillId}:v`;
  const keys = await kvScanAll(kv, `${prefix}*`);
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
  const kv = getContextKVStore();
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
    if (!prev) return null;
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

// ── Sync state helpers ────────────────────────────────────────────────
//
// Each skill tracks `syncState[target] = { lastSyncedHash, lastSyncedAt, ...}`.
// Drift is detected by comparing the current content hash against
// lastSyncedHash for a given target.

import { createHash } from "crypto";
import { byteLength, normalizeTags, validateFiles } from "./lib/bundle";

/** Stable content hash used to detect drift. sha256(name + description + content). */
export function computeSkillContentHash(
  skill: Pick<Skill, "name" | "description" | "content">
): string {
  const h = createHash("sha256");
  h.update(skill.name);
  h.update("\x1f");
  h.update(skill.description);
  h.update("\x1f");
  h.update(skill.content);
  return h.digest("hex");
}

/** Persist the sync outcome for a given target on a skill. */
export function recordSkillSyncState(id: string, state: SkillSyncState): Promise<Skill | null> {
  return enqueueWrite(async () => {
    const all = await readRaw();
    const idx = all.findIndex((s) => s.id === id);
    if (idx === -1) return null;
    const prev = all[idx];
    if (!prev) return null;
    const next: Skill = {
      ...prev,
      syncState: {
        ...(prev.syncState ?? {}),
        [state.target]: state,
      },
    };
    all[idx] = next;
    await writeRaw(all);
    return next;
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
