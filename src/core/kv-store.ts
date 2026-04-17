/**
 * KVStore — pluggable key/value storage abstraction.
 *
 * Two implementations:
 * - FilesystemKV: writes to `./data/kv.json` (or `/tmp/mymcp-kv.json` on Vercel
 *   when Upstash is not configured). Atomic write via tmp + rename. All keys
 *   live in a single JSON map for simplicity.
 * - UpstashKV: optional production backend using Upstash Redis REST API.
 *   Activates only if UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set.
 *   Uses raw fetch() — no @upstash/redis dep (keeps bundle small).
 *
 * Selection rules:
 * - If Upstash env vars present → UpstashKV
 * - Else if process.env.VERCEL === "1" → FilesystemKV at /tmp (ephemeral, warned)
 * - Else → FilesystemKV at ./data/kv.json
 */

import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { withTenantPrefix } from "./tenant";

export interface KVStore {
  kind: "filesystem" | "upstash";
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
  /**
   * Atomically increment a counter key and (optionally) set its TTL.
   * Returns the post-increment value.
   *
   * Upstash path is genuinely atomic (pipelined INCR + EXPIRE). The
   * filesystem path is read-modify-write under the existing write queue
   * — single-process dev only, racy across processes but fine for the
   * in-repo dev loop.
   *
   * Used by the rate limiter to avoid the classic get-then-set race
   * (two concurrent callers both reading `N` and both writing `N+1`).
   */
  incr?(key: string, opts?: { ttlSeconds?: number }): Promise<number>;
  /**
   * Cursor-based key scanning. Safer than `list()` for large key sets
   * because it avoids the O(N) KEYS command on Redis.
   *
   * - `cursor` — pass "0" to start; the returned cursor is "0" when done.
   * - `opts.match` — glob pattern (e.g. "ratelimit:*").
   * - `opts.count` — hint for how many keys to return per call (default 100).
   *
   * Optional — callers must feature-check (`if (kv.scan)`).
   */
  scan?(
    cursor: string,
    opts?: { match?: string; count?: number }
  ): Promise<{ cursor: string; keys: string[] }>;
  /**
   * Multi-get: fetch multiple keys in a single round-trip.
   * Returns values in the same order as `keys`; missing keys yield `null`.
   *
   * Optional — callers must feature-check (`if (kv.mget)`).
   */
  mget?(keys: string[]): Promise<(string | null)[]>;
  /**
   * Push a JSON line onto the head of a capped list. The store is
   * responsible for trimming to `maxLength`. Used by the log store.
   * Optional — only Upstash implements it today; callers must feature-check.
   */
  lpushCapped?(
    key: string,
    value: string,
    maxLength: number,
    opts?: { ttlSeconds?: number }
  ): Promise<void>;
  /** Read a range from a list (head-indexed, inclusive). */
  lrange?(key: string, start: number, stop: number): Promise<string[]>;
}

// ── FilesystemKV ────────────────────────────────────────────────────

class FilesystemKV implements KVStore {
  kind = "filesystem" as const;
  private filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();
  // In-memory read cache. Dashboard page renders trigger ~10 get() calls
  // per render and each one was re-parsing the full JSON map. 500ms TTL
  // is aggressive enough to serve a single render tree but short enough
  // that concurrent processes (dev + npm scripts sharing data/kv.json)
  // still see each other's writes within a second. Invalidated on every
  // local write.
  private cache: { at: number; map: Record<string, string> } | null = null;
  private static readonly CACHE_TTL_MS = 500;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private async readAll(): Promise<Record<string, string>> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < FilesystemKV.CACHE_TTL_MS) {
      return this.cache.map;
    }
    try {
      const buf = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(buf);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const map = parsed as Record<string, string>;
        this.cache = { at: now, map };
        return map;
      }
      this.cache = { at: now, map: {} };
      return {};
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.cache = { at: now, map: {} };
        return {};
      }
      return {};
    }
  }

  private async writeAll(map: Record<string, string>): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(map, null, 2), "utf-8");
    await fs.rename(tmp, this.filePath);
    // Refresh the in-memory cache after a local write so subsequent reads
    // within the TTL window don't serve stale data.
    this.cache = { at: Date.now(), map: { ...map } };
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(() => fn());
    this.writeQueue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  async get(key: string): Promise<string | null> {
    // Drain any in-flight writes before reading so the caller always
    // sees the latest state. Matters for tests and for race-prone
    // sequences like resetCredentialHydration() → immediate rehydrate.
    await this.writeQueue;
    const map = await this.readAll();
    return map[key] ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    // Synchronously invalidate the cache so any concurrent reader that
    // *hasn't yet entered the write queue* forces a fresh read instead
    // of serving pre-write cached data.
    this.cache = null;
    await this.enqueue(async () => {
      const map = await this.readAll();
      map[key] = value;
      await this.writeAll(map);
    });
  }

  async delete(key: string): Promise<void> {
    this.cache = null;
    await this.enqueue(async () => {
      const map = await this.readAll();
      if (key in map) {
        delete map[key];
        await this.writeAll(map);
      }
    });
  }

  async list(prefix?: string): Promise<string[]> {
    await this.writeQueue;
    const map = await this.readAll();
    const keys = Object.keys(map);
    return prefix ? keys.filter((k) => k.startsWith(prefix)) : keys;
  }

  async scan(
    cursor: string,
    opts?: { match?: string; count?: number }
  ): Promise<{ cursor: string; keys: string[] }> {
    await this.writeQueue;
    const map = await this.readAll();
    const allKeys = Object.keys(map);

    // Filter by glob-like match pattern (supports only trailing *)
    let filtered = allKeys;
    if (opts?.match) {
      const pattern = opts.match;
      if (pattern.endsWith("*")) {
        const prefix = pattern.slice(0, -1);
        filtered = allKeys.filter((k) => k.startsWith(prefix));
      } else {
        filtered = allKeys.filter((k) => k === pattern);
      }
    }

    // Simulate pagination via numeric cursor (offset into filtered list)
    const offset = cursor === "0" ? 0 : parseInt(cursor, 10) || 0;
    const count = opts?.count ?? 100;
    const slice = filtered.slice(offset, offset + count);
    const nextOffset = offset + count;
    const nextCursor = nextOffset >= filtered.length ? "0" : String(nextOffset);

    return { cursor: nextCursor, keys: slice };
  }

  async mget(keys: string[]): Promise<(string | null)[]> {
    await this.writeQueue;
    const map = await this.readAll();
    return keys.map((k) => map[k] ?? null);
  }

  // Read-modify-write under the write queue. TTL is not enforced on the
  // filesystem backend — dev-only path, and the rate limiter treats TTL
  // as a best-effort hint anyway. Callers relying on eviction should
  // prefer Upstash in prod.
  //
  // TECH-06 lazy prune: after incrementing, scan for `ratelimit:*` keys
  // whose bucket timestamp is older than 2× ttlSeconds ago. This runs
  // inside the write queue so it's serialized. O(keys) but fine for dev.
  async incr(key: string, opts?: { ttlSeconds?: number }): Promise<number> {
    this.cache = null;
    return this.enqueue(async () => {
      const map = await this.readAll();
      const prev = parseInt(map[key] ?? "0", 10);
      const next = Number.isFinite(prev) ? prev + 1 : 1;
      map[key] = String(next);

      // Lazy prune stale ratelimit buckets
      if (opts?.ttlSeconds && opts.ttlSeconds > 0) {
        const nowMs = Date.now();
        const windowMs = 60_000; // rate limiter uses 1-minute buckets
        const currentBucket = Math.floor(nowMs / windowMs);
        // A bucket is stale if its timestamp is older than 2× the TTL window
        const staleBefore = currentBucket - Math.ceil((opts.ttlSeconds * 1000) / windowMs);
        for (const k of Object.keys(map)) {
          if (!k.startsWith("ratelimit:")) continue;
          const parts = k.split(":");
          const bucketStr = parts[parts.length - 1];
          const bucket = parseInt(bucketStr, 10);
          if (Number.isFinite(bucket) && bucket < staleBefore) {
            delete map[k];
          }
        }
      }

      await this.writeAll(map);
      return next;
    });
  }
}

// ── UpstashKV ───────────────────────────────────────────────────────

/**
 * v0.6 MED-4: bound Upstash error bodies to 80 chars and scrub any
 * `authorization: …` header echoes. Upstash's REST API rarely does so,
 * but a misconfigured proxy in front (common for self-hosted Redis
 * clones sitting behind nginx) can reflect the request headers into
 * its own 4xx response bodies. Logging the raw text would then leak
 * our bearer token to anywhere the exception surfaces.
 */
function sanitizeUpstashError(text: string): string {
  const scrubbed = text
    .replace(/authorization\s*:\s*bearer\s+[^\s,;"']+/gi, "authorization: [redacted]")
    .replace(/bearer\s+[a-z0-9._-]{8,}/gi, "Bearer [redacted]");
  return scrubbed.slice(0, 80);
}

/**
 * Node fetch() (undici) reuses TCP connections via its internal connection
 * pool. No manual keep-alive or agent configuration is needed.
 */
class UpstashKV implements KVStore {
  kind = "upstash" as const;
  private url: string;
  private token: string;

  constructor(url: string, token: string) {
    this.url = url.replace(/\/$/, "");
    this.token = token;
  }

  private async call(command: (string | number)[]): Promise<unknown> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Upstash ${command[0]} failed: ${res.status} ${sanitizeUpstashError(text)}`);
    }
    const json = (await res.json()) as { result?: unknown; error?: string };
    if (json.error) throw new Error(`Upstash error: ${json.error}`);
    return json.result;
  }

  async get(key: string): Promise<string | null> {
    const result = await this.call(["GET", key]);
    return typeof result === "string" ? result : result == null ? null : String(result);
  }

  async set(key: string, value: string): Promise<void> {
    await this.call(["SET", key, value]);
  }

  async delete(key: string): Promise<void> {
    await this.call(["DEL", key]);
  }

  async list(prefix?: string): Promise<string[]> {
    const pattern = prefix ? `${prefix}*` : "*";
    const result = await this.call(["KEYS", pattern]);
    return Array.isArray(result) ? (result as string[]) : [];
  }

  async scan(
    cursor: string,
    opts?: { match?: string; count?: number }
  ): Promise<{ cursor: string; keys: string[] }> {
    const parsed = parseInt(cursor, 10);
    if (Number.isNaN(parsed)) {
      throw new Error(`Invalid SCAN cursor from Upstash: ${cursor}`);
    }
    const args: (string | number)[] = ["SCAN", parsed];
    if (opts?.match) {
      args.push("MATCH", opts.match);
    }
    args.push("COUNT", opts?.count ?? 100);
    const result = await this.call(args);
    // Upstash returns [nextCursor, [key1, key2, ...]]
    if (!Array.isArray(result) || result.length < 2) {
      return { cursor: "0", keys: [] };
    }
    const nextCursor = String(result[0]);
    const keys = Array.isArray(result[1]) ? (result[1] as string[]) : [];
    return { cursor: nextCursor, keys };
  }

  async mget(keys: string[]): Promise<(string | null)[]> {
    if (keys.length === 0) return [];
    const result = await this.call(["MGET", ...keys]);
    if (!Array.isArray(result)) {
      throw new Error(`Upstash MGET returned non-array result: ${typeof result}`);
    }
    return (result as (string | null)[]).map((v) =>
      typeof v === "string" ? v : v == null ? null : String(v)
    );
  }

  /**
   * Pipelined INCR + EXPIRE. Upstash's REST pipeline endpoint (POST
   * `/pipeline`) executes an array of commands in a single round-trip.
   * INCR runs first; EXPIRE is only issued when a TTL is requested.
   * Returns the post-increment value.
   *
   * Note: Upstash pipeline != transaction, but for this use case
   * (single counter key) atomicity of INCR alone is sufficient to
   * eliminate the get-then-set race.
   */
  async incr(key: string, opts?: { ttlSeconds?: number }): Promise<number> {
    const commands: (string | number)[][] = [["INCR", key]];
    if (opts?.ttlSeconds && opts.ttlSeconds > 0) {
      commands.push(["EXPIRE", key, Math.ceil(opts.ttlSeconds)]);
    }
    const res = await fetch(`${this.url}/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(commands),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Upstash pipeline failed: ${res.status} ${sanitizeUpstashError(text)}`);
    }
    const json = (await res.json()) as Array<{ result?: unknown; error?: string }>;
    if (!Array.isArray(json) || json.length === 0) {
      throw new Error("Upstash pipeline returned empty response");
    }
    const incrResult = json[0];
    if (incrResult.error) throw new Error(`Upstash INCR error: ${incrResult.error}`);
    const n = typeof incrResult.result === "number" ? incrResult.result : Number(incrResult.result);
    if (!Number.isFinite(n)) throw new Error("Upstash INCR returned non-numeric result");
    return n;
  }

  async lpushCapped(
    key: string,
    value: string,
    maxLength: number,
    opts?: { ttlSeconds?: number }
  ): Promise<void> {
    const commands: (string | number)[][] = [
      ["LPUSH", key, value],
      ["LTRIM", key, 0, Math.max(0, maxLength - 1)],
    ];
    if (opts?.ttlSeconds && opts.ttlSeconds > 0) {
      commands.push(["EXPIRE", key, Math.ceil(opts.ttlSeconds)]);
    }
    const res = await fetch(`${this.url}/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(commands),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Upstash pipeline failed: ${res.status} ${sanitizeUpstashError(text)}`);
    }
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const result = await this.call(["LRANGE", key, start, stop]);
    if (!Array.isArray(result)) return [];
    return (result as unknown[]).map((v) => (typeof v === "string" ? v : String(v)));
  }
}

// ── Factory ──────────────────────────────────────────────────────────

let cached: KVStore | null = null;

export function getKVStore(): KVStore {
  if (cached) return cached;

  const upstashUrl = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (upstashUrl && upstashToken) {
    cached = new UpstashKV(upstashUrl, upstashToken);
    return cached;
  }

  // Vercel detected, but no Upstash: fall back to /tmp with a warning.
  if (process.env.VERCEL === "1") {
    console.warn(
      "[MyMCP] KVStore: running on Vercel without UPSTASH_REDIS_REST_URL/TOKEN — " +
        "using /tmp filesystem (ephemeral, data lost on cold start). " +
        "Set Upstash env vars for persistence."
    );
    cached = new FilesystemKV("/tmp/mymcp-kv.json");
    return cached;
  }

  // Allow test overrides via MYMCP_KV_PATH (used by store-versioning tests
  // to point at a unique temp file per test, preventing cross-test state leak).
  const kvPath = process.env.MYMCP_KV_PATH?.trim();
  cached = new FilesystemKV(kvPath || path.resolve(process.cwd(), "data", "kv.json"));
  return cached;
}

/** Reset the cached instance. Test-only. */
export function resetKVStoreCache(): void {
  cached = null;
}

/**
 * Clear the in-memory read cache of the current KVStore instance.
 * For FilesystemKV this drops the parsed-JSON cache so the next read
 * goes to disk. For UpstashKV this is a no-op (no local cache).
 */
export function clearKVReadCache(): void {
  if (!cached) return;
  // FilesystemKV stashes a `cache` field; UpstashKV does not.
  // Use a duck-type check to avoid coupling to class internals.
  const fs = cached as unknown as { cache: unknown };
  if ("cache" in fs) {
    fs.cache = null;
  }
}

// ── kvScanAll helper ───────────────────────────────────────────────

/**
 * Iterate `kv.scan()` until cursor returns "0", collecting all matching keys.
 * Falls back to `kv.list(prefix)` when `kv.scan` is not available.
 *
 * Use this instead of `kv.list(prefix)` for potentially large key sets
 * (e.g. rate limit buckets, health samples) to avoid the O(N) KEYS command.
 */
export async function kvScanAll(kv: KVStore, match?: string): Promise<string[]> {
  if (typeof kv.scan !== "function") {
    // Fallback: derive prefix from match glob (strip trailing *)
    const prefix = match?.endsWith("*") ? match.slice(0, -1) : match;
    return kv.list(prefix);
  }

  // Safety: cap iterations to prevent infinite loops from a buggy backend
  // that never returns cursor "0". 10 000 × 100 keys/page = 1M keys max.
  const MAX_SCAN_ITERATIONS = 10_000;
  const all: string[] = [];
  let cursor = "0";
  let iterations = 0;
  do {
    const result = await kv.scan(cursor, { match, count: 100 });
    all.push(...result.keys);
    cursor = result.cursor;
    iterations++;
    if (iterations >= MAX_SCAN_ITERATIONS) {
      throw new Error(
        `kvScanAll: exceeded ${MAX_SCAN_ITERATIONS} iterations — possible infinite cursor loop`
      );
    }
  } while (cursor !== "0");
  return all;
}

// ── TenantKVStore ──────────────────────────────────────────────────
//
// Wraps the underlying singleton KVStore and transparently prefixes
// all keys with `tenant:<id>:` when a non-null tenantId is provided.
// For the default tenant (null), keys pass through unchanged.

class TenantKVStore implements KVStore {
  get kind() {
    return this.inner.kind;
  }
  private inner: KVStore;
  private tenantId: string | null;

  // HIGH-2: scan and mget are only defined when the inner store supports them.
  // This prevents callers from seeing these methods as available when they aren't.
  scan?: KVStore["scan"];
  mget?: KVStore["mget"];

  constructor(inner: KVStore, tenantId: string | null) {
    this.inner = inner;
    this.tenantId = tenantId;

    // Conditionally define scan/mget based on inner store capabilities
    if (typeof inner.scan === "function") {
      this.scan = async (
        cursor: string,
        opts?: { match?: string; count?: number }
      ): Promise<{ cursor: string; keys: string[] }> => {
        // Prefix the match pattern for the tenant namespace
        const prefixedMatch = opts?.match ? this.pk(opts.match) : this.pk("*");
        const result = await this.inner.scan!(cursor, { ...opts, match: prefixedMatch });
        // Strip tenant prefix from returned keys
        const tenantPrefix = this.tenantId ? `tenant:${this.tenantId}:` : "";
        const keys = tenantPrefix
          ? result.keys.map((k) => (k.startsWith(tenantPrefix) ? k.slice(tenantPrefix.length) : k))
          : result.keys;
        return { cursor: result.cursor, keys };
      };
    }

    if (typeof inner.mget === "function") {
      this.mget = async (keys: string[]): Promise<(string | null)[]> => {
        return this.inner.mget!(keys.map((k) => this.pk(k)));
      };
    }
  }

  private pk(key: string): string {
    return withTenantPrefix(key, this.tenantId);
  }

  get(key: string) {
    return this.inner.get(this.pk(key));
  }

  set(key: string, value: string) {
    return this.inner.set(this.pk(key), value);
  }

  delete(key: string) {
    return this.inner.delete(this.pk(key));
  }

  list(prefix?: string) {
    return this.inner.list(this.pk(prefix ?? ""));
  }

  incr(key: string, opts?: { ttlSeconds?: number }) {
    return this.inner.incr?.(this.pk(key), opts) ?? Promise.reject(new Error("incr not supported"));
  }

  lpushCapped(key: string, value: string, maxLength: number, opts?: { ttlSeconds?: number }) {
    return (
      this.inner.lpushCapped?.(this.pk(key), value, maxLength, opts) ??
      Promise.reject(new Error("lpushCapped not supported"))
    );
  }

  lrange(key: string, start: number, stop: number) {
    return this.inner.lrange?.(this.pk(key), start, stop) ?? Promise.resolve([]);
  }
}

/**
 * Get a KVStore scoped to a tenant. For null tenantId (default tenant),
 * keys pass through unchanged — identical to `getKVStore()`.
 */
export function getTenantKVStore(tenantId: string | null): KVStore {
  const inner = getKVStore();
  if (tenantId === null) return inner;
  return new TenantKVStore(inner, tenantId);
}
