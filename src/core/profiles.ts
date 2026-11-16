/**
 * Kebab House phase 0 (CTX-02..05) — personal profiles ("hats").
 *
 * The `default` profile is the pre-existing personal context edited in
 * /config → Profile (KV `mymcp:context:inline` + `mymcp:context:mode`).
 * It is read in place — no migration, no rewrite. Additional named
 * profiles (one per "hat": perso, work, …) are inline Markdown stored one
 * key each under `context:profile:<name>` so two writers never
 * race on a shared blob.
 *
 * Profile history (2026-11 audit, C1.2): every save keeps the content it
 * replaces in a capped list (newest first, MAX_PROFILE_HISTORY versions)
 * under `context:profile-history:<name>`. The default profile's "last
 * updated / by" lives under `context:profile-meta:default` (its content
 * stays in the legacy inline key). Restoring a version is a plain save of
 * its content, so a restore can itself be undone.
 *
 * All keys go through `getContextKVStore()` and are therefore tenant-scoped.
 */

import { getContextKVStore } from "./request-context";
import { kvScanAll } from "./kv-store";
import { dualReadKV } from "./migrations/v0.11-tenant-scope";
import { getInstanceConfigAsync } from "./config";

export const DEFAULT_PROFILE = "default";
export const KV_CONTEXT_INLINE = "mymcp:context:inline";
export const KV_CONTEXT_MODE = "mymcp:context:mode";
const KV_PROFILE_PREFIX = "context:profile:";
const KV_PROFILE_HISTORY_PREFIX = "context:profile-history:";
const KV_PROFILE_META_PREFIX = "context:profile-meta:";

/** Same cap as the historical inline context (app/api/config/context). */
export const MAX_PROFILE_BYTES = 64 * 1024;
/** Named profiles, `default` excluded. */
export const MAX_NAMED_PROFILES = 20;
/** Saved versions kept per profile (newest first). */
export const MAX_PROFILE_HISTORY = 10;
const MAX_BY_LABEL = 60;

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export class ProfileError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_name"
      | "too_large"
      | "too_many"
      | "not_found"
      | "reserved"
      | "no_version"
  ) {
    super(message);
    this.name = "ProfileError";
  }
}

export function normalizeProfileName(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidProfileName(name: string): boolean {
  return PROFILE_NAME_RE.test(name);
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

interface StoredProfile {
  content: string;
  updatedAt: string;
  /** Who saved this version (device label, "dashboard", "import"…). */
  by?: string;
}

function parseStored(raw: string | null): StoredProfile | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<StoredProfile>;
    if (typeof v.content !== "string") return null;
    return {
      content: v.content,
      updatedAt: typeof v.updatedAt === "string" ? v.updatedAt : "",
      ...(typeof v.by === "string" && v.by ? { by: v.by } : {}),
    };
  } catch {
    return null;
  }
}

/** Default profile: "last updated / by" (its content is the legacy inline key). */
interface ProfileMeta {
  updatedAt: string;
  by?: string;
}

function parseMeta(raw: string | null): ProfileMeta | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<ProfileMeta>;
    if (typeof v.updatedAt !== "string") return null;
    return { updatedAt: v.updatedAt, ...(typeof v.by === "string" && v.by ? { by: v.by } : {}) };
  } catch {
    return null;
  }
}

/** One saved version of a profile, as kept in its history. */
export interface ProfileHistoryEntry {
  /** When this version was saved (when unknown: when it was replaced). */
  savedAt: string;
  /** When a newer save replaced it. */
  replacedAt: string;
  bytes: number;
  content: string;
  /** Who saved this version, when known. */
  by?: string;
}

function parseHistory(raw: string | null): ProfileHistoryEntry[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter(
      (e): e is ProfileHistoryEntry =>
        !!e &&
        typeof e === "object" &&
        typeof (e as ProfileHistoryEntry).content === "string" &&
        typeof (e as ProfileHistoryEntry).savedAt === "string"
    );
  } catch {
    return [];
  }
}

function cleanBy(raw: string | null | undefined): string | undefined {
  const v = (raw ?? "").replace(/\s+/g, " ").trim();
  return v ? v.slice(0, MAX_BY_LABEL) : undefined;
}

/**
 * Label of the MCP client making the current call, when there is one (the
 * device label the transport puts in the caller meta). Lazy import keeps
 * token-scope (and the registry it imports) off this module's graph.
 */
async function callerLabel(): Promise<string | undefined> {
  try {
    const { getCallerMeta } = await import("./token-scope");
    const meta = getCallerMeta();
    // Same naming as the usage counters: device label, else the token id.
    return cleanBy(meta?.label ?? (meta?.tokenId ? `AI client ${meta.tokenId}` : null));
  } catch {
    return undefined;
  }
}

export interface ProfileSummary {
  name: string;
  /** `inline` for every named profile; `default` may be `vault`. */
  mode: "inline" | "vault";
  bytes: number;
  updatedAt: string | null;
  /** Who saved the current version, when known. */
  by?: string;
}

/** Mode of the default profile, with the same inference as /api/config/context. */
export async function getDefaultProfileMode(): Promise<"inline" | "vault"> {
  const kv = getContextKVStore();
  const [storedMode, cfg] = await Promise.all([
    dualReadKV(kv, KV_CONTEXT_MODE, KV_CONTEXT_MODE),
    getInstanceConfigAsync(),
  ]);
  if (storedMode === "vault" || storedMode === "inline") return storedMode;
  const hasVaultPath = !!cfg.contextPath && cfg.contextPath !== "System/context.md";
  return hasVaultPath ? "vault" : "inline";
}

async function readDefaultInline(): Promise<string> {
  const kv = getContextKVStore();
  return (await dualReadKV(kv, KV_CONTEXT_INLINE, KV_CONTEXT_INLINE)) ?? "";
}

async function readDefaultMeta(): Promise<ProfileMeta | null> {
  return parseMeta(await getContextKVStore().get(`${KV_PROFILE_META_PREFIX}${DEFAULT_PROFILE}`));
}

/** Names of the named profiles (sorted), `default` excluded. */
export async function listNamedProfiles(): Promise<string[]> {
  const kv = getContextKVStore();
  const keys = await kvScanAll(kv, `${KV_PROFILE_PREFIX}*`);
  return keys
    .map((k) => k.slice(k.lastIndexOf(KV_PROFILE_PREFIX) + KV_PROFILE_PREFIX.length))
    .filter((n) => isValidProfileName(n))
    .sort();
}

export async function listProfiles(): Promise<ProfileSummary[]> {
  const kv = getContextKVStore();
  const [mode, inline, names, meta] = await Promise.all([
    getDefaultProfileMode(),
    readDefaultInline(),
    listNamedProfiles(),
    readDefaultMeta(),
  ]);
  const out: ProfileSummary[] = [
    {
      name: DEFAULT_PROFILE,
      mode,
      bytes: byteLength(inline),
      updatedAt: meta?.updatedAt ?? null,
      ...(meta?.by ? { by: meta.by } : {}),
    },
  ];
  const stored = await Promise.all(names.map((n) => kv.get(`${KV_PROFILE_PREFIX}${n}`)));
  names.forEach((name, i) => {
    const p = parseStored(stored[i] ?? null);
    if (!p) return;
    out.push({
      name,
      mode: "inline",
      bytes: byteLength(p.content),
      updatedAt: p.updatedAt || null,
      ...(p.by ? { by: p.by } : {}),
    });
  });
  return out;
}

/**
 * Inline content of a profile. `null` when the named profile does not
 * exist. For `default` in vault mode this returns the (possibly empty)
 * inline value — vault resolution is the caller's job (see my_context).
 */
export async function getProfileContent(name: string): Promise<string | null> {
  const n = normalizeProfileName(name);
  if (n === DEFAULT_PROFILE) return readDefaultInline();
  if (!isValidProfileName(n)) return null;
  const p = parseStored(await getContextKVStore().get(`${KV_PROFILE_PREFIX}${n}`));
  return p ? p.content : null;
}

export async function profileExists(name: string): Promise<boolean> {
  const n = normalizeProfileName(name);
  if (n === DEFAULT_PROFILE) return true;
  return (await getProfileContent(n)) !== null;
}

/** Optional details recorded with a save. */
export interface SaveProfileMeta {
  /** Who is saving (shown in the history). Defaults to the calling MCP client's label. */
  by?: string | undefined;
}

/**
 * Create or replace a profile's inline content. Writing `default` writes
 * the historical inline key and switches the default profile to inline
 * mode (same effect as saving inline in /config → Profile).
 *
 * The content being replaced goes into the profile's history (newest
 * first, at most MAX_PROFILE_HISTORY versions). Saving identical content,
 * or replacing an empty profile, records nothing.
 */
export async function saveProfile(
  name: string,
  content: string,
  meta?: SaveProfileMeta
): Promise<void> {
  const n = normalizeProfileName(name);
  if (n !== DEFAULT_PROFILE && !isValidProfileName(n)) {
    throw new ProfileError(
      "Profile names use lowercase letters, digits and dashes (max 40 characters).",
      "invalid_name"
    );
  }
  if (byteLength(content) > MAX_PROFILE_BYTES) {
    throw new ProfileError(`Profile too large (max ${MAX_PROFILE_BYTES / 1024} KB).`, "too_large");
  }
  const kv = getContextKVStore();
  const now = new Date().toISOString();
  const by = cleanBy(meta?.by) ?? (await callerLabel());

  if (n === DEFAULT_PROFILE) {
    const [previous, prevMeta] = await Promise.all([readDefaultInline(), readDefaultMeta()]);
    if (previous && previous !== content) {
      await pushHistory(n, previous, prevMeta?.updatedAt || now, prevMeta?.by, now);
    }
    await kv.set(KV_CONTEXT_INLINE, content);
    await kv.set(KV_CONTEXT_MODE, "inline");
    const nextMeta: ProfileMeta = { updatedAt: now, ...(by ? { by } : {}) };
    await kv.set(`${KV_PROFILE_META_PREFIX}${DEFAULT_PROFILE}`, JSON.stringify(nextMeta));
    return;
  }
  const key = `${KV_PROFILE_PREFIX}${n}`;
  const previous = parseStored(await kv.get(key));
  if (!previous) {
    const existing = await listNamedProfiles();
    if (existing.length >= MAX_NAMED_PROFILES) {
      throw new ProfileError(`At most ${MAX_NAMED_PROFILES} named profiles.`, "too_many");
    }
  } else if (previous.content && previous.content !== content) {
    await pushHistory(n, previous.content, previous.updatedAt || now, previous.by, now);
  }
  const stored: StoredProfile = { content, updatedAt: now, ...(by ? { by } : {}) };
  await kv.set(key, JSON.stringify(stored));
}

async function pushHistory(
  name: string,
  content: string,
  savedAt: string,
  by: string | undefined,
  replacedAt: string
): Promise<void> {
  const kv = getContextKVStore();
  const key = `${KV_PROFILE_HISTORY_PREFIX}${name}`;
  const entry: ProfileHistoryEntry = {
    savedAt,
    replacedAt,
    bytes: byteLength(content),
    content,
    ...(by ? { by } : {}),
  };
  const next = [entry, ...parseHistory(await kv.get(key))].slice(0, MAX_PROFILE_HISTORY);
  await kv.set(key, JSON.stringify(next));
}

/** Saved versions of a profile, newest first (at most MAX_PROFILE_HISTORY). */
export async function listProfileHistory(name: string): Promise<ProfileHistoryEntry[]> {
  const n = normalizeProfileName(name);
  if (n !== DEFAULT_PROFILE && !isValidProfileName(n)) return [];
  return parseHistory(await getContextKVStore().get(`${KV_PROFILE_HISTORY_PREFIX}${n}`));
}

/**
 * Restore version `index` (0 = newest) of a profile's history. A restore is
 * a regular save: the content it replaces goes into the history in turn.
 */
export async function restoreProfileVersion(
  name: string,
  index: number,
  meta?: SaveProfileMeta
): Promise<ProfileHistoryEntry> {
  const history = await listProfileHistory(name);
  const entry = Number.isInteger(index) && index >= 0 ? history[index] : undefined;
  if (!entry) throw new ProfileError("This version no longer exists.", "no_version");
  await saveProfile(name, entry.content, meta);
  return entry;
}

export async function deleteProfile(name: string): Promise<void> {
  const n = normalizeProfileName(name);
  if (n === DEFAULT_PROFILE) {
    throw new ProfileError("The default profile cannot be deleted.", "reserved");
  }
  if (!isValidProfileName(n)) throw new ProfileError("Unknown profile.", "not_found");
  const kv = getContextKVStore();
  await kv.delete(`${KV_PROFILE_PREFIX}${n}`);
  await kv.delete(`${KV_PROFILE_HISTORY_PREFIX}${n}`);
}
