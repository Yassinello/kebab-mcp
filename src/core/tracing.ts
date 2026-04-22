/**
 * OpenTelemetry tracing facade for Kebab MCP.
 *
 * Uses `@opentelemetry/api` as a facade only — if no SDK is registered
 * (the default), all operations are no-ops with zero overhead. When a
 * user installs the full OTel SDK and configures an exporter, our spans
 * automatically flow through their pipeline.
 *
 * Auto-bootstrap (OTEL-01..04): When `OTEL_SERVICE_NAME` is set, the
 * module auto-configures a NodeTracerProvider with an OTLP HTTP exporter
 * pointing at `OTEL_EXPORTER_OTLP_ENDPOINT` (default: localhost:4318).
 * When no OTel env vars are set, nothing is imported — zero overhead.
 *
 * Activation: spans are only created when `OTEL_EXPORTER_OTLP_ENDPOINT`
 * is set. Without it, `startToolSpan` returns a no-op sentinel and
 * `endToolSpan` is a no-op.
 */

import type { Span } from "@opentelemetry/api";
import { toMsg } from "./error-utils";

const TRACER_NAME = "mymcp";

// ── Auto-bootstrap ─────────────────────────────────────────────────
//
// When OTEL_SERVICE_NAME is set, auto-configure a tracer provider with
// an OTLP HTTP exporter. This runs at module-load time as a side effect.
// When no OTel env vars are set, no SDK modules are required — same
// zero overhead as before.

/** Exposed for testing — true once bootstrap has run successfully. */
export let otelBootstrapped = false;

function autoBootstrap(): void {
  const serviceName = process.env.OTEL_SERVICE_NAME;
  if (!serviceName) return;

  try {
    // Dynamic require so the SDK modules are only loaded when OTel is configured.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sdkTraceNode = require("@opentelemetry/sdk-trace-node");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sdkTraceBase = require("@opentelemetry/sdk-trace-base");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const otlpExporter = require("@opentelemetry/exporter-trace-otlp-http");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const resources = require("@opentelemetry/resources");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const api = require("@opentelemetry/api") as typeof import("@opentelemetry/api");

    const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318/v1/traces";

    // OTel SDK v0.200+: use resourceFromAttributes instead of new Resource
    const resource = resources.resourceFromAttributes
      ? resources.resourceFromAttributes({ "service.name": serviceName })
      : new resources.Resource({ "service.name": serviceName });

    const exporter = new otlpExporter.OTLPTraceExporter({ url: endpoint });
    const processor = new sdkTraceBase.BatchSpanProcessor(exporter);

    // OTel SDK v0.200+: pass spanProcessors in constructor
    const provider = new sdkTraceNode.NodeTracerProvider({
      resource,
      spanProcessors: [processor],
    });
    provider.register();

    // Also register with the global API so startToolSpan picks up our provider.
    api.trace.setGlobalTracerProvider(provider);

    otelBootstrapped = true;
  } catch (error) {
    // SDK packages not installed or failed to load — warn so the operator
    // knows OTel was requested but could not be started.
    console.warn(
      "[Kebab MCP] OTel bootstrap failed: " +
        toMsg(error) +
        ". Install @opentelemetry/sdk-trace-node and @opentelemetry/exporter-trace-otlp-http to enable tracing."
    );
  }
}

autoBootstrap();

/** Sentinel returned when tracing is disabled — all methods are no-ops. */
const NOOP_SPAN: NoopSpan = {
  __noop: true,
};

export interface NoopSpan {
  __noop: true;
}

export type ToolSpan = Span | NoopSpan;

function isNoopSpan(span: ToolSpan): span is NoopSpan {
  return (span as NoopSpan).__noop === true;
}

function isTracingEnabled(): boolean {
  return !!process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
}

/**
 * Start a span for a tool invocation.
 *
 * Returns a no-op sentinel when tracing is disabled (no env var set) or
 * when `@opentelemetry/api` is not available.
 */
export function startToolSpan(
  toolName: string,
  connectorId: string,
  argKeys: string[],
  requestId?: string | null
): ToolSpan {
  if (!isTracingEnabled()) return NOOP_SPAN;

  try {
    // Dynamic import avoidance: require at call time so the module
    // loads only when tracing is actually enabled.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const api = require("@opentelemetry/api") as typeof import("@opentelemetry/api");
    const tracer = api.trace.getTracer(TRACER_NAME);
    const span = tracer.startSpan(`tool.${toolName}`, {
      attributes: {
        "mymcp.tool.name": toolName,
        "mymcp.connector.id": connectorId,
        "mymcp.args.keys": JSON.stringify(argKeys),
        ...(requestId ? { "mymcp.request.id": requestId } : {}),
      },
    });
    return span;
  } catch {
    // @opentelemetry/api not installed or not resolvable — silent no-op.
    return NOOP_SPAN;
  }
}

/**
 * End a tool span with status and duration.
 */
export function endToolSpan(
  span: ToolSpan,
  status: "ok" | "error",
  durationMs: number,
  upstreamCallCount?: number
): void {
  if (isNoopSpan(span)) return;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const api = require("@opentelemetry/api") as typeof import("@opentelemetry/api");
    const realSpan = span as Span;
    realSpan.setAttribute("mymcp.duration_ms", durationMs);
    realSpan.setAttribute("mymcp.status", status);
    if (upstreamCallCount !== undefined) {
      realSpan.setAttribute("mymcp.upstream_call_count", upstreamCallCount);
    }
    if (status === "error") {
      realSpan.setStatus({ code: api.SpanStatusCode.ERROR });
    } else {
      realSpan.setStatus({ code: api.SpanStatusCode.OK });
    }
    realSpan.end();
  } catch {
    // silent-swallow-ok: tracing must never break tool execution
  }
}

// ── OBS-04: internal (non-tool) span helpers ──────────────────────
//
// Wraps the 3 hot paths called out in the Phase 38 plan:
//   - mymcp.bootstrap.rehydrate (src/core/first-run.ts)
//   - mymcp.kv.write            (src/core/kv-store.ts, via wrapWithTracing)
//   - mymcp.auth.check          (src/core/auth.ts)
// Returns a NOOP_SPAN when tracing is disabled so callers pay zero cost.

/**
 * Start a span for an internal (non-tool) operation. Follows the
 * existing `mymcp.<component>.<op>` naming convention.
 */
export function startInternalSpan(
  name: string,
  attrs?: Record<string, string | number | boolean>
): ToolSpan {
  if (!isTracingEnabled()) return NOOP_SPAN;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const api = require("@opentelemetry/api") as typeof import("@opentelemetry/api");
    const tracer = api.trace.getTracer(TRACER_NAME);
    const span = tracer.startSpan(name, attrs ? { attributes: attrs } : undefined);
    return span;
  } catch {
    return NOOP_SPAN;
  }
}

/**
 * Ergonomic wrapper: open a span, run the callback, record duration +
 * status, end the span. Errors are re-thrown so the caller's control
 * flow is unchanged. Zero allocation when tracing is disabled.
 */
export async function withSpan<T>(
  name: string,
  fn: () => Promise<T>,
  attrs?: Record<string, string | number | boolean>
): Promise<T> {
  const span = startInternalSpan(name, attrs);
  if (isNoopSpan(span)) return fn();
  const started = Date.now();
  try {
    const result = await fn();
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const api = require("@opentelemetry/api") as typeof import("@opentelemetry/api");
      const real = span as Span;
      real.setAttribute("mymcp.duration_ms", Date.now() - started);
      real.setAttribute("mymcp.status", "ok");
      real.setStatus({ code: api.SpanStatusCode.OK });
      real.end();
    } catch {
      // silent-swallow-ok: tracing emission must never break the wrapped call
    }
    return result;
  } catch (err) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const api = require("@opentelemetry/api") as typeof import("@opentelemetry/api");
      const real = span as Span;
      real.setAttribute("mymcp.duration_ms", Date.now() - started);
      real.setAttribute("mymcp.status", "error");
      real.setAttribute("mymcp.error.message", String(err).slice(0, 200));
      real.setStatus({ code: api.SpanStatusCode.ERROR });
      real.end();
    } catch {
      // silent-swallow-ok: tracing emission must never break the wrapped call
    }
    throw err;
  }
}

/** Sync variant of `withSpan` — used by checkMcpAuth which is non-async. */
export function withSpanSync<T>(
  name: string,
  fn: () => T,
  attrs?: Record<string, string | number | boolean>
): T {
  const span = startInternalSpan(name, attrs);
  if (isNoopSpan(span)) return fn();
  const started = Date.now();
  try {
    const result = fn();
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const api = require("@opentelemetry/api") as typeof import("@opentelemetry/api");
      const real = span as Span;
      real.setAttribute("mymcp.duration_ms", Date.now() - started);
      real.setAttribute("mymcp.status", "ok");
      real.setStatus({ code: api.SpanStatusCode.OK });
      real.end();
    } catch {
      // silent-swallow-ok: tracing emission must never break the wrapped call
    }
    return result;
  } catch (err) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const api = require("@opentelemetry/api") as typeof import("@opentelemetry/api");
      const real = span as Span;
      real.setAttribute("mymcp.duration_ms", Date.now() - started);
      real.setAttribute("mymcp.status", "error");
      real.setAttribute("mymcp.error.message", String(err).slice(0, 200));
      real.setStatus({ code: api.SpanStatusCode.ERROR });
      real.end();
    } catch {
      // silent-swallow-ok: tracing emission must never break the wrapped call
    }
    throw err;
  }
}

/** True iff OTel is currently active. Exposed for callers that want to
 * short-circuit expensive attribute assembly. */
export function isTracingActive(): boolean {
  return isTracingEnabled();
}
