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
}

interface DeviceKVEntry {
  label: string;
  createdAt: string;
  /** Optional per-token connector allowlist. Absent = full access. */
  connectors?: string[];
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
 * - `corrupt`: unparseable JSON, or a `connectors` field that is present
 *   but not an array of strings → fail CLOSED (SEC-04).
 */
export type DeviceEntryState =
  | { kind: "absent" }
  | { kind: "corrupt" }
  | { kind: "ok"; entry: Partial<DeviceKVEntry> & { connectors?: string[] } };

export function parseDeviceEntry(raw: string | null): DeviceEntryState {
  if (!raw) return { kind: "absent" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "corrupt" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "corrupt" };
  const entry = parsed as Partial<DeviceKVEntry> & { connectors?: unknown };
  if (entry.connectors !== undefined) {
    if (
      !Array.isArray(entry.connectors) ||
      !entry.connectors.every((c): c is string => typeof c === "string")
    ) {
      return { kind: "corrupt" };
    }
  }
  return { kind: "ok", entry: entry as Partial<DeviceKVEntry> & { connectors?: string[] } };
}

/**
 * Access level carried by one device entry, as seen from one KV namespace.
 * `null` = no restriction; an array = allowlist; "revoked" = refuse.
 */
export type DeviceAccess = "revoked" | string[] | null;

export function deviceAccessFromState(state: DeviceEntryState): DeviceAccess {
  if (state.kind === "absent") return null;
  if (state.kind === "corrupt") return [];
  if (typeof state.entry.revokedAt === "string" && state.entry.revokedAt.length > 0) {
    return "revoked";
  }
  return state.entry.connectors ?? null;
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
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Partial<DeviceKVEntry>;
        if (typeof parsed.label === "string" && parsed.label.length > 0) label = parsed.label;
        if (typeof parsed.createdAt === "string" && parsed.createdAt.length > 0) {
          createdAt = parsed.createdAt;
        }
        if (Array.isArray(parsed.connectors)) {
          connectors = parsed.connectors.filter((c): c is string => typeof c === "string");
        }
      } catch {
        // Corrupt entry — fall back to defaults (full access).
      }
    }
    const lastSeenAt = await getLastSeenAt(t);
    rows.push({ tokenId: id, label, createdAt, lastSeenAt, connectors });
  }
  return rows;
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

  const kv = getContextKVStore();
  const key = `${DEVICE_KEY_PREFIX}${id}`;
  const existingRaw = await kv.get(key);
  let label = "unnamed";
  let createdAt = new Date().toISOString();
  if (existingRaw) {
    try {
      const parsed = JSON.parse(existingRaw) as Partial<DeviceKVEntry>;
      if (typeof parsed.label === "string" && parsed.label.length > 0) label = parsed.label;
      if (typeof parsed.createdAt === "string" && parsed.createdAt.length > 0) {
        createdAt = parsed.createdAt;
      }
    } catch {
      // Corrupt entry — rewrite with fresh label/createdAt.
    }
  }
  const entry: DeviceKVEntry = { label, createdAt };
  if (validated !== null) entry.connectors = validated;
  const prevState = parseDeviceEntry(existingRaw);
  if (prevState.kind === "ok" && typeof prevState.entry.revokedAt === "string") {
    entry.revokedAt = prevState.entry.revokedAt;
  }
  await kv.set(key, JSON.stringify(entry));
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

  const kv = getContextKVStore();
  const key = `${DEVICE_KEY_PREFIX}${id}`;
  const state = parseDeviceEntry(await kv.get(key));
  if (state.kind === "corrupt") {
    // SEC-04: never "repair" a corrupt entry by rewriting it without a
    // scope — that would silently grant full access.
    throw new Error("Device entry is corrupt; re-set its connector scope before renaming");
  }
  let createdAt = new Date().toISOString();
  const entry: DeviceKVEntry = { label: trimmed, createdAt };
  if (state.kind === "ok") {
    const prev = state.entry;
    if (typeof prev.createdAt === "string" && prev.createdAt.length > 0) {
      createdAt = prev.createdAt;
      entry.createdAt = createdAt;
    }
    // SEC-03b (2026-11 audit): preserve the connector scope and any
    // revocation tombstone. Previously the rewrite dropped `connectors`,
    // so renaming a scoped token silently restored full access.
    if (prev.connectors !== undefined) entry.connectors = prev.connectors;
    if (typeof prev.revokedAt === "string") entry.revokedAt = prev.revokedAt;
  }
  await kv.set(key, JSON.stringify(entry));
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
  if (oldState.kind === "ok") {
    if (typeof oldState.entry.label === "string" && oldState.entry.label.length > 0) {
      label = oldState.entry.label;
    }
    // Preserve the connector scope across rotation — a rotated team token
    // must keep its allowlist, else rotation would silently re-grant full
    // access (privilege escalation).
    connectors = oldState.entry.connectors;
  } else if (oldState.kind === "corrupt") {
    connectors = []; // fail closed, mirrors token-scope resolution
  }
  const newEntry: DeviceKVEntry = { label, createdAt: new Date().toISOString() };
  if (connectors !== undefined) newEntry.connectors = connectors;
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
