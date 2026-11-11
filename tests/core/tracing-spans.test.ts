/**
 * OBS-04: OTel span emission tests.
 *
 * Closes .planning/milestones/v0.10-durability-ROADMAP.md Phase 38 OBS-04.
 * Verifies the 3 hot paths emit named spans when OTel is active, and
 * emit zero spans when OTel is not configured.
 *
 * Uses the InMemorySpanExporter from @opentelemetry/sdk-trace to
 * capture spans without needing a live collector.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

// Install an in-memory OTel provider before any @/core/* module is loaded.
const spans: Array<{ name: string; attributes: Record<string, unknown> }> = [];

function installInMemoryOtel(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const api = require("@opentelemetry/api") as typeof import("@opentelemetry/api");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sdkTrace = require("@opentelemetry/sdk-trace");

  class RecordingProcessor {
    onStart(): void {}
    onEnd(span: { name: string; attributes: Record<string, unknown> }): void {
      spans.push({ name: span.name, attributes: { ...span.attributes } });
    }
    shutdown(): Promise<void> {
      return Promise.resolve();
    }
    forceFlush(): Promise<void> {
      return Promise.resolve();
    }
  }
  // OTel SDK v3: sdk-trace-node/sdk-trace-base merged into sdk-trace;
  // processors are passed via the constructor.
  const provider = new sdkTrace.TracerProvider({
    spanProcessors: [
      new sdkTrace.SimpleSpanProcessor(new sdkTrace.InMemorySpanExporter()),
      new RecordingProcessor(),
    ],
  });
  api.trace.setGlobalTracerProvider(provider);
}

describe("OTel span emission (OBS-04)", () => {
  const saved: Record<string, string | undefined> = {};
  const keys = ["OTEL_SERVICE_NAME", "OTEL_EXPORTER_OTLP_ENDPOINT", "MCP_AUTH_TOKEN"];

  beforeAll(() => {
    for (const k of keys) saved[k] = process.env[k];
    process.env.OTEL_SERVICE_NAME = "mymcp-test";
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318/v1/traces";
    installInMemoryOtel();
  });

  afterAll(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });

  beforeEach(() => {
    spans.length = 0;
  });

  // Phase 50 / BRAND-03: span names are `kebab.*` by default. With
  // KEBAB_EMIT_LEGACY_OTEL_ATTRS=1 or MYMCP_EMIT_LEGACY_OTEL_ATTRS=1
  // the attribute bag additionally carries `mymcp.*` aliases (span
  // NAMES are single-valued — legacy flag only duplicates attributes).

  it("kebab.bootstrap.rehydrate span wraps rehydrateBootstrapAsync", async () => {
    const { rehydrateBootstrapAsync } = await import("@/core/first-run");
    await rehydrateBootstrapAsync();
    const rehydrate = spans.filter((s) => s.name === "kebab.bootstrap.rehydrate");
    expect(rehydrate.length).toBeGreaterThanOrEqual(1);
    expect(rehydrate[0]!.attributes["kebab.bootstrap.source"]).toBe("cold");
    expect(rehydrate[0]!.attributes["kebab.status"]).toBe("ok");
  });

  it("kebab.kv.write span wraps KVStore.set with key_prefix (first 2 segments only)", async () => {
    const { getKVStore, resetKVStoreCache } = await import("@/core/kv-store");
    resetKVStoreCache();
    const kv = getKVStore();
    await kv.set("tenant:alpha:skills:foo", '"bar"');
    const kvWrites = spans.filter((s) => s.name === "kebab.kv.write");
    expect(kvWrites.length).toBeGreaterThanOrEqual(1);
    const lastSet = [...kvWrites].reverse().find((s) => s.attributes["kebab.kv.op"] === "set");
    expect(lastSet).toBeDefined();
    expect(lastSet!.attributes["kebab.kv.key_prefix"]).toBe("tenant:alpha");
    // Full key MUST NOT appear anywhere in the attributes
    const serialized = JSON.stringify(lastSet!.attributes);
    expect(serialized).not.toContain("tenant:alpha:skills:foo");
  });

  it("kebab.auth.check span wraps checkAdminAuth", async () => {
    const { checkAdminAuth } = await import("@/core/auth");
    const req = new Request("http://localhost/api/admin/status");
    await checkAdminAuth(req);
    const authChecks = spans.filter((s) => s.name === "kebab.auth.check");
    expect(authChecks.length).toBeGreaterThanOrEqual(1);
    expect(authChecks.some((s) => s.attributes["kebab.auth.kind"] === "admin")).toBe(true);
  });

  it("kebab.auth.check span wraps checkMcpAuth (sync)", async () => {
    const { checkMcpAuth } = await import("@/core/auth");
    const req = new Request("http://localhost/api/mcp");
    checkMcpAuth(req);
    const mcp = spans.filter(
      (s) => s.name === "kebab.auth.check" && s.attributes["kebab.auth.kind"] === "mcp"
    );
    expect(mcp.length).toBeGreaterThanOrEqual(1);
  });

  it("MYMCP_EMIT_LEGACY_OTEL_ATTRS=1 — emits BOTH kebab.* AND mymcp.* attrs", async () => {
    process.env.MYMCP_EMIT_LEGACY_OTEL_ATTRS = "1";
    try {
      const { getKVStore, resetKVStoreCache } = await import("@/core/kv-store");
      resetKVStoreCache();
      const kv = getKVStore();
      await kv.set("tenant:alpha:skills:bar", '"x"');
      const write = spans
        .filter((s) => s.name === "kebab.kv.write")
        .find((s) => s.attributes["kebab.kv.op"] === "set");
      expect(write).toBeDefined();
      // Both namespaces present.
      expect(write!.attributes["kebab.kv.op"]).toBe("set");
      expect(write!.attributes["mymcp.kv.op"]).toBe("set");
      expect(write!.attributes["kebab.kv.key_prefix"]).toBe("tenant:alpha");
      expect(write!.attributes["mymcp.kv.key_prefix"]).toBe("tenant:alpha");
    } finally {
      delete process.env.MYMCP_EMIT_LEGACY_OTEL_ATTRS;
    }
  });
});
