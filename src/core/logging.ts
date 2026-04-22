import { getLogStore, type LogEntry } from "./log-store";
import { McpToolError } from "./errors";
import type { ToolResult } from "./types";
import { startToolSpan, endToolSpan } from "./tracing";
import { getToolTimeout } from "./config";
import { getCurrentTenantId } from "./request-context";
import { getConfig } from "./config-facade";
import { toMsg } from "./error-utils";

// ── T10: MYMCP_TOOL_TIMEOUT enforcement at the transport ─────────
//
// getToolTimeout() was defined but never called pre-v0.10 — tools ran
// until Vercel's 60s lambda kill, returning 504 instead of a clean
// MCP error. Phase 38 wires the value into withLogging via
// Promise.race so a slow tool returns ToolTimeoutError with
// errorCode: "TOOL_TIMEOUT" (distinct from the platform's timeout).

export class ToolTimeoutError extends Error {
  public readonly errorCode = "TOOL_TIMEOUT";
  constructor(
    public readonly toolName: string,
    public readonly timeoutMs: number
  ) {
    super(`Tool ${toolName} exceeded MYMCP_TOOL_TIMEOUT (${timeoutMs}ms)`);
    this.name = "ToolTimeoutError";
  }
}

/** Race a handler promise against the configured tool timeout. */
function withToolTimeout<T>(toolName: string, promise: Promise<T>): Promise<T> {
  const timeoutMs = getToolTimeout();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  return Promise.race<T>([
    promise,
    new Promise<T>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new ToolTimeoutError(toolName, timeoutMs)),
        timeoutMs
      );
    }),
  ]).finally(() => {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  });
}

// ── OBS-03: tagged structured logger ───────────────────────────────
//
// Thin facade over console that prefixes messages with a `[TAG]` so
// grep'ing production logs for a subsystem is one-line. Each sweep in
// Phase 38 standardized its tag:
//   [FIRST-RUN]        — src/core/first-run*.ts
//   [KV]               — src/core/kv-store.ts
//   [WELCOME]          — app/api/welcome/**/route.ts
//   [CONNECTOR:skills] — src/connectors/skills/*
//   [LOG-STORE]        — src/core/log-store.ts
//   [API:<route>]      — app/api/**/route.ts via errorResponse()
//   [TOOL:<name>]      — tool-timeout path
//
// Keep the Logger interface minimal — we don't need pino-level
// structured fields yet, and staying on `console.*` means we keep
// working in edge / workers runtimes without a platform-specific
// dependency.

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
}

export function getLogger(tag?: string): Logger {
  const prefix = tag ? `[${tag}] ` : "";
  return {
    info: (msg, meta) =>
      meta ? console.log(`${prefix}${msg}`, meta) : console.log(`${prefix}${msg}`),
    warn: (msg, meta) =>
      meta ? console.warn(`${prefix}${msg}`, meta) : console.warn(`${prefix}${msg}`),
    error: (msg, meta) =>
      meta ? console.error(`${prefix}${msg}`, meta) : console.error(`${prefix}${msg}`),
    debug: (msg, meta) => {
      if (getConfig("MYMCP_DEBUG") !== "1") return;
      if (meta) console.log(`[DEBUG]${prefix}${msg}`, meta);
      else console.log(`[DEBUG]${prefix}${msg}`);
    },
  };
}

export interface ToolLog {
  tool: string;
  durationMs: number;
  status: "success" | "error";
  error?: string;
  errorCode?: string;
  retryable?: boolean;
  /** Actionable recovery hint from connector-specific errors. */
  recovery?: string;
  /** Number of streamed chunks (present when tool returned a stream). */
  streamChunks?: number;
  /** Total byte size of streamed content. */
  streamBytes?: number;
  timestamp: string;
  tokenId?: string;
  /** Request ID for correlating tool calls to HTTP requests. */
  requestId?: string;
}

// ── ISO-01 / Phase 48 — per-tenant ring buffer ────────────────────
//
// Before Phase 48, this module held a single operator-wide
// `ToolLog[]` capped at 100. Under one warm lambda serving two
// tenants, tenant A's logs landed in the same array tenant B read
// from (Phase 42 FOLLOW-UP §1). The durable store fixed that in
// Phase 42 / TEN-02, but the fast-path in-memory buffer still leaked.
//
// The buffer is now `Map<tenantId | "__root__", ToolLog[]>` keyed
// from `getCurrentTenantId()`. Each bucket LRU-trims independently
// under the `BUFFER_CAP_PER_TENANT` cap, so one noisy tenant cannot
// evict another's entries. The "__root__" sentinel holds writes
// that occur outside any requestContext (boot, cron, tests).
//
// Cap default: 100 per tenant. Configurable via
// `KEBAB_LOG_BUFFER_PER_TENANT`. This is a new env var (no
// `MYMCP_*` predecessor) — the alias logic is Phase 50.
//
// Phase 48 / FACADE-02a: cap read now routes through getConfig()
// (see getBufferCapPerTenant below).
/** Sentinel bucket key for writes that happen outside any requestContext. */
const ROOT_BUCKET = "__root__" as const;

/** Per-tenant ring buffer cap. Defaults to 100. */
function getBufferCapPerTenant(): number {
  const raw = getConfig("KEBAB_LOG_BUFFER_PER_TENANT");
  if (!raw) return 100;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 100;
}

const buffers: Map<string, ToolLog[]> = new Map();

/**
 * Test-only. Clears every per-tenant bucket. Parallels Phase 42's
 * `__resetV011MigrationForTests`.
 */
export function __resetRingBufferForTests(): void {
  buffers.clear();
}

function bucketFor(tenantId: string | null | undefined): ToolLog[] {
  const key = tenantId ?? ROOT_BUCKET;
  let buf = buffers.get(key);
  if (!buf) {
    buf = [];
    buffers.set(key, buf);
  }
  return buf;
}

export function logToolCall(log: ToolLog) {
  const key = getCurrentTenantId() ?? ROOT_BUCKET;
  const buf = bucketFor(key);
  buf.push(log);
  const cap = getBufferCapPerTenant();
  while (buf.length > cap) buf.shift();

  const emoji = log.status === "success" ? "✓" : "✗";
  const errorSuffix = log.error
    ? ` — ${log.errorCode ? `[${log.errorCode}] ` : ""}${log.error}`
    : "";
  console.log(`[Kebab MCP] ${emoji} ${log.tool} (${log.durationMs}ms)${errorSuffix}`);

  // Write to the pluggable log store if durable logging is enabled.
  // Fire-and-forget: a failing log write must never surface to the
  // caller of the tool. The in-memory ring buffer above is what drives
  // p95/metrics so we stay observable even if the store is misbehaving.
  if (getConfig("MYMCP_DURABLE_LOGS") === "true") {
    try {
      const store = getLogStore();
      const entry: LogEntry = {
        ts: Date.now(),
        level: log.status === "error" ? "error" : "info",
        message: `${log.tool} (${log.durationMs}ms)`,
        meta: { ...log },
      };
      store
        .append(entry)
        .catch((err: Error) => console.error("[Kebab MCP] Durable log write failed:", err.message));
    } catch (err) {
      console.error("[Kebab MCP] Durable log store unavailable:", toMsg(err));
    }
  }

  // Fire error webhook if configured
  if (log.status === "error") {
    const webhookUrl = getConfig("MYMCP_ERROR_WEBHOOK_URL");
    if (webhookUrl) {
      fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: `[Kebab MCP] Tool error: ${log.tool} — ${log.error} (${log.durationMs}ms)`,
          tool: log.tool,
          error: log.error,
          errorCode: log.errorCode,
          retryable: log.retryable,
          durationMs: log.durationMs,
          timestamp: log.timestamp,
        }),
      }).catch(() => {
        /* best effort — don't crash on webhook failure */
      });
    }
  }
}

/** Aggregate stats from recent logs */
function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const idx = Math.ceil(sortedValues.length * p) - 1;
  return sortedValues[Math.max(0, Math.min(idx, sortedValues.length - 1))];
}

export function getToolStats(): {
  totalCalls: number;
  errorCount: number;
  avgDurationMs: number;
  p95DurationMs: number;
  byTool: Record<
    string,
    { calls: number; errors: number; avgMs: number; p95Ms: number; errorRate: number }
  >;
  byToken: Record<string, { calls: number; errors: number }>;
} {
  const byTool: Record<string, { calls: number; errors: number; durations: number[] }> = {};
  const byToken: Record<string, { calls: number; errors: number }> = {};
  const allDurations: number[] = [];

  // ISO-01 / Phase 48: aggregate across the flattened union of all
  // per-tenant buckets. `byToken` keeps its operator-wide role — the
  // admin metrics tab is root-scoped.
  const allLogs: ToolLog[] = [];
  for (const buf of buffers.values()) allLogs.push(...buf);

  for (const log of allLogs) {
    if (!byTool[log.tool]) {
      byTool[log.tool] = { calls: 0, errors: 0, durations: [] };
    }
    byTool[log.tool].calls++;
    byTool[log.tool].durations.push(log.durationMs);
    allDurations.push(log.durationMs);
    if (log.status === "error") byTool[log.tool].errors++;

    if (log.tokenId) {
      if (!byToken[log.tokenId]) {
        byToken[log.tokenId] = { calls: 0, errors: 0 };
      }
      byToken[log.tokenId].calls++;
      if (log.status === "error") byToken[log.tokenId].errors++;
    }
  }

  const totalCalls = allLogs.length;
  const errorCount = allLogs.filter((l) => l.status === "error").length;
  const totalMs = allLogs.reduce((sum, l) => sum + l.durationMs, 0);
  const sortedAll = [...allDurations].sort((a, b) => a - b);

  return {
    totalCalls,
    errorCount,
    avgDurationMs: totalCalls > 0 ? Math.round(totalMs / totalCalls) : 0,
    p95DurationMs: percentile(sortedAll, 0.95),
    byTool: Object.fromEntries(
      Object.entries(byTool).map(([tool, s]) => {
        const sorted = [...s.durations].sort((a, b) => a - b);
        const sum = s.durations.reduce((a, b) => a + b, 0);
        return [
          tool,
          {
            calls: s.calls,
            errors: s.errors,
            avgMs: Math.round(sum / s.calls),
            p95Ms: percentile(sorted, 0.95),
            errorRate: s.calls > 0 ? s.errors / s.calls : 0,
          },
        ];
      })
    ),
    byToken,
  };
}

/**
 * Return the most recent log entries.
 *
 * ISO-01 / Phase 48: reads are now tenant-scoped.
 *   - Default: current tenant bucket (`getCurrentTenantId() ?? "__root__"`).
 *   - `opts.tenantId`: explicit bucket select — admin root query for a
 *     specific tenant. Pass `null` for the __root__ bucket.
 *   - `opts.scope === 'all'`: flattened union across every bucket,
 *     sorted by timestamp descending; the root-operator path for
 *     `/config → Logs` tenant selector ("All tenants (root)").
 */
export function getRecentLogs(
  count?: number,
  opts?: { tenantId?: string | null; scope?: "all" }
): ToolLog[] {
  const cap = getBufferCapPerTenant();
  const n = Math.min(count || 20, Math.max(cap, 1) * 100); // generous ceiling

  if (opts?.scope === "all") {
    const all: ToolLog[] = [];
    for (const buf of buffers.values()) all.push(...buf);
    all.sort((a, b) => {
      const ta = Date.parse(a.timestamp) || 0;
      const tb = Date.parse(b.timestamp) || 0;
      return ta - tb; // chronological ascending — matches pre-Phase-48 slice(-n) order
    });
    return all.slice(-n);
  }

  const key = opts && "tenantId" in opts ? opts.tenantId : getCurrentTenantId();
  const buf = buffers.get(key ?? ROOT_BUCKET);
  if (!buf) return [];
  return buf.slice(-n);
}

export async function getDurableLogs(
  count?: number,
  filter?: "all" | "errors" | "success"
): Promise<ToolLog[]> {
  const store = getLogStore();
  const limit = Math.min(count || 20, 500);
  // Pull a margin over `limit` so filtering doesn't starve the result.
  const pulled = await store.recent(limit * 4);
  const results: ToolLog[] = [];
  for (const entry of pulled) {
    const meta = entry.meta as unknown as ToolLog | undefined;
    if (!meta || typeof meta.tool !== "string") continue;
    if (filter === "errors" && meta.status !== "error") continue;
    if (filter === "success" && meta.status !== "success") continue;
    results.push(meta);
    if (results.length >= limit) break;
  }
  return results;
}

export function withLogging<TParams>(
  toolName: string,
  handler: (params: TParams) => Promise<ToolResult>,
  callerTokenId?: string | null,
  connectorId?: string,
  requestId?: string | null
): (params: TParams) => Promise<ToolResult> {
  return async (params: TParams) => {
    const argKeys = params && typeof params === "object" ? Object.keys(params as object) : [];
    const span = startToolSpan(toolName, connectorId ?? "unknown", argKeys, requestId);
    const start = Date.now();
    try {
      // T10: race the handler against MYMCP_TOOL_TIMEOUT so a slow tool
      // returns a ToolTimeoutError with errorCode=TOOL_TIMEOUT instead
      // of being killed by the platform's 504.
      const result = await withToolTimeout(toolName, handler(params));

      // STREAM-01..04: When a tool returns a stream, collect chunks into
      // the content buffer so the MCP SDK receives a complete response.
      // This lets tools produce data progressively without holding
      // everything in memory until the stream ends.
      //
      // Safety bounds (CRITICAL-1): cap at 10 MB / 55 s to stay within
      // Vercel's 60 s serverless timeout and prevent unbounded memory growth.
      if (result.stream) {
        const MAX_STREAM_BYTES = 10 * 1024 * 1024; // 10 MB
        const MAX_STREAM_DURATION_MS = 55_000; // 55 s (under Vercel 60 s)
        const stream = result.stream as AsyncIterable<string>;
        const chunks: string[] = [];
        let totalBytes = 0;
        let truncated: string | null = null;
        const streamStart = Date.now();
        for await (const chunk of stream) {
          chunks.push(chunk);
          totalBytes += chunk.length;
          if (totalBytes > MAX_STREAM_BYTES) {
            truncated = "Stream truncated: exceeded 10 MB size limit";
            break;
          }
          if (Date.now() - streamStart > MAX_STREAM_DURATION_MS) {
            truncated = "Stream truncated: exceeded 55 s duration limit";
            break;
          }
        }
        if (truncated) {
          chunks.push(`\n${truncated}`);
        }
        const durationMs = Date.now() - start;
        endToolSpan(span, truncated ? "error" : "ok", durationMs);
        logToolCall({
          tool: toolName,
          durationMs,
          status: truncated ? "error" : "success",
          ...(truncated ? { error: truncated } : {}),
          streamChunks: chunks.length,
          streamBytes: totalBytes,
          timestamp: new Date().toISOString(),
          ...(callerTokenId ? { tokenId: callerTokenId } : {}),
          ...(requestId ? { requestId } : {}),
        });
        // Replace the stream with the collected content
        const { stream: _stream, ...rest } = result;
        return {
          ...rest,
          content: [{ type: "text" as const, text: chunks.join("") }],
          ...(truncated ? { isError: true } : {}),
        };
      }

      const durationMs = Date.now() - start;
      endToolSpan(span, "ok", durationMs);
      logToolCall({
        tool: toolName,
        durationMs,
        status: "success",
        timestamp: new Date().toISOString(),
        ...(callerTokenId ? { tokenId: callerTokenId } : {}),
        ...(requestId ? { requestId } : {}),
      });
      return result;
    } catch (error) {
      const durationMs = Date.now() - start;
      const timestamp = new Date().toISOString();
      endToolSpan(span, "error", durationMs);

      // T10: dedicated logging for TOOL_TIMEOUT so ops can filter.
      if (error instanceof ToolTimeoutError) {
        getLogger(`TOOL:${toolName}`).error("timeout", {
          errorCode: error.errorCode,
          toolName: error.toolName,
          timeoutMs: error.timeoutMs,
        });
        logToolCall({
          tool: toolName,
          durationMs,
          status: "error",
          error: error.message,
          errorCode: error.errorCode,
          timestamp,
          ...(callerTokenId ? { tokenId: callerTokenId } : {}),
          ...(requestId ? { requestId } : {}),
        });
        // Surface as an MCP tool error so the client sees a structured
        // error rather than the platform's 504.
        return {
          content: [
            {
              type: "text" as const,
              text: `Tool "${toolName}" timed out after ${error.timeoutMs}ms (MYMCP_TOOL_TIMEOUT).`,
            },
          ],
          isError: true,
          errorCode: error.errorCode,
        };
      }

      if (error instanceof McpToolError) {
        // Log the detailed internalRecovery server-side (contains env var
        // names etc.), but only surface the generic recovery to the client.
        if (error.internalRecovery) {
          console.log(`[Kebab MCP] Recovery detail (${toolName}): ${error.internalRecovery}`);
        }
        logToolCall({
          tool: toolName,
          durationMs,
          status: "error",
          error: error.message,
          errorCode: error.code,
          retryable: error.retryable,
          recovery: error.internalRecovery ?? error.recovery,
          timestamp,
          ...(callerTokenId ? { tokenId: callerTokenId } : {}),
          ...(requestId ? { requestId } : {}),
        });
        // Include generic recovery hint in the MCP response so the LLM can
        // act on it (e.g., suggest re-auth or retry after a delay).
        // Never surface internalRecovery — it may contain env var names.
        const userText = error.recovery
          ? `${error.userMessage}\n\nRecovery: ${error.recovery}`
          : error.userMessage;
        return {
          content: [{ type: "text", text: userText }],
          isError: true,
          errorCode: error.code,
        };
      }

      const message = toMsg(error);
      logToolCall({
        tool: toolName,
        durationMs,
        status: "error",
        error: message,
        timestamp,
        ...(callerTokenId ? { tokenId: callerTokenId } : {}),
        ...(requestId ? { requestId } : {}),
      });
      throw error;
    }
  };
}
