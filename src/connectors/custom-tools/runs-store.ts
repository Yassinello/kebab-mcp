/**
 * Custom Tools — runtime telemetry store (Phase 3).
 *
 * Persists a small, capped run history per Custom Tool so the dashboard
 * can render a "Recent runs (last 24h)" tab without forcing the operator
 * to rerun /test manually every time prod fails 1-in-10.
 *
 * Storage model: one Redis LIST per tool, capped at 100 entries, TTL
 * 24h (re-set on every push so an active tool keeps a sliding window).
 *
 *   key:  customtool:runs:<toolId>
 *   value (each list element): JSON-serialized {@link RunRecord}
 *
 * The list is LPUSH-ordered: head = newest. `LTRIM 0 99` after every
 * push enforces the 100-entry cap; `EXPIRE 86400` slides the TTL.
 *
 * ── Fire-and-forget contract ──────────────────────────────────────────
 *
 * `recordRun` MUST never throw or reject. The runner calls it via
 * `void recordRun(...).catch(...)` and a telemetry failure (KV down,
 * tenant misconfig, JSON serialization explosion) should never cascade
 * into a Custom Tool run failure. Any error is caught here and logged
 * via console.warn; the caller's `.catch(() => {})` is belt-and-braces.
 *
 * ── Backend support ───────────────────────────────────────────────────
 *
 * Upstash (production): uses native `lpushCapped` + `lrange` on the
 * shared KVStore. Atomic pipeline (LPUSH + LTRIM + EXPIRE) per write,
 * O(1) read.
 *
 * Filesystem (dev / non-Upstash): no list primitives. We fall back to a
 * single JSON-array key (`customtool:runs:<toolId>` storing a JSON array
 * of records). Read-modify-write under the existing KV write queue —
 * dev-only, racy across processes but fine for the in-repo loop. Cap +
 * TTL are best-effort (TTL is not enforced on filesystem at all; the
 * dashboard's "last 24h" filter handles user-visible expiry).
 *
 * ── Privacy ───────────────────────────────────────────────────────────
 *
 *  - `tokenIdShort` is at most 8 chars (sha256-prefix). Never the full secret.
 *  - `inputsPreview` is truncated to 1024 chars. Long values are clipped.
 */

import { getContextKVStore } from "@/core/request-context";
import { toMsg } from "@/core/error-utils";

export interface RunRecordStepResult {
  index: number;
  kind: "tool" | "transform";
  label: string;
  ok: boolean;
  durationMs: number;
  error?: string;
}

export interface RunRecord {
  toolId: string;
  ok: boolean;
  totalMs: number;
  stepCount: number;
  error?: string;
  /** Step-level breakdown — same shape as RunResult.stepResults (preview omitted). */
  stepResults: RunRecordStepResult[];
  /** Steps that successfully committed (state-mutating tools that ran before any later failure). */
  committedSteps: { index: number; toolName: string }[];
  /** Inputs the run was called with (truncated to 1KB JSON) — useful for repro. */
  inputsPreview?: string;
  /** ISO timestamp. */
  startedAt: string;
  /** Caller channel: "test" for dashboard test runner, "mcp" for transport invocations. */
  source: "test" | "mcp";
  /** Truncated tokenId for attribution (first 8 chars) — never the full secret. */
  tokenIdShort?: string;
}

const KEY_PREFIX = "customtool:runs:";
const MAX_ENTRIES = 100;
const TTL_SECONDS = 86_400; // 24h

function keyFor(toolId: string): string {
  return `${KEY_PREFIX}${toolId}`;
}

/**
 * Push a run record onto the head of `customtool:runs:<toolId>`.
 * Trims to MAX_ENTRIES, slides the 24h TTL.
 *
 * Never throws. KV failures are logged at warn-level and swallowed.
 */
export async function recordRun(record: RunRecord): Promise<void> {
  try {
    const kv = getContextKVStore();
    const key = keyFor(record.toolId);
    const line = JSON.stringify(record);

    // Native list primitives — Upstash path. Atomic LPUSH + LTRIM + EXPIRE
    // in a single pipeline.
    if (typeof kv.lpushCapped === "function") {
      await kv.lpushCapped(key, line, MAX_ENTRIES, { ttlSeconds: TTL_SECONDS });
      return;
    }

    // Filesystem fallback: read-modify-write on a single JSON array.
    // Acceptable for dev — see file header.
    const raw = await kv.get(key);
    let arr: string[] = [];
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) arr = parsed.filter((s): s is string => typeof s === "string");
      } catch {
        // corrupt — start fresh, don't surface
      }
    }
    arr.unshift(line);
    if (arr.length > MAX_ENTRIES) arr.length = MAX_ENTRIES;
    await kv.set(key, JSON.stringify(arr), TTL_SECONDS);
  } catch (err) {
    // Telemetry MUST NOT fail the run. Log + swallow.
    // Use console.warn directly (not the tagged logger) to avoid pulling
    // log-store into the runner's hot path — log-store itself depends
    // on KV and would compound the original failure.

    console.warn(`[custom-tools] recordRun failed: ${toMsg(err)}`);
  }
}

/**
 * Read up to `limit` recent runs for `toolId`, newest first.
 * Returns `[]` on KV failure or missing key (no telemetry → empty list,
 * which the UI renders as "No runs in the last 24h.").
 *
 * `limit` defaults to 50 and is clamped to [1, MAX_ENTRIES].
 */
export async function listRuns(toolId: string, limit = 50): Promise<RunRecord[]> {
  const cap = Math.max(1, Math.min(MAX_ENTRIES, Math.floor(limit)));
  try {
    const kv = getContextKVStore();
    const key = keyFor(toolId);

    let raw: string[] = [];
    if (typeof kv.lrange === "function") {
      raw = await kv.lrange(key, 0, cap - 1);
    } else {
      // Filesystem fallback: parse the JSON-array blob.
      const blob = await kv.get(key);
      if (!blob) return [];
      try {
        const parsed = JSON.parse(blob);
        if (Array.isArray(parsed)) {
          raw = parsed.filter((s): s is string => typeof s === "string").slice(0, cap);
        }
      } catch {
        return [];
      }
    }

    const out: RunRecord[] = [];
    for (const line of raw) {
      try {
        const parsed = JSON.parse(line) as RunRecord;
        // Light shape check — anything missing the toolId+startedAt skeleton
        // is treated as corrupt and dropped.
        if (parsed && typeof parsed.toolId === "string" && typeof parsed.startedAt === "string") {
          out.push(parsed);
        }
      } catch {
        // skip corrupt entries
      }
    }
    return out;
  } catch (err) {
    console.warn(`[custom-tools] listRuns failed: ${toMsg(err)}`);
    return [];
  }
}

/** Test-only: surface the constants so unit tests can reference them. */
export const _MAX_ENTRIES_FOR_TESTS = MAX_ENTRIES;
export const _TTL_SECONDS_FOR_TESTS = TTL_SECONDS;
export const _KEY_PREFIX_FOR_TESTS = KEY_PREFIX;
