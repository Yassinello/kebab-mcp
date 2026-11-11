/**
 * Phase 53 — Metrics aggregation helpers.
 *
 * Pure functions over `ToolLog[]` inputs. No env reads, no async.
 * Only `getMetricsSource()` is async — it chooses between the
 * in-process ring buffer (authoritative when non-empty) and the
 * durable log-store (cold-start fallback).
 *
 * Shape decisions:
 *   - 24 hourly buckets, bucket[0] = current hour (descending).
 *   - p95 uses nearest-rank on pre-sorted duration arrays.
 *   - Connector id is split from `"<connector>.<tool>"` on the first
 *     `.`; dotless tool names fall into a bucket named after the tool
 *     itself (no silent drop).
 *
 * Consumers:
 *   - app/api/admin/metrics/requests/route.ts → aggregateRequestsByHour
 *   - app/api/admin/metrics/latency/route.ts  → aggregateLatencyByTool
 *   - app/api/admin/metrics/errors/route.ts   → aggregateErrorsByConnectorHour
 */

import { getConfig } from "./config-facade";
import { getRecentLogs, type ToolLog } from "./logging";
import { getLogStore } from "./log-store";

const HOUR_MS = 3600_000;
const WINDOW_HOURS = 24;
const WINDOW_MS = WINDOW_HOURS * HOUR_MS;

/**
 * Build 24 descending hour buckets (current hour first). Each bucket's
 * `ts` is the start-of-hour unix ms; `count` is the number of logs
 * whose `Date.parse(timestamp)` falls in that hour.
 *
 * `opts.tool` filters to a single tool name before bucketing. Empty
 * input still yields 24 buckets (all zero).
 */
export function aggregateRequestsByHour(
  logs: ToolLog[],
  now: number,
  opts?: { tool?: string | undefined }
): Array<{ ts: number; count: number }> {
  const currentHourStart = Math.floor(now / HOUR_MS) * HOUR_MS;
  const buckets: Array<{ ts: number; count: number }> = [];
  for (let i = 0; i < WINDOW_HOURS; i++) {
    buckets.push({ ts: currentHourStart - i * HOUR_MS, count: 0 });
  }

  const toolFilter = opts?.tool;
  for (const log of logs) {
    if (toolFilter && log.tool !== toolFilter) continue;
    const ts = Date.parse(log.timestamp);
    if (!Number.isFinite(ts)) continue;
    const hoursBack = Math.floor((currentHourStart - Math.floor(ts / HOUR_MS) * HOUR_MS) / HOUR_MS);
    if (hoursBack < 0 || hoursBack >= WINDOW_HOURS) continue;
    const bucket = buckets[hoursBack];
    if (bucket) bucket.count++;
  }
  return buckets;
}

/**
 * Nearest-rank p95. Returns 0 for empty input. `sortedValues` must be
 * ascending.
 */
function p95(sortedValues: number[]): number {
  if (sortedValues.length === 0) return 0;
  const idx = Math.ceil(sortedValues.length * 0.95) - 1;
  return sortedValues[Math.max(0, Math.min(idx, sortedValues.length - 1))] ?? 0;
}

/**
 * Group `logs` by `tool`, compute per-tool p95 latency, sort descending
 * by p95, truncate to `limit`. Empty input → empty array.
 */
export function aggregateLatencyByTool(
  logs: ToolLog[],
  limit: number
): Array<{ name: string; p95Ms: number; calls: number }> {
  const groups = new Map<string, number[]>();
  for (const log of logs) {
    let arr = groups.get(log.tool);
    if (!arr) {
      arr = [];
      groups.set(log.tool, arr);
    }
    arr.push(log.durationMs);
  }
  const result: Array<{ name: string; p95Ms: number; calls: number }> = [];
  for (const [name, durations] of groups) {
    const sorted = [...durations].sort((a, b) => a - b);
    result.push({ name, p95Ms: p95(sorted), calls: durations.length });
  }
  result.sort((a, b) => b.p95Ms - a.p95Ms);
  return result.slice(0, Math.max(0, limit));
}

/**
 * Build a connector × hour error matrix. Each connector row has 24
 * descending hour buckets with `{ errors, total }` counts. Connectors
 * with zero errors are retained so the heatmap surfaces healthy
 * connectors as empty rows rather than hiding them.
 *
 * Connector id comes from `log.tool.split(".")[0]`. Dotless tool names
 * fall into a bucket named after the whole tool string.
 */
export function aggregateErrorsByConnectorHour(
  logs: ToolLog[],
  now: number
): Array<{ connectorId: string; hours: Array<{ ts: number; errors: number; total: number }> }> {
  const currentHourStart = Math.floor(now / HOUR_MS) * HOUR_MS;

  const byConnector = new Map<string, Map<number, { errors: number; total: number }>>();
  for (const log of logs) {
    const ts = Date.parse(log.timestamp);
    if (!Number.isFinite(ts)) continue;
    const hourStart = Math.floor(ts / HOUR_MS) * HOUR_MS;
    const hoursBack = Math.floor((currentHourStart - hourStart) / HOUR_MS);
    if (hoursBack < 0 || hoursBack >= WINDOW_HOURS) continue;

    const dotIndex = log.tool.indexOf(".");
    const connectorId = dotIndex === -1 ? log.tool : log.tool.slice(0, dotIndex);

    let hoursMap = byConnector.get(connectorId);
    if (!hoursMap) {
      hoursMap = new Map();
      byConnector.set(connectorId, hoursMap);
    }
    let cell = hoursMap.get(hourStart);
    if (!cell) {
      cell = { errors: 0, total: 0 };
      hoursMap.set(hourStart, cell);
    }
    cell.total++;
    if (log.status === "error") cell.errors++;
  }

  const result: Array<{
    connectorId: string;
    hours: Array<{ ts: number; errors: number; total: number }>;
  }> = [];
  for (const [connectorId, hoursMap] of byConnector) {
    const hours: Array<{ ts: number; errors: number; total: number }> = [];
    for (let i = 0; i < WINDOW_HOURS; i++) {
      const bucketTs = currentHourStart - i * HOUR_MS;
      const cell = hoursMap.get(bucketTs);
      hours.push({ ts: bucketTs, errors: cell?.errors ?? 0, total: cell?.total ?? 0 });
    }
    result.push({ connectorId, hours });
  }
  // Stable sort by connectorId for deterministic UI rendering.
  result.sort((a, b) => a.connectorId.localeCompare(b.connectorId));
  return result;
}

/**
 * Resolve the authoritative log source for a tenant scope.
 *
 *   - `tenantScope === "__all__"` → ring buffer across every tenant
 *     (`scope: "all"`). Intended for root-operator aggregate views.
 *   - Specific tenantId → that tenant's bucket only.
 *   - `null` → __root__ bucket (non-request writes).
 *
 * Source priority:
 *   1. In-process ring buffer via `getRecentLogs()`. Authoritative
 *      when non-empty.
 *   2. Durable `LogStore.since(Date.now() - 24h)` on cold-start (empty
 *      buffer). `entry.meta` is cast to `ToolLog` the same way
 *      `getDurableLogs()` does in logging.ts.
 *
 * Returned `source` tag lets the UI badge "cold-start (durable)" so
 * operators know whether they're looking at live data or a replay.
 */
export async function getMetricsSource(
  tenantScope: string | null,
  callerTenantId: string | null = null
): Promise<{ logs: ToolLog[]; source: "buffer" | "durable" }> {
  // Tenant-isolation guard: scoped admins (callerTenantId !== null) can
  // NEVER read cross-tenant metrics. The requested tenantScope is ignored
  // and forced to the caller's tenant. Only root callers (null tenant)
  // may request "__all__" or a specific tenantId.
  const effectiveScope = callerTenantId !== null ? callerTenantId : tenantScope;

  const bufferOpts =
    effectiveScope === "__all__"
      ? { scope: "all" as const }
      : effectiveScope && effectiveScope !== "__all__"
        ? { tenantId: effectiveScope }
        : { tenantId: null };

  // Generous ceiling — route-level limits are enforced at the route
  // layer; here we want the full 24h window available for aggregation.
  const bufferLogs = getRecentLogs(2000, bufferOpts);
  // REL-06 (2026-11 audit): on serverless each lambda has its own ring
  // buffer, so "buffer if non-empty" showed one random instance's slice.
  // When durable logs are enabled, they are the source of truth for the
  // un-scoped (root / all) views; tenant-scoped views keep the buffer since
  // durable entries are not tenant-partitioned.
  const preferDurable =
    getConfig("KEBAB_DURABLE_LOGS") === "true" &&
    ("scope" in bufferOpts || bufferOpts.tenantId === null);
  if (bufferLogs.length > 0 && !preferDurable) {
    return { logs: bufferLogs, source: "buffer" };
  }

  // Durable fallback — read 24 h worth of entries and cast `meta` back
  // to ToolLog (logToolCall persists the full record in meta).
  try {
    const store = getLogStore();
    const entries = await store.since(Date.now() - WINDOW_MS);
    const logs: ToolLog[] = [];
    for (const entry of entries) {
      const meta = entry.meta as unknown as ToolLog | undefined;
      if (!meta || typeof meta.tool !== "string") continue;
      logs.push(meta);
    }
    if (logs.length > 0) return { logs, source: "durable" };
    if (bufferLogs.length > 0) return { logs: bufferLogs, source: "buffer" };
  } catch {
    // Durable store unavailable — return the empty buffer result.
    // silent-swallow-ok: metrics must not surface durable-store
    // failures to the admin UI; the UI handles the empty case gracefully.
  }
  return { logs: [], source: "buffer" };
}
