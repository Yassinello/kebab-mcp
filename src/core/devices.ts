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
}

const DEVICE_KEY_PREFIX = "devices:";
const LABEL_MAX_LEN = 40;

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
 * Read a token's connector allowlist. Returns the stored array, or `null`
 * when the token has no scope (missing entry, absent `connectors` field, or
 * a corrupt entry) — i.e. fail-open to full access. Never throws.
 *
 * `id` is the 8-hex `tokenId` (see auth.ts). Reads through
 * `getContextKVStore()` so tenant isolation is automatic.
 */
export async function getDeviceConnectors(id: string): Promise<string[] | null> {
  const kv = getContextKVStore();
  const raw = await kv.get(`${DEVICE_KEY_PREFIX}${id}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<DeviceKVEntry>;
    if (!Array.isArray(parsed.connectors)) return null;
    return parsed.connectors.filter((c): c is string => typeof c === "string");
  } catch {
    // Corrupt entry — fail open (full access), never wedge the token.
    return null;
  }
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
  const existingRaw = await kv.get(key);
  let createdAt = new Date().toISOString();
  if (existingRaw) {
    try {
      const parsed = JSON.parse(existingRaw) as Partial<DeviceKVEntry>;
      if (typeof parsed.createdAt === "string" && parsed.createdAt.length > 0) {
        createdAt = parsed.createdAt;
      }
    } catch {
      // fall through to fresh createdAt
    }
  }
  const entry: DeviceKVEntry = { label: trimmed, createdAt };
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

  // 2) Delete KV label entry.
  const kv = getContextKVStore();
  const labelKey = `${DEVICE_KEY_PREFIX}${id}`;
  const labelExisted = (await kv.get(labelKey)) !== null;
  if (labelExisted) {
    await kv.delete(labelKey);
  }

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

  // Splice env list.
  const updated = [...tokens];
  updated[matchIdx] = newToken;
  await getEnvStore().write({ MCP_AUTH_TOKEN: updated.join(",") });

  // Move KV entry: preserve label, update createdAt to now (mint timestamp).
  const kv = getContextKVStore();
  const oldKey = `${DEVICE_KEY_PREFIX}${id}`;
  const newKey = `${DEVICE_KEY_PREFIX}${newTokenId}`;
  const oldRaw = await kv.get(oldKey);
  let label = "unnamed";
  let connectors: string[] | undefined;
  if (oldRaw) {
    try {
      const parsed = JSON.parse(oldRaw) as Partial<DeviceKVEntry>;
      if (typeof parsed.label === "string" && parsed.label.length > 0) label = parsed.label;
      // Preserve the connector scope across rotation — a rotated team token
      // must keep its allowlist, else rotation would silently re-grant full
      // access (privilege escalation).
      if (Array.isArray(parsed.connectors)) {
        connectors = parsed.connectors.filter((c): c is string => typeof c === "string");
      }
    } catch {
      // fall through
    }
    await kv.delete(oldKey);
  }
  const newEntry: DeviceKVEntry = { label, createdAt: new Date().toISOString() };
  if (connectors !== undefined) newEntry.connectors = connectors;
  await kv.set(newKey, JSON.stringify(newEntry));

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
