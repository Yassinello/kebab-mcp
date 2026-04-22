/**
 * storage-mode.ts — Authoritative runtime storage mode detection.
 *
 * Decides what kind of persistent storage is *actually available* right now,
 * based on:
 *   - presence of Upstash credentials (DUR-06: either UPSTASH_REDIS_REST_*
 *     or KV_REST_API_*, resolved via `getUpstashCreds()`)
 *   - reachability of the Upstash REST endpoint (PING)
 *   - filesystem write capability of the data dir (sentinel write probe)
 *
 * This replaces the legacy "is this Vercel?" heuristic in credential-store.ts
 * (which incorrectly assumed Vercel ⇒ readonly and Docker ⇒ writable; in
 * reality Netlify/Render/Fly are also readonly, and broken Docker volumes
 * can be readonly too).
 *
 * Four modes are surfaced. The dashboard, welcome flow, and connector save
 * flows all branch off the same value, so users never see contradictory
 * messages.
 *
 * | Mode          | Trigger                              | Saves possible? |
 * | ------------- | ------------------------------------ | --------------- |
 * | kv            | KV env vars set + ping OK            | Yes (KV)        |
 * | file          | No KV + sentinel write OK            | Yes (FS)        |
 * | static        | No KV + sentinel write FAIL (EROFS)  | No (env-vars only) |
 * | kv-degraded   | KV env vars set + ping FAIL/timeout  | No (until KV recovers) |
 *
 * `kv-degraded` is intentionally NOT downgraded to file — silent fallback
 * during a temporary Upstash outage would write to the wrong backend and
 * cause data loss after recovery.
 */

import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { getUpstashCreds } from "./upstash-env";
import { fetchWithTimeout } from "./fetch-utils";
import { toMsg } from "./error-utils";

export type StorageMode = "kv" | "file" | "static" | "kv-degraded";

export interface StorageModeReport {
  mode: StorageMode;
  /** Human-readable explanation of how the mode was decided. */
  reason: string;
  /** Resolved data dir path (file mode) or null. */
  dataDir: string | null;
  /** Redacted Upstash URL (kv / kv-degraded) or null. */
  kvUrl: string | null;
  /** KV ping latency in ms (kv mode only). */
  latencyMs: number | null;
  /** Last KV error message (kv-degraded only). */
  error: string | null;
  /** Timestamp of detection. */
  detectedAt: string;
  /**
   * True when the probed filesystem is "writable but data doesn't survive".
   * Currently set for Vercel `/tmp` — the FS accepts writes but the container
   * is recycled on every cold start (typically 15-30 minutes of idle).
   *
   * This is the silent-data-loss trap that v2 mis-labeled as healthy. UI
   * surfaces this as an amber warning, and `storageReady` (welcome-side)
   * requires explicit acknowledgment before the user can continue.
   *
   * Only meaningful when `mode === "file"`.
   */
  ephemeral: boolean;
}

const CACHE_TTL_MS = 60_000;
let cached: { at: number; report: StorageModeReport } | null = null;

/** Reset the cached report. Called by recheck endpoint and tests. */
export function clearStorageModeCache(): void {
  cached = null;
}

function redactUpstashUrl(url: string): string {
  // Upstash URLs look like https://us1-foo-bar.upstash.io. We surface only the
  // host so support tickets don't accidentally leak the rest token if the URL
  // happens to embed credentials.
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "[invalid-url]";
  }
}

function resolveDataDir(): string {
  // Mirrors the kv-store.ts selection — when no KV is configured and we are
  // on Vercel, the legacy code falls back to /tmp; for our probe we test the
  // *real* destination so a writable /tmp under EROFS root still reports as
  // writable (which is the correct interpretation: we *can* write, we just
  // can't persist).
  if (process.env.MYMCP_KV_PATH) {
    return path.dirname(process.env.MYMCP_KV_PATH);
  }
  if (process.env.VERCEL === "1") {
    return "/tmp";
  }
  return path.resolve(process.cwd(), "data");
}

/**
 * Try to write a sentinel file under the candidate data dir. Returns true
 * iff write+delete both succeed. We delete on success so we don't leave
 * litter behind, but a failed delete after a successful write still counts
 * as "writable" — the goal is "could we save creds here?".
 */
async function probeFsWritable(dir: string): Promise<{ writable: boolean; error?: string }> {
  const probeName = `.mymcp-probe-${randomBytes(4).toString("hex")}`;
  const probePath = path.join(dir, probeName);
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(probePath, "probe", "utf-8");
    // Best-effort cleanup
    await fs.unlink(probePath).catch(() => undefined);
    return { writable: true };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return { writable: false, error: e.code || e.message };
  }
}

/**
 * Ping Upstash REST endpoint. Returns latency in ms on success.
 *
 * 1500ms timeout — enough to absorb a slow connection but short enough that
 * cold-start UX doesn't visibly stall. We do NOT retry here: a single failure
 * marks the mode as degraded and the dashboard surfaces a "recheck" button.
 */
async function pingUpstash(
  url: string,
  token: string
): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  // Phase 44 SCM-05b: 1500ms explicit timeout preserved via shared helper.
  const started = Date.now();
  try {
    const res = await fetchWithTimeout(
      url.replace(/\/$/, ""),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(["PING"]),
      },
      1500
    );
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      return { ok: false, latencyMs, error: `HTTP ${res.status}` };
    }
    const json = (await res.json().catch(() => ({}))) as { result?: unknown; error?: string };
    if (json.error) return { ok: false, latencyMs, error: json.error };
    // Upstash PING returns "PONG"
    if (typeof json.result === "string" && json.result.toUpperCase() === "PONG") {
      return { ok: true, latencyMs };
    }
    return { ok: false, latencyMs, error: "Unexpected PING response" };
  } catch (err) {
    const latencyMs = Date.now() - started;
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, latencyMs, error: "Timeout (1500ms)" };
    }
    return {
      ok: false,
      latencyMs,
      error: toMsg(err),
    };
  }
}

/**
 * Detect the current storage mode. Cached for 60s to avoid burning a probe
 * write + KV PING on every dashboard request.
 */
export async function detectStorageMode(opts?: { force?: boolean }): Promise<StorageModeReport> {
  if (!opts?.force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.report;
  }

  const creds = getUpstashCreds();
  const upstashUrl = creds?.url;
  const upstashToken = creds?.token;
  const detectedAt = new Date().toISOString();

  // Branch 1: Upstash configured → reachable or degraded
  if (upstashUrl && upstashToken) {
    const ping = await pingUpstash(upstashUrl, upstashToken);
    if (ping.ok) {
      const report: StorageModeReport = {
        mode: "kv",
        reason: `Upstash configured and reachable (PING ${ping.latencyMs}ms)`,
        dataDir: null,
        kvUrl: redactUpstashUrl(upstashUrl),
        latencyMs: ping.latencyMs,
        error: null,
        detectedAt,
        ephemeral: false,
      };
      cached = { at: Date.now(), report };
      return report;
    }
    const report: StorageModeReport = {
      mode: "kv-degraded",
      reason: `Upstash configured but ping failed (${ping.error ?? "unknown"})`,
      dataDir: null,
      kvUrl: redactUpstashUrl(upstashUrl),
      latencyMs: ping.latencyMs,
      error: ping.error ?? "PING failed",
      detectedAt,
      ephemeral: false,
    };
    cached = { at: Date.now(), report };
    return report;
  }

  // Branch 2: No Upstash → probe filesystem
  const dataDir = resolveDataDir();
  const probe = await probeFsWritable(dataDir);
  if (probe.writable) {
    // Serverless /tmp is "writable" but ephemeral — the container is
    // recycled on every cold start and any writes vanish. We flag via the
    // `ephemeral` field so the UI can render an amber warning state
    // instead of the green "ready" it gives to real (Docker/dev) file
    // storage. The check is broader than VERCEL === "1" — Netlify, AWS
    // Lambda, Google Cloud Run, and anything else that identifies as
    // serverless AND picks a /tmp data dir falls into the same trap.
    const isServerless =
      process.env.VERCEL === "1" ||
      process.env.NETLIFY === "true" ||
      Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME) ||
      Boolean(process.env.LAMBDA_TASK_ROOT) ||
      Boolean(process.env.K_SERVICE); // Cloud Run
    const sysTmp = os.tmpdir();
    const looksTemp =
      dataDir === "/tmp" ||
      dataDir.startsWith("/tmp/") ||
      dataDir === sysTmp ||
      dataDir.startsWith(`${sysTmp}${path.sep}`);
    const ephemeral = isServerless && looksTemp;
    const report: StorageModeReport = {
      mode: "file",
      reason: ephemeral
        ? `Filesystem writable at ${dataDir} (ephemeral — serverless /tmp, lost on cold start)`
        : `Filesystem writable at ${dataDir}`,
      dataDir,
      kvUrl: null,
      latencyMs: null,
      error: null,
      detectedAt,
      ephemeral,
    };
    cached = { at: Date.now(), report };
    return report;
  }

  // Branch 3: No Upstash, no writable FS → static mode
  const report: StorageModeReport = {
    mode: "static",
    reason: `No KV configured and filesystem at ${dataDir} is read-only (${probe.error ?? "unknown"})`,
    dataDir,
    kvUrl: null,
    latencyMs: null,
    error: probe.error ?? "EROFS",
    detectedAt,
    ephemeral: false,
  };
  cached = { at: Date.now(), report };
  return report;
}

/**
 * Sync helper for callers that just need the mode value and have already
 * called detectStorageMode() recently. Returns null if cache is empty.
 */
export function getCachedStorageMode(): StorageMode | null {
  if (!cached) return null;
  if (Date.now() - cached.at >= CACHE_TTL_MS) return null;
  return cached.report.mode;
}
