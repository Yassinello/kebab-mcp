/**
 * LogStore — pluggable append-only log backend.
 *
 * Replaces the ad-hoc durable-log path in `logging.ts` that was bolted
 * onto KVStore via `log:<ts>:<tool>` keys + `list()`. That design had
 * O(N) KEYS/MGET fan-out per read and no retention. This module adds a
 * proper abstraction with three backends and a shared retention policy.
 *
 * Selection (mirrors `getKVStore`):
 * - Upstash env vars set → UpstashLogStore (LPUSH/LTRIM/LRANGE)
 * - VERCEL=1, no Upstash → MemoryLogStore (warned; ephemeral)
 * - else → FilesystemLogStore (./data/logs.jsonl, rotated at 10 MB)
 *
 * Retention:
 * - `MYMCP_LOG_MAX_ENTRIES` (default 500) — hard cap on entries kept
 * - `MYMCP_LOG_MAX_AGE_SECONDS` (optional) — TTL on Upstash list key
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { getKVStore } from "./kv-store";
import { hasUpstashCreds } from "./upstash-env";

export interface LogEntry {
  ts: number;
  level: "info" | "warn" | "error";
  message: string;
  meta?: Record<string, unknown>;
}

export interface LogStore {
  kind: "memory" | "filesystem" | "upstash";
  append(entry: LogEntry): Promise<void>;
  recent(n: number): Promise<LogEntry[]>;
  since(ts: number): Promise<LogEntry[]>;
}

function envMaxEntries(): number {
  const raw = process.env.MYMCP_LOG_MAX_ENTRIES;
  if (!raw) return 500;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 500;
}

function envMaxAgeSeconds(): number | undefined {
  const raw = process.env.MYMCP_LOG_MAX_AGE_SECONDS;
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function envRotateSegments(): number {
  const raw = process.env.MYMCP_LOG_ROTATE_SEGMENTS;
  if (!raw) return 3;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : 3;
}

// ── MemoryLogStore ──────────────────────────────────────────────────

export class MemoryLogStore implements LogStore {
  kind = "memory" as const;
  private buf: LogEntry[] = [];
  private max: number;
  constructor(maxEntries: number = envMaxEntries()) {
    this.max = maxEntries;
  }
  async append(entry: LogEntry): Promise<void> {
    this.buf.push(entry);
    if (this.buf.length > this.max) {
      this.buf.splice(0, this.buf.length - this.max);
    }
  }
  async recent(n: number): Promise<LogEntry[]> {
    const take = Math.max(0, Math.min(n, this.buf.length));
    return this.buf.slice(this.buf.length - take).reverse();
  }
  async since(ts: number): Promise<LogEntry[]> {
    return this.buf.filter((e) => e.ts >= ts).reverse();
  }
}

// ── FilesystemLogStore ──────────────────────────────────────────────

/**
 * JSONL append to `./data/logs.jsonl` with rotation at 10 MB.
 * Rotation strategy: cascading rename through N segments (configurable
 * via `MYMCP_LOG_ROTATE_SEGMENTS`, default 3). On rotation:
 *   current → .1, .1 → .2, …, .N-1 → .N, .N+1 deleted.
 * Reads walk all segments oldest-first to reconstruct the full timeline.
 */
export class FilesystemLogStore implements LogStore {
  kind = "filesystem" as const;
  private filePath: string;
  private maxBytes: number;
  private maxEntries: number;
  private segments: number;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    filePath: string,
    opts?: { maxBytes?: number; maxEntries?: number; segments?: number }
  ) {
    this.filePath = filePath;
    this.maxBytes = opts?.maxBytes ?? 10 * 1024 * 1024;
    this.maxEntries = opts?.maxEntries ?? envMaxEntries();
    this.segments = opts?.segments ?? envRotateSegments();
  }

  private segmentPath(i: number): string {
    return i === 0 ? this.filePath : `${this.filePath}.${i}`;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(() => fn());
    this.writeQueue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  private async rotateIfNeeded(): Promise<void> {
    try {
      const stat = await fs.stat(this.filePath);
      if (stat.size <= this.maxBytes) return;
    } catch {
      // file doesn't exist yet — nothing to rotate
      return;
    }

    // Cascade: .N-1 → .N, .N-2 → .N-1, …, current → .1
    // Delete segment beyond N (if it exists from a previous config with more segments).
    const overflowPath = `${this.filePath}.${this.segments + 1}`;
    await fs.unlink(overflowPath).catch(() => undefined);

    for (let i = this.segments; i >= 1; i--) {
      const src = i === 1 ? this.filePath : `${this.filePath}.${i - 1}`;
      const dst = `${this.filePath}.${i}`;
      await fs.rename(src, dst).catch(() => undefined);
    }
    // Current file has been renamed to .1; a fresh current will be created by appendFile.
  }

  async append(entry: LogEntry): Promise<void> {
    await this.enqueue(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await this.rotateIfNeeded();
      const line = JSON.stringify(entry) + "\n";
      await fs.appendFile(this.filePath, line, "utf-8");
    });
  }

  private async readAllLines(): Promise<LogEntry[]> {
    const read = async (p: string): Promise<LogEntry[]> => {
      try {
        const buf = await fs.readFile(p, "utf-8");
        return buf
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            try {
              return JSON.parse(line) as LogEntry;
            } catch {
              return null;
            }
          })
          .filter((e): e is LogEntry => e !== null);
      } catch {
        return [];
      }
    };
    // Read segments oldest-first: .N, .N-1, …, .1, current
    const segmentPaths: string[] = [];
    for (let i = this.segments; i >= 1; i--) {
      segmentPaths.push(`${this.filePath}.${i}`);
    }
    segmentPaths.push(this.filePath);

    const results = await Promise.all(segmentPaths.map(read));
    const all = results.flat();
    if (all.length > this.maxEntries) {
      return all.slice(all.length - this.maxEntries);
    }
    return all;
  }

  async recent(n: number): Promise<LogEntry[]> {
    // v0.6 MED-5: schedule the read through the same write queue so it
    // observes a consistent pre/post-rotation state. Without this a
    // concurrent append+rotate could have `rotated` moved out from under
    // the `Promise.all` read and return partial data.
    return this.enqueue(async () => {
      const all = await this.readAllLines();
      const take = Math.max(0, Math.min(n, all.length));
      return all.slice(all.length - take).reverse();
    });
  }

  async since(ts: number): Promise<LogEntry[]> {
    return this.enqueue(async () => {
      const all = await this.readAllLines();
      return all.filter((e) => e.ts >= ts).reverse();
    });
  }
}

// ── UpstashLogStore ─────────────────────────────────────────────────

/**
 * Circuit breaker state for UpstashLogStore.append().
 *
 * States:
 * - closed (normal): all requests go through.
 * - open: after `FAILURE_THRESHOLD` consecutive failures, skip all
 *   appends for `OPEN_DURATION_MS`, then transition to half-open.
 * - half-open: allow one probe attempt. If it succeeds → closed.
 *   If it fails → back to open for another OPEN_DURATION_MS.
 *
 * Reads (recent/since) are NOT retried and NOT circuit-broken — they
 * should fail fast so the dashboard can fall back to the memory buffer.
 */
interface CircuitBreakerState {
  consecutiveFailures: number;
  state: "closed" | "open" | "half-open";
  openedAt: number; // Date.now() when the circuit opened
}

const FAILURE_THRESHOLD = 5;
const OPEN_DURATION_MS = 30_000;
const RETRY_DELAYS_MS = [100, 400, 1600];

/**
 * Upstash Redis list. LPUSH + LTRIM in a single pipeline, LRANGE for
 * reads. Retention via `MYMCP_LOG_MAX_ENTRIES` (LTRIM length) and
 * optional `MYMCP_LOG_MAX_AGE_SECONDS` (EXPIRE).
 *
 * Covers N4 (MGET pagination for getDurableLogs): instead of scanning
 * keys and doing N round-trips, logs live in a single capped list and
 * reads are O(1) pipeline calls.
 *
 * Write path:
 * - Retries up to 3x with exponential backoff (100ms, 400ms, 1600ms)
 *   on HTTP 5xx errors.
 * - After 5 consecutive failures, opens a circuit breaker: all appends
 *   are silently skipped for 30s. Then half-open: one probe attempt.
 *   Success → close. Failure → re-open for 30s.
 * - When the circuit is open, `withLogging` must NOT cascade failure to
 *   the tool call — errors are swallowed (console.warn only).
 */
export class UpstashLogStore implements LogStore {
  kind = "upstash" as const;
  private listKey: string;
  private maxEntries: number;
  private maxAgeSeconds?: number;
  /** Exposed for testing. */
  _circuit: CircuitBreakerState = {
    consecutiveFailures: 0,
    state: "closed",
    openedAt: 0,
  };

  constructor(opts?: { listKey?: string; maxEntries?: number; maxAgeSeconds?: number }) {
    this.listKey = opts?.listKey ?? "mymcp:logs";
    this.maxEntries = opts?.maxEntries ?? envMaxEntries();
    this.maxAgeSeconds = opts?.maxAgeSeconds ?? envMaxAgeSeconds();
  }

  private shouldAllow(): boolean {
    const cb = this._circuit;
    if (cb.state === "closed") return true;
    if (cb.state === "open") {
      if (Date.now() - cb.openedAt >= OPEN_DURATION_MS) {
        cb.state = "half-open";
        return true;
      }
      return false;
    }
    // half-open: allow one probe
    return true;
  }

  private recordSuccess(): void {
    this._circuit.consecutiveFailures = 0;
    this._circuit.state = "closed";
  }

  private recordFailure(): void {
    const cb = this._circuit;
    cb.consecutiveFailures++;
    if (cb.state === "half-open" || cb.consecutiveFailures >= FAILURE_THRESHOLD) {
      cb.state = "open";
      cb.openedAt = Date.now();
    }
  }

  async append(entry: LogEntry): Promise<void> {
    if (!this.shouldAllow()) {
      console.warn("[Kebab MCP] UpstashLogStore: circuit open, skipping append");
      return;
    }

    const kv = getKVStore();
    if (typeof kv.lpushCapped !== "function") {
      throw new Error("UpstashLogStore requires KVStore.lpushCapped");
    }
    const line = JSON.stringify(entry);

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        await kv.lpushCapped(this.listKey, line, this.maxEntries, {
          ttlSeconds: this.maxAgeSeconds,
        });
        this.recordSuccess();
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // Only retry on 5xx-like errors (Upstash errors contain status in message)
        const is5xx = lastError.message.includes("5");
        if (!is5xx || attempt >= RETRY_DELAYS_MS.length) {
          break;
        }
        await sleep(RETRY_DELAYS_MS[attempt]);
      }
    }

    this.recordFailure();
    // Swallow — withLogging must not cascade log-store failures to tool calls.
    console.warn(
      `[Kebab MCP] UpstashLogStore: append failed after retries (failures=${this._circuit.consecutiveFailures}):`,
      lastError?.message
    );
  }

  async recent(n: number): Promise<LogEntry[]> {
    const kv = getKVStore();
    if (typeof kv.lrange !== "function") {
      throw new Error("UpstashLogStore requires KVStore.lrange");
    }
    const take = Math.min(n, this.maxEntries);
    const raw = await kv.lrange(this.listKey, 0, take - 1);
    return raw
      .map((line) => {
        try {
          return JSON.parse(line) as LogEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is LogEntry => e !== null);
  }

  async since(ts: number): Promise<LogEntry[]> {
    // LPUSH-ordered list: head is newest. Walk from head until ts < cutoff.
    // Retention cap bounds the worst case.
    //
    // Optimization (TECH-04): The list is in reverse chronological order
    // (newest first). Instead of filtering all entries, we binary search
    // for the cutoff index where entries become older than `ts`, then
    // slice. This avoids returning entries past the threshold while still
    // reading the full list from Redis — acceptable for <=10k entries.
    // A true cursor-based approach would require sorted sets (ZRANGEBYSCORE).
    const all = await this.recent(this.maxEntries);
    if (all.length === 0) return all;

    // Binary search: find the rightmost index where entry.ts >= ts.
    // The list is sorted newest-first, so ts values decrease with index.
    let lo = 0;
    let hi = all.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (all[mid].ts >= ts) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    // lo = first index where ts < threshold. Slice [0, lo).
    return all.slice(0, lo);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Factory ──────────────────────────────────────────────────────────

let cached: LogStore | null = null;

export function getLogStore(): LogStore {
  if (cached) return cached;

  if (hasUpstashCreds()) {
    cached = new UpstashLogStore();
    return cached;
  }

  if (process.env.VERCEL === "1") {
    console.warn(
      "[Kebab MCP] LogStore: running on Vercel without UPSTASH_REDIS_REST_URL/TOKEN " +
        "(or KV_REST_API_URL/TOKEN for Vercel Marketplace setups) — " +
        "using MemoryLogStore (ephemeral, lost on cold start)."
    );
    cached = new MemoryLogStore();
    return cached;
  }

  cached = new FilesystemLogStore(path.resolve(process.cwd(), "data", "logs.jsonl"));
  return cached;
}

/** Test-only: reset the cached instance. */
export function resetLogStoreCache(): void {
  cached = null;
}

/**
 * Clear the in-memory buffer of the current LogStore instance.
 * For MemoryLogStore this empties the ring buffer. For other backends
 * this is a no-op (they don't buffer locally).
 */
export function clearLogStoreBuffer(): void {
  if (!cached) return;
  if (cached.kind === "memory") {
    const mem = cached as unknown as { buf: unknown[] };
    if (Array.isArray(mem.buf)) {
      mem.buf.length = 0;
    }
  }
}
