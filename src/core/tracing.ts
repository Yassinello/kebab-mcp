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
import { BRAND, LEGACY_BRAND } from "./constants/brand";

// Phase 50 / BRAND-03 — tracer name follows BRAND.otelAttrPrefix. The
// tracer name is a vendor string, not a span attribute — operators
// consume it via resource attributes, so a silent swap is safe. Keep
// the legacy string available only for the tool-id dedupe below.
const TRACER_NAME = BRAND.otelAttrPrefix;

/**
 * Phase 50 / BRAND-03 — build a brand-namespaced attribute bag.
 *
 * Input: unprefixed keys (e.g. `tool.name`, `kv.op`, `request.id`).
 * Output: each key prefixed with `kebab.`. When the legacy emission
 * flag (`KEBAB_EMIT_LEGACY_OTEL_ATTRS=1` or
 * `MYMCP_EMIT_LEGACY_OTEL_ATTRS=1`) is set, each attribute is also
 * duplicated under the `mymcp.` prefix with the same value. This
 * preserves dashboards filtering on `mymcp.*` during the 2-release
 * transition without mutating the default shape.
 *
 * Flag reading bypasses the facade on purpose: tracing.ts is on the
 * ALLOWED_DIRECT_ENV_READS list (OTel SDK bootstraps at module load
 * before the facade import graph is ready), and a tracing hot-path
 * should not pay the cost of a full facade lookup per attribute.
 */
export function brandSpanAttrs(
  attrs: Record<string, string | number | boolean>
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  const emitLegacy = shouldEmitLegacyOtelAttrs();
  for (const [key, value] of Object.entries(attrs)) {
    out[`${BRAND.otelAttrPrefix}.${key}`] = value;
    if (emitLegacy) out[`${LEGACY_BRAND.otelAttrPrefix}.${key}`] = value;
  }
  return out;
}

/**
 * Phase 50 / BRAND-03 — normalize span names to the modern prefix.
 *
 * Accepts:
 *  - unprefixed names (e.g. `auth.check`) — returns `kebab.auth.check`
 *  - legacy-prefixed names (`mymcp.auth.check`) — returns `kebab.auth.check`
 *  - modern-prefixed names (`kebab.auth.check`) — returns as-is
 */
export function brandSpanName(name: string): string {
  if (name.startsWith(BRAND.otelAttrPrefix + ".")) return name;
  if (name.startsWith(LEGACY_BRAND.otelAttrPrefix + ".")) {
    return BRAND.otelAttrPrefix + name.slice(LEGACY_BRAND.otelAttrPrefix.length);
  }
  return `${BRAND.otelAttrPrefix}.${name}`;
}

function shouldEmitLegacyOtelAttrs(): boolean {
  const v = process.env.KEBAB_EMIT_LEGACY_OTEL_ATTRS || process.env.MYMCP_EMIT_LEGACY_OTEL_ATTRS;
  if (!v) return false;
  return v === "1" || v.toLowerCase() === "true";
}

/**
 * Apply a set of unprefixed attributes to a live span, brand-namespacing
 * each. Safe to call during span finalize (status + duration).
 */
function applyBrandSpanAttrs(span: Span, attrs: Record<string, string | number | boolean>): void {
  for (const [k, v] of Object.entries(brandSpanAttrs(attrs))) {
    span.setAttribute(k, v);
  }
}

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
    // OTel JS v3 (sdk-node 0.300+): sdk-trace-node/sdk-trace-base were folded
    // into @opentelemetry/sdk-trace, which has no NodeTracerProvider.register()
    // — we register the context manager + propagator ourselves below.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sdkTrace = require("@opentelemetry/sdk-trace");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const otlpExporter = require("@opentelemetry/exporter-trace-otlp-http");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const resources = require("@opentelemetry/resources");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const asyncHooks = require("@opentelemetry/context-async-hooks");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const otelCore = require("@opentelemetry/core");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const api = require("@opentelemetry/api") as typeof import("@opentelemetry/api");

    const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318/v1/traces";

    const resource = resources.resourceFromAttributes({ "service.name": serviceName });

    const exporter = new otlpExporter.OTLPTraceExporter({ url: endpoint });
    const processor = new sdkTrace.BatchSpanProcessor(exporter);

    const provider = new sdkTrace.TracerProvider({
      resource,
      spanProcessors: [processor],
    });

    // Equivalent of the former NodeTracerProvider.register(): async context
    // propagation within the process + W3C trace-context/baggage propagators.
    api.context.setGlobalContextManager(new asyncHooks.AsyncLocalStorageContextManager().enable());
    api.propagation.setGlobalPropagator(
      new otelCore.CompositePropagator({
        propagators: [
          new otelCore.W3CTraceContextPropagator(),
          new otelCore.W3CBaggagePropagator(),
        ],
      })
    );
    api.trace.setGlobalTracerProvider(provider);

    otelBootstrapped = true;
  } catch (error) {
    // SDK packages not installed or failed to load — warn so the operator
    // knows OTel was requested but could not be started.
    console.warn(
      "[Kebab MCP] OTel bootstrap failed: " +
        toMsg(error) +
        ". Install @opentelemetry/sdk-node and @opentelemetry/exporter-trace-otlp-http to enable tracing."
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
      attributes: brandSpanAttrs({
        "tool.name": toolName,
        "connector.id": connectorId,
        "args.keys": JSON.stringify(argKeys),
        ...(requestId ? { "request.id": requestId } : {}),
      }),
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
    const attrs = brandSpanAttrs({
      duration_ms: durationMs,
      status,
      ...(upstreamCallCount !== undefined ? { upstream_call_count: upstreamCallCount } : {}),
    });
    for (const [k, v] of Object.entries(attrs)) realSpan.setAttribute(k, v);
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
//   - kebab.bootstrap.rehydrate (src/core/first-run.ts)
//   - kebab.kv.write            (src/core/kv-store.ts, via wrapWithTracing)
//   - kebab.auth.check          (src/core/auth.ts)
// Returns a NOOP_SPAN when tracing is disabled so callers pay zero cost.

/**
 * Start a span for an internal (non-tool) operation. Follows the
 * `kebab.<component>.<op>` naming convention (was `mymcp.<...>`
 * pre-Phase-50). Callers pass unprefixed logical names like
 * `auth.check`; `brandSpanName()` normalizes.
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
    const branded = brandSpanName(name);
    const brandedAttrs = attrs ? brandSpanAttrs(attrs) : undefined;
    const span = tracer.startSpan(branded, brandedAttrs ? { attributes: brandedAttrs } : undefined);
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
      applyBrandSpanAttrs(real, { duration_ms: Date.now() - started, status: "ok" });
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
      applyBrandSpanAttrs(real, {
        duration_ms: Date.now() - started,
        status: "error",
        "error.message": String(err).slice(0, 200),
      });
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
      applyBrandSpanAttrs(real, { duration_ms: Date.now() - started, status: "ok" });
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
      applyBrandSpanAttrs(real, {
        duration_ms: Date.now() - started,
        status: "error",
        "error.message": String(err).slice(0, 200),
      });
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
