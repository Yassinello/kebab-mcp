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
 * Rotation strategy: rename `logs.jsonl` → `logs.jsonl.1` (overwriting
 * any existing .1) and start a fresh file. We only keep one rotated
 * segment to bound disk use in dev; production should use Upstash.
 */
export class FilesystemLogStore implements LogStore {
  kind = "filesystem" as const;
  private filePath: string;
  private rotatedPath: string;
  private maxBytes: number;
  private maxEntries: number;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string, opts?: { maxBytes?: number; maxEntries?: number }) {
    this.filePath = filePath;
    this.rotatedPath = `${filePath}.1`;
    this.maxBytes = opts?.maxBytes ?? 10 * 1024 * 1024;
    this.maxEntries = opts?.maxEntries ?? envMaxEntries();
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
      if (stat.size > this.maxBytes) {
        await fs.rename(this.filePath, this.rotatedPath).catch(() => undefined);
      }
    } catch {
      // file doesn't exist yet — nothing to rotate
    }
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
    // Rotated segment is older; concat rotated → current.
    const [rotated, current] = await Promise.all([read(this.rotatedPath), read(this.filePath)]);
    const all = [...rotated, ...current];
    if (all.length > this.maxEntries) {
      return all.slice(all.length - this.maxEntries);
    }
    return all;
  }

  async recent(n: number): Promise<LogEntry[]> {
    await this.writeQueue;
    const all = await this.readAllLines();
    const take = Math.max(0, Math.min(n, all.length));
    return all.slice(all.length - take).reverse();
  }

  async since(ts: number): Promise<LogEntry[]> {
    await this.writeQueue;
    const all = await this.readAllLines();
    return all.filter((e) => e.ts >= ts).reverse();
  }
}

// ── UpstashLogStore ─────────────────────────────────────────────────

/**
 * Upstash Redis list. LPUSH + LTRIM in a single pipeline, LRANGE for
 * reads. Retention via `MYMCP_LOG_MAX_ENTRIES` (LTRIM length) and
 * optional `MYMCP_LOG_MAX_AGE_SECONDS` (EXPIRE).
 *
 * Covers N4 (MGET pagination for getDurableLogs): instead of scanning
 * keys and doing N round-trips, logs live in a single capped list and
 * reads are O(1) pipeline calls.
 */
export class UpstashLogStore implements LogStore {
  kind = "upstash" as const;
  private listKey: string;
  private maxEntries: number;
  private maxAgeSeconds?: number;

  constructor(opts?: { listKey?: string; maxEntries?: number; maxAgeSeconds?: number }) {
    this.listKey = opts?.listKey ?? "mymcp:logs";
    this.maxEntries = opts?.maxEntries ?? envMaxEntries();
    this.maxAgeSeconds = opts?.maxAgeSeconds ?? envMaxAgeSeconds();
  }

  async append(entry: LogEntry): Promise<void> {
    const kv = getKVStore();
    if (typeof kv.lpushCapped !== "function") {
      throw new Error("UpstashLogStore requires KVStore.lpushCapped");
    }
    const line = JSON.stringify(entry);
    await kv.lpushCapped(this.listKey, line, this.maxEntries, {
      ttlSeconds: this.maxAgeSeconds,
    });
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
    const all = await this.recent(this.maxEntries);
    return all.filter((e) => e.ts >= ts);
  }
}

// ── Factory ──────────────────────────────────────────────────────────

let cached: LogStore | null = null;

export function getLogStore(): LogStore {
  if (cached) return cached;

  const upstashUrl = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (upstashUrl && upstashToken) {
    cached = new UpstashLogStore();
    return cached;
  }

  if (process.env.VERCEL === "1") {
    console.warn(
      "[MyMCP] LogStore: running on Vercel without UPSTASH_REDIS_REST_URL/TOKEN — " +
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
