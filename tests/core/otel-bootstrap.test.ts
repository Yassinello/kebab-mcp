import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("OTel auto-bootstrap", () => {
  let originalServiceName: string | undefined;
  let originalEndpoint: string | undefined;

  beforeEach(() => {
    originalServiceName = process.env.OTEL_SERVICE_NAME;
    originalEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalServiceName === undefined) delete process.env.OTEL_SERVICE_NAME;
    else process.env.OTEL_SERVICE_NAME = originalServiceName;
    if (originalEndpoint === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalEndpoint;
  });

  it("bootstraps when OTEL_SERVICE_NAME is set", async () => {
    process.env.OTEL_SERVICE_NAME = "mymcp-test";
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318/v1/traces";
    const { otelBootstrapped } = await import("@/core/tracing");
    expect(otelBootstrapped).toBe(true);
  });

  it("does NOT bootstrap when OTEL_SERVICE_NAME is absent", async () => {
    delete process.env.OTEL_SERVICE_NAME;
    const { otelBootstrapped } = await import("@/core/tracing");
    expect(otelBootstrapped).toBe(false);
  });

  it("startToolSpan returns a real span when OTel is configured", async () => {
    process.env.OTEL_SERVICE_NAME = "mymcp-test";
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318/v1/traces";
    const { startToolSpan, endToolSpan } = await import("@/core/tracing");
    const span = startToolSpan("test_tool", "test_connector", ["arg1"]);
    // A real span won't have __noop
    expect((span as { __noop?: boolean }).__noop).not.toBe(true);
    endToolSpan(span, "ok", 42);
  });
});
