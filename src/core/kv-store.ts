/**
 * KVStore — pluggable key/value storage abstraction.
 *
 * Two implementations:
 * - FilesystemKV: writes to `./data/kv.json` (or `/tmp/mymcp-kv.json` on Vercel
 *   when Upstash is not configured). Atomic write via tmp + rename. All keys
 *   live in a single JSON map for simplicity. TTLs are honoured and
 *   ephemeral writes are coalesced (see the class comment).
 * - UpstashKV: optional production backend using Upstash Redis REST API.
 *   Activates when Upstash credentials are available via `getUpstashCreds()`
 *   (DUR-06). Supports both UPSTASH_REDIS_REST_* (manual setup) and
 *   KV_REST_API_* (Vercel Marketplace) naming variants.
 *   Uses raw fetch() — no @upstash/redis dep (keeps bundle small).
 *
 * Selection rules:
 * - If Upstash env vars present → UpstashKV
 * - Else if process.env.VERCEL === "1" → FilesystemKV at /tmp (ephemeral, warned)
 * - Else → FilesystemKV at ./data/kv.json
 */

import { promises as fs, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { withTenantPrefix } from "./tenant";
import { getUpstashCreds, hasUpstashCreds } from "./upstash-env";
import { withSpan, isTracingActive } from "./tracing";
import { toMsg } from "./error-utils";

// ── OBS-02: in-process KV latency ring buffer ───────────────────────
//
// Populated by pingKV() + any future per-operation tracing hook; read
// by /api/admin/status. Capped at 20 samples so the buffer never grows
// unbounded in a long-running process.

export interface KVLatencySample {
  at: string;
  op: string;
  durationMs: number;
}

const MAX_KV_LATENCY_SAMPLES = 20;
const kvLatencyBuffer: KVLatencySample[] = [];

/** Test-only: clear the ring buffer. */
export function __resetKVLatencyBufferForTests(): void {
  kvLatencyBuffer.length = 0;
}

/** Returns a copy of the ring buffer — newest samples at the end. */
export function getKVLatencySamples(): KVLatencySample[] {
  return [...kvLatencyBuffer];
}

function recordKVLatency(op: string, durationMs: number): void {
  kvLatencyBuffer.push({ at: new Date().toISOString(), op, durationMs });
  if (kvLatencyBuffer.length > MAX_KV_LATENCY_SAMPLES) {
    kvLatencyBuffer.shift();
  }
}

export interface KVStore {
  kind: "filesystem" | "upstash";
  get(key: string): Promise<string | null>;
  /**
   * Set a key/value pair. Optional `ttlSeconds` is honored on Upstash
   * (via `SET key value EX ttl`) and on the filesystem backend (lazy
   * expiry on read + periodic sweep). A set without TTL clears any
   * previous expiry, as on Redis.
   */
  set(key: string, value: string, ttlSeconds?: number | undefined): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string | undefined): Promise<string[]>;
  /**
   * Atomically increment a counter key and (optionally) set its TTL.
   * Returns the post-increment value.
   *
   * Upstash path is genuinely atomic (pipelined INCR + EXPIRE). The
   * filesystem path is read-modify-write under the existing write queue
   * (in memory, written behind) — single-process only, racy across
   * processes sharing the same file.
   *
   * Used by the rate limiter to avoid the classic get-then-set race
   * (two concurrent callers both reading `N` and both writing `N+1`).
   */
  incr?(key: string, opts?: { ttlSeconds?: number | undefined }): Promise<number>;
  /**
   * Atomic set-if-not-exists (SETNX). Returns `{ ok: true }` when the
   * key was written or `{ ok: false, existing }` when the key already
   * holds a value (which is returned alongside).
   *
   * Upstash path uses `SET key value NX EX ttl` — genuinely atomic.
   * FilesystemKV checks and writes under its write queue (atomic within
   * one process; an expired key counts as absent). The production race
   * path is Upstash. MemoryKV uses a simple Map.has guard.
   *
   * Phase 45 UX-04: used by `flushBootstrapToKvIfAbsent()` to close
   * the T11 welcome-init mint race — two browsers sharing a claim
   * cookie otherwise both overwrite the KV bootstrap key silently.
   */
  setIfNotExists?(
    key: string,
    value: string,
    opts?: { ttlSeconds?: number | undefined }
  ): Promise<{ ok: true } | { ok: false; existing: string }>;
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
    opts?: { match?: string | undefined; count?: number | undefined }
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
    opts?: { ttlSeconds?: number | undefined }
  ): Promise<void>;
  /** Read a range from a list (head-indexed, inclusive). */
  lrange?(key: string, start: number, stop: number): Promise<string[]>;
}

// ── FilesystemKV ────────────────────────────────────────────────────
//
// On disk: one JSON object. A value is either a plain string (no expiry —
// the historical format, so files written by older versions load as-is) or
// `{ "v": "<value>", "exp": <epoch ms> }` when it was written with a TTL.
//
// B4 (2026-11 audit):
//   - TTLs are honoured: an expired key reads as absent (lazy expiry) and
//     expired keys are swept from the file at most once a minute, when the
//     file is written anyway. Before, expired OAuth tokens, registered
//     clients and approval previews stayed in data/kv.json forever.
//   - The parsed file stays in memory and is re-read only when another
//     process changed it (mtime/size check), instead of re-parsing the whole
//     file every 500 ms.
//   - Durable writes (`set` without TTL, `delete`, `setIfNotExists`) resolve
//     once the file is on disk; concurrent ones share a single write.
//     Ephemeral writes (`incr`, `set` with a TTL: counters, rate-limit
//     buckets, short-lived tokens) are written behind, within
//     `DEFERRED_FLUSH_MS`, and flushed when the process exits. A crash can
//     lose at most that window of ephemeral data.

type StoredValue = string | { v: string; exp: number };

function isLive(sv: StoredValue | undefined, now: number): sv is StoredValue {
  if (sv === undefined) return false;
  return typeof sv === "string" || !(typeof sv.exp === "number" && sv.exp <= now);
}

function liveValue(sv: StoredValue | undefined, now: number): string | null {
  if (!isLive(sv, now)) return null;
  if (typeof sv === "string") return sv;
  return typeof sv.v === "string" ? sv.v : null;
}

function withTtl(value: string, ttlSeconds: number | undefined, now: number): StoredValue {
  return ttlSeconds && ttlSeconds > 0
    ? { v: value, exp: now + Math.ceil(ttlSeconds * 1000) }
    : value;
}

/** Ephemeral writes reach the disk within this delay. */
const DEFERRED_FLUSH_MS = 200;
/** Expired keys are removed from the file at most this often. */
const SWEEP_INTERVAL_MS = 60_000;

/** Stores holding unflushed ephemeral writes — flushed synchronously on exit. */
const pendingStores = new Set<FilesystemKV>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  if (typeof process === "undefined" || typeof process.once !== "function") return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const store of pendingStores) store.flushSync();
  });
}

class FilesystemKV implements KVStore {
  kind = "filesystem" as const;
  private filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();
  /** Authoritative in-memory copy of the file once loaded. */
  private data: Record<string, StoredValue> | null = null;
  /** mtime/size of the file as last read or written: detects other writers. */
  private diskStamp: { mtimeMs: number; size: number } | null = null;
  private loading: Promise<Record<string, StoredValue>> | null = null;
  /** In-memory changes not yet on disk. */
  private dirty = false;
  /**
   * Keys changed (set or deleted) since the last write. Next.js loads this
   * module once per route bundle, so several FilesystemKV instances can share
   * one file in the same process: a write merges only these keys into the
   * current file instead of overwriting what the other instances wrote.
   */
  private dirtyKeys = new Set<string>();
  private writing = false;
  private reloadRequested = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushChain: Promise<void> = Promise.resolve();
  private flushPending: Promise<void> | null = null;
  private lastSweep = 0;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /**
   * Compat with `clearKVReadCache()` (duck-typed `cache = null`): forces the
   * next read to go to disk. Pending writes are flushed first, never dropped.
   */
  get cache(): unknown {
    return this.data;
  }
  set cache(v: unknown) {
    if (v === null) this.reloadRequested = true;
  }

  private async load(): Promise<Record<string, StoredValue>> {
    if (this.reloadRequested) {
      this.reloadRequested = false;
      if (this.dirty) await this.flush();
      if (!this.dirty && !this.writing) {
        this.data = null;
        this.diskStamp = null;
      }
    }
    // Unflushed changes, or a write in flight: memory is the truth.
    if (this.data && (this.dirty || this.writing)) return this.data;
    if (this.loading) return this.loading;
    this.loading = this.loadFromDisk().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async loadFromDisk(): Promise<Record<string, StoredValue>> {
    let stamp: { mtimeMs: number; size: number };
    try {
      const st = await fs.stat(this.filePath);
      stamp = { mtimeMs: st.mtimeMs, size: st.size };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        if (this.data && (this.dirty || this.writing)) return this.data;
        this.data = {};
        this.diskStamp = null;
        return this.data;
      }
      return this.data ?? {};
    }
    if (
      this.data &&
      this.diskStamp &&
      this.diskStamp.mtimeMs === stamp.mtimeMs &&
      this.diskStamp.size === stamp.size
    ) {
      return this.data;
    }
    let map: Record<string, StoredValue> = {};
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.filePath, "utf-8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        map = parsed as Record<string, StoredValue>;
      }
    } catch {
      // silent-swallow-ok: unreadable file — same as before, behave as empty.
    }
    // A mutation may have landed while we were reading: keep it.
    if (this.data && (this.dirty || this.writing)) return this.data;
    this.data = map;
    this.diskStamp = stamp;
    return map;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(() => fn());
    this.writeQueue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  /**
   * Apply `fn` to the in-memory map under the write queue, then persist:
   * awaited for durable writes, written behind for ephemeral ones.
   */
  private async mutate<T>(
    fn: (map: Record<string, StoredValue>, now: number) => { result: T; changed: boolean },
    durable: boolean
  ): Promise<T> {
    const { result, changed } = await this.enqueue(async () => {
      const map = await this.load();
      const out = fn(map, Date.now());
      if (out.changed) this.dirty = true;
      return out;
    });
    if (changed) {
      if (durable) await this.flush();
      else this.scheduleFlush();
    }
    return result;
  }

  private scheduleFlush(): void {
    pendingStores.add(this);
    installExitHook();
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch((err: unknown) => {
        console.warn(
          `[Kebab MCP] KVStore: deferred write to ${this.filePath} failed: ${toMsg(err)}`
        );
      });
    }, DEFERRED_FLUSH_MS);
    this.flushTimer.unref?.();
  }

  /** Write the in-memory state to disk. Callers arriving together share one write. */
  flush(): Promise<void> {
    if (this.flushPending) return this.flushPending;
    const run = this.flushChain.then(() => {
      this.flushPending = null;
      return this.writeNow();
    });
    this.flushPending = run;
    this.flushChain = run.catch(() => undefined);
    return run;
  }

  private sweep(map: Record<string, StoredValue>, now: number): void {
    for (const k of Object.keys(map)) {
      if (!isLive(map[k], now)) {
        delete map[k];
        this.dirtyKeys.add(k);
      }
    }
  }

  private async writeNow(): Promise<void> {
    if (!this.dirty || !this.data) return;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const now = Date.now();
    if (now - this.lastSweep >= SWEEP_INTERVAL_MS) {
      this.sweep(this.data, now);
      this.lastSweep = now;
    }
    this.writing = true;
    // Another instance wrote the file since we last read it: merge our
    // changed keys into its current content rather than overwrite it.
    try {
      const st = await fs.stat(this.filePath);
      if (
        !this.diskStamp ||
        st.mtimeMs !== this.diskStamp.mtimeMs ||
        st.size !== this.diskStamp.size
      ) {
        this.data = this.mergeInto(await fs.readFile(this.filePath, "utf-8"));
      }
    } catch {
      // silent-swallow-ok: no file yet (or unreadable) — our copy is the content.
    }
    // Serialised synchronously: the snapshot holds every change made so far.
    const json = JSON.stringify(this.data, null, 2);
    this.dirty = false;
    const written = new Set(this.dirtyKeys);
    this.dirtyKeys.clear();
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${randomBytes(4).toString("hex")}.tmp`;
      await fs.writeFile(tmp, json, "utf-8");
      await fs.rename(tmp, this.filePath);
      const st = await fs.stat(this.filePath);
      this.diskStamp = { mtimeMs: st.mtimeMs, size: st.size };
    } catch (err) {
      this.dirty = true;
      for (const k of written) this.dirtyKeys.add(k);
      throw err;
    } finally {
      this.writing = false;
      if (!this.dirty) pendingStores.delete(this);
    }
  }

  /** The file's current content with this instance's changed keys applied. */
  private mergeInto(raw: string): Record<string, StoredValue> {
    let disk: Record<string, StoredValue> = {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        disk = parsed as Record<string, StoredValue>;
      }
    } catch {
      return this.data ?? {};
    }
    const mine = this.data ?? {};
    for (const k of this.dirtyKeys) {
      if (k in mine) disk[k] = mine[k] as StoredValue;
      else delete disk[k];
    }
    return disk;
  }

  /** Synchronous flush (process exit, test reset). Never creates the folder. */
  flushSync(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    pendingStores.delete(this);
    if (!this.dirty || !this.data) return;
    try {
      try {
        this.data = this.mergeInto(readFileSync(this.filePath, "utf-8"));
      } catch {
        // silent-swallow-ok: no file yet — our copy is the content.
      }
      const tmp = `${this.filePath}.${randomBytes(4).toString("hex")}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf-8");
      renameSync(tmp, this.filePath);
      this.dirty = false;
      this.dirtyKeys.clear();
    } catch {
      // silent-swallow-ok: best effort — the process is going away (or the test folder is gone).
    }
  }

  async get(key: string): Promise<string | null> {
    // Drain any queued mutation so the caller sees the latest state.
    await this.writeQueue;
    const map = await this.load();
    return liveValue(map[key], Date.now());
  }

  // Durable even with a TTL: other route bundles (separate instances on the
  // same file) must see e.g. a just-registered OAuth client on the next request.
  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    await this.mutate((map, now) => {
      map[key] = withTtl(value, ttlSeconds, now);
      this.dirtyKeys.add(key);
      return { result: undefined, changed: true };
    }, true);
  }

  /**
   * SETNX for the single-JSON-map filesystem backend: checked and written
   * under the write queue (atomic within this process). An expired key
   * counts as absent. Cross-process races on the same file stay possible —
   * production deployments that need them run on Upstash.
   */
  async setIfNotExists(
    key: string,
    value: string,
    opts?: { ttlSeconds?: number | undefined }
  ): Promise<{ ok: true } | { ok: false; existing: string }> {
    return this.mutate<{ ok: true } | { ok: false; existing: string }>((map, now) => {
      const current = liveValue(map[key], now);
      if (current !== null) return { result: { ok: false, existing: current }, changed: false };
      map[key] = withTtl(value, opts?.ttlSeconds, now);
      this.dirtyKeys.add(key);
      return { result: { ok: true }, changed: true };
    }, true);
  }

  async delete(key: string): Promise<void> {
    await this.mutate((map) => {
      if (!(key in map)) return { result: undefined, changed: false };
      delete map[key];
      this.dirtyKeys.add(key);
      return { result: undefined, changed: true };
    }, true);
  }

  private async liveKeys(): Promise<string[]> {
    await this.writeQueue;
    const map = await this.load();
    const now = Date.now();
    return Object.keys(map).filter((k) => isLive(map[k], now));
  }

  async list(prefix?: string): Promise<string[]> {
    const keys = await this.liveKeys();
    return prefix ? keys.filter((k) => k.startsWith(prefix)) : keys;
  }

  async scan(
    cursor: string,
    opts?: { match?: string; count?: number }
  ): Promise<{ cursor: string; keys: string[] }> {
    const allKeys = await this.liveKeys();

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
    const map = await this.load();
    const now = Date.now();
    return keys.map((k) => liveValue(map[k], now));
  }

  // Read-modify-write under the write queue, written behind (counters are
  // ephemeral). Same semantics as Redis INCR (+ EXPIRE when a TTL is given):
  // an expired counter restarts at 1, a counter without a new TTL keeps its
  // current expiry.
  //
  // TECH-06 lazy prune: after incrementing, drop `ratelimit:*` buckets whose
  // timestamp is older than 2× ttlSeconds ago.
  async incr(key: string, opts?: { ttlSeconds?: number | undefined }): Promise<number> {
    return this.mutate((map, now) => {
      const current = map[key];
      const prev = parseInt(liveValue(current, now) ?? "0", 10);
      const next = Number.isFinite(prev) ? prev + 1 : 1;
      if (opts?.ttlSeconds && opts.ttlSeconds > 0) {
        map[key] = withTtl(String(next), opts.ttlSeconds, now);
      } else if (current !== undefined && typeof current !== "string" && isLive(current, now)) {
        map[key] = { v: String(next), exp: current.exp };
      } else {
        map[key] = String(next);
      }
      this.dirtyKeys.add(key);

      if (opts?.ttlSeconds && opts.ttlSeconds > 0) {
        const windowMs = 60_000; // rate limiter uses 1-minute buckets
        const currentBucket = Math.floor(now / windowMs);
        // A bucket is stale if its timestamp is older than 2× the TTL window
        const staleBefore = currentBucket - Math.ceil((opts.ttlSeconds * 1000) / windowMs);
        for (const k of Object.keys(map)) {
          if (!k.startsWith("ratelimit:")) continue;
          const parts = k.split(":");
          const bucketStr = parts[parts.length - 1] ?? "";
          const bucket = parseInt(bucketStr, 10);
          if (Number.isFinite(bucket) && bucket < staleBefore) {
            delete map[k];
            this.dirtyKeys.add(k);
          }
        }
      }
      return { result: next, changed: true };
    }, false);
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
const UPSTASH_TIMEOUT_MS = 8_000;

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
      // REL-09: bounded — a slow Upstash must not hold the request until the
      // platform's maxDuration kills it.
      signal: AbortSignal.timeout(UPSTASH_TIMEOUT_MS),
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

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds && ttlSeconds > 0) {
      // SET key value EX ttl
      await this.call(["SET", key, value, "EX", Math.ceil(ttlSeconds)]);
    } else {
      await this.call(["SET", key, value]);
    }
  }

  /**
   * Native atomic SETNX via Upstash. `SET key value NX` returns "OK"
   * on success and null when the key already exists. On the loser
   * branch we issue a GET to surface the existing value — the caller
   * uses this to decide how to surface the race to the user (Phase 45
   * UX-04 → 409 `already_minted` with the winner's bootstrap
   * visible only to the server).
   *
   * TTL is chained via `EX` in the same command so expiration and
   * existence-check are atomic — no two-phase window where the key
   * is set without a TTL.
   */
  async setIfNotExists(
    key: string,
    value: string,
    opts?: { ttlSeconds?: number | undefined }
  ): Promise<{ ok: true } | { ok: false; existing: string }> {
    const cmd: (string | number)[] = ["SET", key, value, "NX"];
    if (opts?.ttlSeconds && opts.ttlSeconds > 0) {
      cmd.push("EX", Math.ceil(opts.ttlSeconds));
    }
    const result = await this.call(cmd);
    if (result === "OK") return { ok: true };
    // Lost the race — read the winner's value. The GET is a second
    // round-trip; acceptable because the race is a rare one-shot
    // event per instance (the first-run claim cookie).
    const existing = await this.get(key);
    return { ok: false, existing: existing ?? "" };
  }

  async delete(key: string): Promise<void> {
    await this.call(["DEL", key]);
  }

  async list(prefix?: string): Promise<string[]> {
    // REL-09 (2026-11 audit): iterate with SCAN instead of KEYS. KEYS is
    // O(keyspace) and blocks the Redis server for its whole duration; it was
    // on the hot path (disabled-tool lookups, webhook history, audit lists).
    const pattern = prefix ? `${prefix}*` : "*";
    const seen = new Set<string>();
    let cursor = "0";
    let guard = 0;
    do {
      const page = await this.scan(cursor, { match: pattern, count: 500 });
      for (const k of page.keys) seen.add(k);
      cursor = page.cursor;
      guard++;
    } while (cursor !== "0" && guard < 10_000);
    return [...seen];
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
  async incr(key: string, opts?: { ttlSeconds?: number | undefined }): Promise<number> {
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
    if (!incrResult) throw new Error("Upstash INCR returned no result");
    if (incrResult.error) throw new Error(`Upstash INCR error: ${incrResult.error}`);
    const n = typeof incrResult.result === "number" ? incrResult.result : Number(incrResult.result);
    if (!Number.isFinite(n)) throw new Error("Upstash INCR returned non-numeric result");
    return n;
  }

  async lpushCapped(
    key: string,
    value: string,
    maxLength: number,
    opts?: { ttlSeconds?: number | undefined }
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
/** The unwrapped store behind `cached` (the tracing wrapper hides its class). */
let cachedBase: KVStore | null = null;

// OBS-04 + Phase 50 / BRAND-03: wrap the underlying store so every
// set/setNx/delete emits a `kebab.kv.write` span with op + key_prefix
// (first 2 segments only — no full-key leak) + kind. Reads stay
// untraced (high volume, low diagnostic signal per span). Zero
// overhead when tracing is off. withSpan() normalizes the name
// via brandSpanName() and brand-namespaces attrs via brandSpanAttrs().
function keyPrefix2(key: string): string {
  const parts = key.split(":");
  return parts.slice(0, 2).join(":");
}

function wrapWithTracing(kv: KVStore): KVStore {
  const wrapped: KVStore = {
    kind: kv.kind,
    get: kv.get.bind(kv),
    set: (key, value, ttlSeconds) =>
      withSpan("kv.write", () => kv.set(key, value, ttlSeconds), {
        "kv.kind": kv.kind,
        "kv.op": "set",
        "kv.key_prefix": keyPrefix2(key),
      }),
    delete: (key) =>
      withSpan("kv.write", () => kv.delete(key), {
        "kv.kind": kv.kind,
        "kv.op": "delete",
        "kv.key_prefix": keyPrefix2(key),
      }),
    list: kv.list.bind(kv),
  };
  if (typeof kv.incr === "function") {
    wrapped.incr = (key, opts) =>
      withSpan("kv.write", () => kv.incr!(key, opts), {
        "kv.kind": kv.kind,
        "kv.op": "incr",
        "kv.key_prefix": keyPrefix2(key),
      });
  }
  if (typeof kv.setIfNotExists === "function") {
    wrapped.setIfNotExists = (key, value, opts) =>
      withSpan("kv.write", () => kv.setIfNotExists!(key, value, opts), {
        "kv.kind": kv.kind,
        "kv.op": "setIfNotExists",
        "kv.key_prefix": keyPrefix2(key),
      });
  }
  if (typeof kv.scan === "function") wrapped.scan = kv.scan.bind(kv);
  if (typeof kv.mget === "function") wrapped.mget = kv.mget.bind(kv);
  if (typeof kv.lpushCapped === "function") {
    wrapped.lpushCapped = (key, value, maxLength, opts) =>
      withSpan("kv.write", () => kv.lpushCapped!(key, value, maxLength, opts), {
        "kv.kind": kv.kind,
        "kv.op": "lpushCapped",
        "kv.key_prefix": keyPrefix2(key),
      });
  }
  if (typeof kv.lrange === "function") wrapped.lrange = kv.lrange.bind(kv);
  return wrapped;
}

function buildKVStore(): KVStore {
  const creds = getUpstashCreds();
  if (creds) return new UpstashKV(creds.url, creds.token);
  if (process.env.VERCEL === "1") {
    console.warn(
      "[Kebab MCP] KVStore: running on Vercel without UPSTASH_REDIS_REST_URL/TOKEN " +
        "(or KV_REST_API_URL/TOKEN for Vercel Marketplace setups) — " +
        "using /tmp filesystem (ephemeral, data lost on cold start). " +
        "Set Upstash env vars for persistence."
    );
    return new FilesystemKV("/tmp/mymcp-kv.json");
  }
  // Allow test overrides via MYMCP_KV_PATH (used by store-versioning tests
  // to point at a unique temp file per test, preventing cross-test state leak).
  const kvPath = process.env.MYMCP_KV_PATH?.trim();
  return new FilesystemKV(kvPath || path.resolve(process.cwd(), "data", "kv.json"));
}

export function getKVStore(): KVStore {
  if (cached) return cached;
  const base = buildKVStore();
  cachedBase = base;
  cached = isTracingActive() ? wrapWithTracing(base) : base;
  return cached;
}

/** Reset the cached instance (pending filesystem writes are flushed first). Test-only. */
export function resetKVStoreCache(): void {
  if (cachedBase instanceof FilesystemKV) cachedBase.flushSync();
  cached = null;
  cachedBase = null;
}

/**
 * Write any pending (written-behind) filesystem KV changes to disk now.
 * No-op on Upstash. Useful before a planned shutdown or in tests.
 */
export async function flushKVWrites(): Promise<void> {
  if (cachedBase instanceof FilesystemKV) await cachedBase.flush();
}

/**
 * Clear the in-memory read cache of the current KVStore instance.
 * For FilesystemKV this drops the parsed-JSON cache so the next read
 * goes to disk. For UpstashKV this is a no-op (no local cache).
 */
export function clearKVReadCache(): void {
  const store = cachedBase ?? cached;
  if (!store) return;
  // FilesystemKV exposes a `cache` accessor (assigning null forces a re-read
  // from disk, after flushing pending writes); UpstashKV does not.
  // Use a duck-type check to avoid coupling to class internals.
  const fs = store as unknown as { cache: unknown };
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
  scan?: NonNullable<KVStore["scan"]>;
  mget?: NonNullable<KVStore["mget"]>;

  constructor(inner: KVStore, tenantId: string | null) {
    this.inner = inner;
    this.tenantId = tenantId;

    // Conditionally define scan/mget based on inner store capabilities
    if (typeof inner.scan === "function") {
      this.scan = async (
        cursor: string,
        opts?: { match?: string | undefined; count?: number | undefined }
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

  set(key: string, value: string, ttlSeconds?: number | undefined) {
    return this.inner.set(this.pk(key), value, ttlSeconds);
  }

  delete(key: string) {
    return this.inner.delete(this.pk(key));
  }

  async list(prefix?: string | undefined): Promise<string[]> {
    const keys = await this.inner.list(this.pk(prefix ?? ""));
    // Strip the tenant prefix so callers see bare keys — same contract as
    // scan(). Without this, tenant-scoped consumers that do
    // `key.slice(PREFIX.length)` (e.g. tool-toggles) get garbled names and
    // silently fail (HIGH-1: disabled tools stayed callable per tenant).
    const tenantPrefix = this.tenantId ? `tenant:${this.tenantId}:` : "";
    return tenantPrefix
      ? keys.map((k) => (k.startsWith(tenantPrefix) ? k.slice(tenantPrefix.length) : k))
      : keys;
  }

  incr(key: string, opts?: { ttlSeconds?: number | undefined }) {
    return this.inner.incr?.(this.pk(key), opts) ?? Promise.reject(new Error("incr not supported"));
  }

  setIfNotExists(key: string, value: string, opts?: { ttlSeconds?: number | undefined }) {
    return (
      this.inner.setIfNotExists?.(this.pk(key), value, opts) ??
      Promise.reject(new Error("setIfNotExists not supported"))
    );
  }

  lpushCapped(
    key: string,
    value: string,
    maxLength: number,
    opts?: { ttlSeconds?: number | undefined }
  ) {
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

// ── OBS-01 / OBS-02: KV reachability + latency helpers ─────────────

/**
 * True when the active KV backend is cross-instance durable (Upstash or
 * a non-Vercel filesystem). Mirrors the old `isExternalKvAvailable`
 * helper in first-run.ts — exposed here so callers outside first-run
 * (e.g. /api/health) can make the same distinction without pulling in
 * first-run's module.
 */
export function isExternalKvAvailable(): boolean {
  if (hasUpstashCreds()) return true;
  if (process.env.VERCEL !== "1") return true;
  return false;
}

/**
 * 1-second reachability probe for the current KV backend. Returns
 * `reachable: true` immediately for filesystem/memory backends (no
 * network round-trip). For Upstash, issues a lightweight GET against a
 * well-known key (null result is fine — we only care that the command
 * returned) and hard-caps the probe at 1 second so /api/health itself
 * cannot hang.
 *
 * Records a latency sample on success (consumed by OBS-02).
 */
export async function pingKV(): Promise<{ reachable: boolean; latencyMs?: number }> {
  const kv = getKVStore();
  if (kv.kind !== "upstash") {
    return { reachable: true, latencyMs: 0 };
  }
  const started = Date.now();
  try {
    await Promise.race([
      kv.get("mymcp:health:ping"),
      new Promise<null>((_, reject) =>
        setTimeout(() => reject(new Error("kv-ping-timeout-1s")), 1000)
      ),
    ]);
    const latencyMs = Date.now() - started;
    recordKVLatency("ping", latencyMs);
    return { reachable: true, latencyMs };
  } catch {
    return { reachable: false };
  }
}
