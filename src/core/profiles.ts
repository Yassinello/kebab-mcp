/**
 * Kebab House phase 0 (CTX-02..05) — personal profiles ("hats").
 *
 * The `default` profile is the pre-existing personal context edited in
 * /config → Settings (KV `mymcp:context:inline` + `mymcp:context:mode`).
 * It is read in place — no migration, no rewrite. Additional named
 * profiles (one per "hat": perso, work, …) are inline Markdown stored one
 * key each under `context:profile:<name>` so two writers never
 * race on a shared blob.
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

/** Same cap as the historical inline context (app/api/config/context). */
export const MAX_PROFILE_BYTES = 64 * 1024;
/** Named profiles, `default` excluded. */
export const MAX_NAMED_PROFILES = 20;

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export class ProfileError extends Error {
  constructor(
    message: string,
    readonly code: "invalid_name" | "too_large" | "too_many" | "not_found" | "reserved"
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
}

function parseStored(raw: string | null): StoredProfile | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<StoredProfile>;
    if (typeof v.content !== "string") return null;
    return { content: v.content, updatedAt: typeof v.updatedAt === "string" ? v.updatedAt : "" };
  } catch {
    return null;
  }
}

export interface ProfileSummary {
  name: string;
  /** `inline` for every named profile; `default` may be `vault`. */
  mode: "inline" | "vault";
  bytes: number;
  updatedAt: string | null;
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
  const [mode, inline, names] = await Promise.all([
    getDefaultProfileMode(),
    readDefaultInline(),
    listNamedProfiles(),
  ]);
  const out: ProfileSummary[] = [
    { name: DEFAULT_PROFILE, mode, bytes: byteLength(inline), updatedAt: null },
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

/**
 * Create or replace a profile's inline content. Writing `default` writes
 * the historical inline key and switches the default profile to inline
 * mode (same effect as saving inline in /config → Settings).
 */
export async function saveProfile(name: string, content: string): Promise<void> {
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
  if (n === DEFAULT_PROFILE) {
    await kv.set(KV_CONTEXT_INLINE, content);
    await kv.set(KV_CONTEXT_MODE, "inline");
    return;
  }
  const key = `${KV_PROFILE_PREFIX}${n}`;
  if (!(await kv.get(key))) {
    const existing = await listNamedProfiles();
    if (existing.length >= MAX_NAMED_PROFILES) {
      throw new ProfileError(`At most ${MAX_NAMED_PROFILES} named profiles.`, "too_many");
    }
  }
  const stored: StoredProfile = { content, updatedAt: new Date().toISOString() };
  await kv.set(key, JSON.stringify(stored));
}

export async function deleteProfile(name: string): Promise<void> {
  const n = normalizeProfileName(name);
  if (n === DEFAULT_PROFILE) {
    throw new ProfileError("The default profile cannot be deleted.", "reserved");
  }
  if (!isValidProfileName(n)) throw new ProfileError("Unknown profile.", "not_found");
  await getContextKVStore().delete(`${KV_PROFILE_PREFIX}${n}`);
}
