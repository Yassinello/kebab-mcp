/**
 * Phase 52 / DEV-02 — Device management KV helpers.
 *
 * Each token in `MCP_AUTH_TOKEN`'s comma-list is a "device". Labels +
 * createdAt persist to `tenant:<id>:devices:<tokenId(8hex)>` in the
 * tenant-scoped KV store. The raw token string is NEVER stored in KV —
 * it only lives in the env var (single source of truth).
 *
 * Exports:
 *   - listDevices()              — enumerate current devices
 *   - setDeviceLabel(id, label)  — rename (validated)
 *   - deleteDevice(id, token)    — revoke (env + KV + rate-limit buckets)
 *   - rotateDeviceToken(id)      — mint fresh token, splice into env list
 *   - getLastSeenAt(token)       — scan rate-limit buckets for activity
 *   - clearDeviceRateLimit(tok)  — best-effort bucket cleanup
 *
 * KV schema:
 *   devices:<tokenId>           → { label: string, createdAt: ISO, connectors?: string[] }
 *   devices:invite:<nonce>      → { consumedAt: ISO, label: string }  (24h TTL)
 *
 * `connectors` (v0.20) is an OPTIONAL per-token connector allowlist. Absent
 * (or corrupt) = no scope = full access (opt-in, fail-open). See
 * src/core/token-scope.ts for how it is resolved + enforced at request time.
 *
 * Reads go through `getContextKVStore()` so tenant isolation is
 * automatic. Writes to `MCP_AUTH_TOKEN` route through the Phase 48
 * env-store facade via `getEnvStore().write()`.
 *
 * See `.planning/phases/52-devices-tab/EVIDENCE.md` for the full schema
 * + read/write-path rationale.
 */

import { createHash, randomBytes } from "node:crypto";
import { getContextKVStore } from "./request-context";
import { getConfig } from "./config-facade";
import { getEnvStore } from "./env-store";
import { parseTokens, tokenId } from "./auth";
import { kvScanAll } from "./kv-store";
import { getKnownConnectorIds } from "./registry";

export interface DeviceRow {
  tokenId: string;
  label: string;
  createdAt: string;
  lastSeenAt: string | null;
  /**
   * Per-token connector allowlist (v0.20). `null` = no scope = full access.
   * A non-null array is the exact set of connector ids this token may reach
   * (core connectors are always additionally allowed at resolution time).
   */
  connectors: string[] | null;
  /** Skills v2 — per-token skill tag scope. `null` = every skill. */
  skillTags: string[] | null;
  /** Kebab House phase 0 — profile ("hat") served by my_context. `null` = default. */
  profile: string | null;
  /** Kebab House phase 1 — `oauth` for clients authorized via OAuth, else `token`. */
  kind?: "token" | "oauth";
  /** OAuth clients: whether destructive (write) tools are allowed. */
  writeAllowed?: boolean;
}

interface DeviceKVEntry {
  label: string;
  createdAt: string;
  /** Optional per-token connector allowlist. Absent = full access. */
  connectors?: string[];
  /** Skills v2 — optional per-token skill tag scope. Absent = every skill. */
  skillTags?: string[];
  /** Kebab House phase 0 — optional profile name. Absent = default profile. */
  profile?: string;
  /** Kebab House phase 1 — set for devices created by the OAuth flow. */
  oauth?: { clientId: string; clientName: string };
  /**
   * Kebab House phase 1 (TRU-05) — OAuth devices are read-only unless this
   * is true. Absent on static-token devices (no change for them).
   */
  writeAllowed?: boolean;
  /**
   * SEC-06 (2026-11 audit): set when the token was rotated or revoked.
   * On Vercel the `MCP_AUTH_TOKEN` env edit only lands on the next
   * deploy, so the old token keeps authenticating until then — this
   * tombstone makes the transport refuse it immediately instead of
   * falling back to full access.
   */
  revokedAt?: string;
}

/**
 * Parsed device entry.
 * - `absent`: no KV entry → no scope (full access; the documented
 *   default, and the case of the KV-only bootstrap token).
 * - `corrupt`: unparseable JSON, or a `connectors` / `skillTags` field that
 *   is present but not an array of strings → fail CLOSED (SEC-04).
 */
export type DeviceEntryState =
  | { kind: "absent" }
  | { kind: "corrupt" }
  | { kind: "ok"; entry: Partial<DeviceKVEntry> };

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((c) => typeof c === "string");
}

export function parseDeviceEntry(raw: string | null): DeviceEntryState {
  if (!raw) return { kind: "absent" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "corrupt" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "corrupt" };
  const entry = parsed as Record<string, unknown>;
  if (entry.connectors !== undefined && !isStringArray(entry.connectors))
    return { kind: "corrupt" };
  if (entry.skillTags !== undefined && !isStringArray(entry.skillTags)) return { kind: "corrupt" };
  // A malformed profile is ignored (falls back to the default profile) —
  // it carries no access right, so it never makes the entry corrupt.
  if (entry.profile !== undefined && typeof entry.profile !== "string") delete entry.profile;
  return { kind: "ok", entry: entry as Partial<DeviceKVEntry> };
}

function isRevoked(entry: Partial<DeviceKVEntry>): boolean {
  return typeof entry.revokedAt === "string" && entry.revokedAt.length > 0;
}

/**
 * Access level carried by one device entry, as seen from one KV namespace.
 * `null` = no restriction; an array = allowlist; "revoked" = refuse.
 */
export type DeviceAccess = "revoked" | string[] | null;

export function deviceAccessFromState(state: DeviceEntryState): DeviceAccess {
  if (state.kind === "absent") return null;
  if (state.kind === "corrupt") return [];
  if (isRevoked(state.entry)) return "revoked";
  return state.entry.connectors ?? null;
}

/**
 * Read-modify-write a device entry PRESERVING every field the mutator does
 * not touch (connectors, skillTags, revocation tombstone). All writers go
 * through this so adding a field can never be silently dropped by an
 * unrelated update — the pre-v0.23 setDeviceLabel rewrote {label,
 * createdAt} only and so wiped the token's connector scope on rename
 * (privilege escalation).
 *
 * A corrupt entry is only overwritten when the caller is explicitly
 * (re)setting a scope (`allowCorruptReset`); a plain rename refuses, since
 * rewriting it from defaults would silently grant full access.
 */
async function updateDeviceEntry(
  id: string,
  mutate: (entry: DeviceKVEntry) => void,
  opts: { allowCorruptReset?: boolean } = {}
): Promise<void> {
  const kv = getContextKVStore();
  const key = `${DEVICE_KEY_PREFIX}${id}`;
  const state = parseDeviceEntry(await kv.get(key));
  if (state.kind === "corrupt" && !opts.allowCorruptReset) {
    throw new Error("Device entry is corrupt; re-set its connector scope before editing it");
  }
  const entry: DeviceKVEntry = { label: "unnamed", createdAt: new Date().toISOString() };
  if (state.kind === "ok") {
    const prev = state.entry;
    if (typeof prev.label === "string" && prev.label.length > 0) entry.label = prev.label;
    if (typeof prev.createdAt === "string" && prev.createdAt.length > 0) {
      entry.createdAt = prev.createdAt;
    }
    if (prev.connectors !== undefined) entry.connectors = prev.connectors;
    if (prev.skillTags !== undefined) entry.skillTags = prev.skillTags;
    if (typeof prev.profile === "string") entry.profile = prev.profile;
    if (prev.oauth && typeof prev.oauth === "object") entry.oauth = prev.oauth;
    if (typeof prev.writeAllowed === "boolean") entry.writeAllowed = prev.writeAllowed;
    if (typeof prev.revokedAt === "string") entry.revokedAt = prev.revokedAt;
  }
  mutate(entry);
  await kv.set(key, JSON.stringify(entry));
}

/**
 * Skill tag scope carried by one device entry in one namespace. `null` =
 * every skill. Corrupt or revoked entries fail closed (`[]`).
 */
export async function getDeviceSkillTagsFrom(
  id: string,
  kv: { get(key: string): Promise<string | null> }
): Promise<string[] | null> {
  const state = parseDeviceEntry(await kv.get(`${DEVICE_KEY_PREFIX}${id}`));
  if (state.kind === "absent") return null;
  if (state.kind === "corrupt" || isRevoked(state.entry)) return [];
  return state.entry.skillTags ?? null;
}

/** Read a token's skill tag scope in the current namespace. `null` = every skill. */
export async function getDeviceSkillTags(id: string): Promise<string[] | null> {
  return getDeviceSkillTagsFrom(id, getContextKVStore());
}

/**
 * Set (or clear with `null`) a token's skill tag scope. Tags are
 * normalized to lower-case slugs, deduped, max 20. An empty array means
 * "no skills at all" for that token.
 */
export async function setDeviceSkillTags(id: string, tags: string[] | null): Promise<void> {
  let normalized: string[] | null = null;
  if (tags !== null) {
    if (!Array.isArray(tags)) throw new Error("Invalid skillTags: must be an array or null");
    normalized = [];
    for (const t of tags) {
      if (typeof t !== "string") throw new Error("Invalid skillTags: tags must be strings");
      const n = t
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 32);
      if (n && !normalized.includes(n)) normalized.push(n);
    }
    normalized = normalized.slice(0, 20);
  }
  await updateDeviceEntry(
    id,
    (e) => {
      if (normalized === null) delete e.skillTags;
      else e.skillTags = normalized;
    },
    { allowCorruptReset: true }
  );
}

/**
 * Label + profile carried by one device entry in one namespace. Revoked or
 * corrupt entries carry nothing. Never throws on a missing entry.
 */
export async function getDeviceMetaFrom(
  id: string,
  kv: { get(key: string): Promise<string | null> }
): Promise<{ label: string | null; profile: string | null }> {
  const state = parseDeviceEntry(await kv.get(`${DEVICE_KEY_PREFIX}${id}`));
  if (state.kind !== "ok" || isRevoked(state.entry)) return { label: null, profile: null };
  const label = typeof state.entry.label === "string" ? state.entry.label : null;
  const profile = typeof state.entry.profile === "string" ? state.entry.profile : null;
  return { label, profile };
}

/**
 * Bind a token to a profile (or clear with `null` → default profile). The
 * name is normalized; existence is checked by the caller (an unknown name
 * simply falls back to the default profile at read time).
 */
export async function setDeviceProfile(id: string, profile: string | null): Promise<void> {
  let normalized: string | null = null;
  if (profile !== null) {
    if (typeof profile !== "string") throw new Error("Invalid profile: must be a string or null");
    normalized = profile.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(normalized)) {
      throw new Error("Invalid profile name");
    }
    if (normalized === "default") normalized = null;
  }
  await updateDeviceEntry(id, (e) => {
    if (normalized === null) delete e.profile;
    else e.profile = normalized;
  });
}

const DEVICE_KEY_PREFIX = "devices:";
const LABEL_MAX_LEN = 40;

/**
 * Overwrite a device entry with a revocation tombstone (keeps the label
 * for audit). Tombstones are tiny and keyed by an 8-hex tokenId; they are
 * kept indefinitely so a token that lingers in a stale env snapshot can
 * never regain access.
 */
async function writeRevocationTombstone(
  kv: { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void> },
  key: string
): Promise<void> {
  const state = parseDeviceEntry(await kv.get(key));
  const label =
    state.kind === "ok" && typeof state.entry.label === "string" ? state.entry.label : "unnamed";
  const tombstone: DeviceKVEntry = {
    label,
    createdAt:
      state.kind === "ok" && typeof state.entry.createdAt === "string"
        ? state.entry.createdAt
        : new Date().toISOString(),
    revokedAt: new Date().toISOString(),
  };
  await kv.set(key, JSON.stringify(tombstone));
}

/** 16-hex SHA-256 prefix — matches rate-limit.ts hashToken(). */
function idHash16(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

/** Scan all rate-limit bucket keys for a given idHash across scopes. */
async function scanRateLimitKeysForToken(hash16: string): Promise<string[]> {
  const kv = getContextKVStore();
  // Key shape (tenant-wrapped by TenantKVStore): ratelimit:<scope>:<idHash>:<bucket>
  // scan() supports prefix patterns; we need to match the middle component,
  // so scan all ratelimit:* keys and filter by idHash locally.
  const all = await kvScanAll(kv, "ratelimit:*");
  return all.filter((k) => {
    const parts = k.split(":");
    // parts: ["ratelimit", "<scope>", "<idHash>", "<bucket>"]
    return parts.length === 4 && parts[2] === hash16;
  });
}

/**
 * Enumerate current devices: one row per token in `MCP_AUTH_TOKEN`.
 * KV-missing entries surface as `{ label: "unnamed", createdAt: "unknown" }`.
 */
export async function listDevices(): Promise<DeviceRow[]> {
  const envValue = getConfig("MCP_AUTH_TOKEN");
  const tokens = parseTokens(envValue);
  if (tokens.length === 0) return [];

  const kv = getContextKVStore();
  const rows: DeviceRow[] = [];
  for (const t of tokens) {
    const id = tokenId(t);
    const raw = await kv.get(`${DEVICE_KEY_PREFIX}${id}`);
    let label = "unnamed";
    let createdAt = "unknown";
    let connectors: string[] | null = null;
    let skillTags: string[] | null = null;
    let profile: string | null = null;
    // Display what resolution enforces: a corrupt entry is fail-closed and a
    // tombstoned token (rotated/revoked, still in a not-yet-redeployed env)
    // is refused — never show either as "All connectors".
    const state = parseDeviceEntry(raw);
    if (state.kind === "corrupt") {
      label = "corrupt entry";
      connectors = [];
      skillTags = [];
    } else if (state.kind === "ok") {
      const e = state.entry;
      if (typeof e.label === "string" && e.label.length > 0) label = e.label;
      if (typeof e.createdAt === "string" && e.createdAt.length > 0) createdAt = e.createdAt;
      connectors = e.connectors ?? null;
      skillTags = e.skillTags ?? null;
      profile = typeof e.profile === "string" ? e.profile : null;
      if (isRevoked(e)) {
        label = `${label} (revoked — pending redeploy)`;
        connectors = [];
        skillTags = [];
      }
    }
    const lastSeenAt = await getLastSeenAt(t);
    rows.push({ tokenId: id, label, createdAt, lastSeenAt, connectors, skillTags, profile });
  }
  rows.push(...(await listOAuthDevices()));
  return rows;
}

/** Kebab House phase 1 — devices created by the OAuth flow (not revoked). */
export async function listOAuthDevices(): Promise<DeviceRow[]> {
  const kv = getContextKVStore();
  const keys = await kvScanAll(kv, `${DEVICE_KEY_PREFIX}*`);
  const rows: DeviceRow[] = [];
  for (const key of keys) {
    const id = key.slice(key.lastIndexOf(DEVICE_KEY_PREFIX) + DEVICE_KEY_PREFIX.length);
    if (!/^[0-9a-f]{8}$/.test(id)) continue;
    const state = parseDeviceEntry(await kv.get(`${DEVICE_KEY_PREFIX}${id}`));
    if (state.kind !== "ok" || !state.entry.oauth || isRevoked(state.entry)) continue;
    const e = state.entry;
    rows.push({
      tokenId: id,
      label: typeof e.label === "string" && e.label ? e.label : "OAuth client",
      createdAt: typeof e.createdAt === "string" ? e.createdAt : "unknown",
      lastSeenAt: null,
      connectors: e.connectors ?? null,
      skillTags: e.skillTags ?? null,
      profile: typeof e.profile === "string" ? e.profile : null,
      kind: "oauth",
      writeAllowed: e.writeAllowed === true,
    });
  }
  return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** True when `id` is an active (not revoked) OAuth device. */
export async function isOAuthDevice(id: string): Promise<boolean> {
  const state = parseDeviceEntry(await getContextKVStore().get(`${DEVICE_KEY_PREFIX}${id}`));
  return state.kind === "ok" && Boolean(state.entry.oauth) && !isRevoked(state.entry);
}

/** Create the device entry of a newly authorized OAuth client. */
export async function createOAuthDevice(input: {
  id: string;
  label: string;
  clientId: string;
  clientName: string;
  connectors: string[] | null;
  skillTags: string[] | null;
  profile: string | null;
  writeAllowed: boolean;
}): Promise<void> {
  const entry: DeviceKVEntry = {
    label: input.label.trim().slice(0, LABEL_MAX_LEN) || "OAuth client",
    createdAt: new Date().toISOString(),
    oauth: { clientId: input.clientId, clientName: input.clientName },
    writeAllowed: input.writeAllowed,
  };
  if (input.connectors !== null) entry.connectors = input.connectors;
  if (input.skillTags !== null) entry.skillTags = input.skillTags;
  if (input.profile) entry.profile = input.profile;
  await getContextKVStore().set(`${DEVICE_KEY_PREFIX}${input.id}`, JSON.stringify(entry));
}

/** Toggle write access of an OAuth device (TRU-05). */
export async function setDeviceWriteAllowed(id: string, allowed: boolean): Promise<void> {
  await updateDeviceEntry(id, (e) => {
    e.writeAllowed = allowed;
  });
}

/** Revoke an OAuth device: tombstone (its tokens stop resolving at once). */
export async function revokeOAuthDevice(id: string): Promise<void> {
  const kv = getContextKVStore();
  await writeRevocationTombstone(kv, `${DEVICE_KEY_PREFIX}${id}`);
}

/**
 * Whether the caller device may use destructive tools (TRU-05). Static
 * tokens: always (unchanged behaviour). OAuth devices: only when allowed.
 */
export async function getDeviceWriteAllowedFrom(
  id: string,
  kv: { get(key: string): Promise<string | null> }
): Promise<boolean> {
  const state = parseDeviceEntry(await kv.get(`${DEVICE_KEY_PREFIX}${id}`));
  if (state.kind !== "ok") return true;
  if (!state.entry.oauth) return true;
  return state.entry.writeAllowed === true;
}

/**
 * Read a token's connector allowlist in the current (tenant) namespace.
 * Returns the stored array, or `null` when the token has no scope (missing
 * entry or absent `connectors` field — full access). SEC-04: a corrupt
 * entry or a revoked token yields `[]` (fail closed). Never throws on
 * parse errors.
 *
 * `id` is the 8-hex `tokenId` (see auth.ts). Reads through
 * `getContextKVStore()` so tenant isolation is automatic.
 */
export async function getDeviceConnectors(id: string): Promise<string[] | null> {
  const access = await getDeviceAccess(id, getContextKVStore());
  if (access === "revoked") return [];
  return access;
}

/**
 * Read one token's access level from a specific KV namespace. Used by
 * token-scope.ts, which consults both the root and the tenant namespace
 * (SEC-04) and keeps the most restrictive answer.
 */
export async function getDeviceAccess(
  id: string,
  kv: { get(key: string): Promise<string | null> }
): Promise<DeviceAccess> {
  const raw = await kv.get(`${DEVICE_KEY_PREFIX}${id}`);
  return deviceAccessFromState(parseDeviceEntry(raw));
}

/**
 * Set (or clear) a token's connector allowlist. Read-modify-write that
 * preserves the existing `label` + `createdAt` (mirrors setDeviceLabel).
 *
 * - `connectors` = array → validated against the known connector ids;
 *   unknown ids throw. Deduped + order-stable. An empty array is a valid
 *   "nothing but core" lock.
 * - `connectors` = `null` → the field is removed (token returns to full
 *   access).
 *
 * Creates the entry with `label: "unnamed"` + fresh `createdAt` when none
 * exists yet, so a scope can be pinned to a token that was never labelled.
 */
export async function setDeviceConnectors(id: string, connectors: string[] | null): Promise<void> {
  let validated: string[] | null = null;
  if (connectors !== null) {
    if (!Array.isArray(connectors)) {
      throw new Error("Invalid connectors: must be an array of connector ids or null");
    }
    const known = new Set(getKnownConnectorIds());
    const seen = new Set<string>();
    validated = [];
    for (const c of connectors) {
      if (typeof c !== "string" || !known.has(c)) {
        throw new Error(`Unknown connector id: ${JSON.stringify(c)}`);
      }
      if (!seen.has(c)) {
        seen.add(c);
        validated.push(c);
      }
    }
  }

  // An explicit scope (re)set may repair a corrupt entry.
  await updateDeviceEntry(
    id,
    (e) => {
      if (validated === null) delete e.connectors;
      else e.connectors = validated;
    },
    { allowCorruptReset: true }
  );
}

/**
 * Validate + persist a device label. 1-40 printable chars, no newlines.
 * Preserves existing `createdAt` when rewriting an existing entry; sets
 * `createdAt = now` when creating.
 */
export async function setDeviceLabel(id: string, label: string): Promise<void> {
  const trimmed = typeof label === "string" ? label.trim() : "";
  if (trimmed.length === 0 || trimmed.length > LABEL_MAX_LEN) {
    throw new Error(`Invalid label: must be 1-${LABEL_MAX_LEN} chars (got ${trimmed.length})`);
  }
  if (/[\r\n]/.test(trimmed)) {
    throw new Error("Invalid label: newlines are not allowed");
  }

  // SEC-03b: preserves connectors, skillTags and any revocation tombstone;
  // refuses to rewrite a corrupt entry (would silently grant full access).
  await updateDeviceEntry(id, (e) => {
    e.label = trimmed;
  });
}

/**
 * Revoke a device: remove its token from `MCP_AUTH_TOKEN`, delete its KV
 * entry, and clear any rate-limit buckets keyed on its idHash. Best-effort
 * on all three; returns flags indicating what was done.
 *
 * Caller supplies the raw token (looked up via the admin route from the
 * current env list) so we can derive the 16-hex idHash without keeping
 * raw tokens in KV. If called with an unknown tokenId the env splice
 * silently no-ops (nothing to remove); returns `{ kvDeleted, ... }`
 * reflecting the actual state.
 */
export async function deleteDevice(
  id: string,
  rawToken: string
): Promise<{
  envDeleted: boolean;
  kvDeleted: boolean;
  rateLimitBucketsDeleted: number;
}> {
  // 1) Splice env list.
  const currentEnv = getConfig("MCP_AUTH_TOKEN");
  const tokens = parseTokens(currentEnv);
  let envDeleted = false;
  const filtered: string[] = [];
  for (const t of tokens) {
    if (t === rawToken) {
      envDeleted = true;
      continue;
    }
    filtered.push(t);
  }
  if (envDeleted) {
    await getEnvStore().write({ MCP_AUTH_TOKEN: filtered.join(",") });
  }

  // 2) Replace the KV entry with a revocation tombstone (SEC-06). The env
  // edit above only takes effect on the next deploy on Vercel; until then
  // the token still authenticates, and a *deleted* entry would mean "no
  // scope" = full access. The tombstone makes the transport refuse it now.
  const kv = getContextKVStore();
  const labelKey = `${DEVICE_KEY_PREFIX}${id}`;
  const labelExisted = (await kv.get(labelKey)) !== null;
  await writeRevocationTombstone(kv, labelKey);

  // 3) Clear rate-limit buckets.
  const rateLimitBucketsDeleted = await clearDeviceRateLimit(rawToken);

  return { envDeleted, kvDeleted: labelExisted, rateLimitBucketsDeleted };
}

/**
 * Mint a fresh 64-hex token for an existing device, splice it into
 * `MCP_AUTH_TOKEN` replacing the matched tokenId, and move the KV label
 * entry to the new tokenId. Rate-limit buckets keyed on the OLD idHash
 * are cleared so the new token starts with a clean slate.
 *
 * Throws when the tokenId is not present in the current env list.
 */
export async function rotateDeviceToken(
  id: string
): Promise<{ newToken: string; newTokenId: string }> {
  const currentEnv = getConfig("MCP_AUTH_TOKEN");
  const tokens = parseTokens(currentEnv);
  const matchIdx = tokens.findIndex((t) => tokenId(t) === id);
  if (matchIdx === -1) {
    throw new Error(`not_found: tokenId ${id} is not in the current MCP_AUTH_TOKEN list`);
  }
  const oldToken = tokens[matchIdx]!;
  const newToken = randomBytes(32).toString("hex");
  const newTokenId = tokenId(newToken);

  // SEC-06: carry the old entry's label + scope over to the NEW tokenId
  // BEFORE touching the env or the old entry, so a crash mid-rotation can
  // never leave a token without its scope.
  const kv = getContextKVStore();
  const oldKey = `${DEVICE_KEY_PREFIX}${id}`;
  const newKey = `${DEVICE_KEY_PREFIX}${newTokenId}`;
  const oldState = parseDeviceEntry(await kv.get(oldKey));
  let label = "unnamed";
  let connectors: string[] | undefined;
  let skillTags: string[] | undefined;
  let profile: string | undefined;
  if (oldState.kind === "ok") {
    if (typeof oldState.entry.label === "string" && oldState.entry.label.length > 0) {
      label = oldState.entry.label;
    }
    // Preserve the connector scope across rotation — a rotated team token
    // must keep its allowlist, else rotation would silently re-grant full
    // access (privilege escalation).
    connectors = oldState.entry.connectors;
    skillTags = oldState.entry.skillTags;
    if (typeof oldState.entry.profile === "string") profile = oldState.entry.profile;
  } else if (oldState.kind === "corrupt") {
    connectors = []; // fail closed, mirrors token-scope resolution
    skillTags = [];
  }
  const newEntry: DeviceKVEntry = { label, createdAt: new Date().toISOString() };
  if (connectors !== undefined) newEntry.connectors = connectors;
  if (skillTags !== undefined) newEntry.skillTags = skillTags;
  if (profile !== undefined) newEntry.profile = profile;
  await kv.set(newKey, JSON.stringify(newEntry));

  // Splice env list.
  const updated = [...tokens];
  updated[matchIdx] = newToken;
  await getEnvStore().write({ MCP_AUTH_TOKEN: updated.join(",") });

  // Tombstone the old tokenId: on Vercel the env edit only applies after a
  // redeploy, and until then the old token still authenticates.
  await writeRevocationTombstone(kv, oldKey);

  // Clear old rate-limit buckets — the NEW token has a different idHash,
  // so its fresh buckets will accumulate independently.
  await clearDeviceRateLimit(oldToken);

  return { newToken, newTokenId };
}

/**
 * Scan rate-limit buckets for a token's idHash; return the end timestamp
 * of the most-recent bucket as an ISO string, or null when no activity
 * has been recorded. Matches the rate-limit bucket shape
 * `ratelimit:<scope>:<idHash>:<minuteBucket>` (4 parts under the tenant
 * wrapper).
 */
export async function getLastSeenAt(rawToken: string): Promise<string | null> {
  const hash = idHash16(rawToken);
  const keys = await scanRateLimitKeysForToken(hash);
  if (keys.length === 0) return null;
  let maxBucket = -1;
  for (const k of keys) {
    const parts = k.split(":");
    const bucketStr = parts[3];
    if (!bucketStr) continue;
    const bucket = parseInt(bucketStr, 10);
    if (Number.isFinite(bucket) && bucket > maxBucket) maxBucket = bucket;
  }
  if (maxBucket < 0) return null;
  // Bucket window is 1 minute; the bucket ENDS at (bucket + 1) * 60_000.
  return new Date((maxBucket + 1) * 60_000).toISOString();
}

/**
 * Clear every rate-limit bucket keyed on this token's idHash across all
 * scopes. Returns the count deleted. Best-effort; failures swallowed by
 * the underlying KV backend.
 */
export async function clearDeviceRateLimit(rawToken: string): Promise<number> {
  const hash = idHash16(rawToken);
  const keys = await scanRateLimitKeysForToken(hash);
  const kv = getContextKVStore();
  for (const k of keys) {
    await kv.delete(k);
  }
  return keys.length;
}
