/**
 * SEC-03 regression: /api/admin/call wraps tool invocations in
 * requestContext.run so tool handlers see the tenant from the
 * x-mymcp-tenant header.
 *
 * Before this fix, playground tool calls silently operated on the
 * untenanted KV namespace even when called from a tenant-aware
 * dashboard session. See .planning/research/RISKS-AUDIT.md #4.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getCurrentTenantId, getContextKVStore } from "@/core/request-context";
import type { ConnectorManifest } from "@/core/types";

// Stub KV captures every write with the full prefixed key so we can
// assert tenant prefixing actually happened.
const store = new Map<string, string>();

// Mock the kv-store module directly so getTenantKVStore uses our stub.
vi.mock("@/core/kv-store", () => {
  const inner = {
    kind: "filesystem" as const,
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string) => {
      store.set(k, v);
    },
    delete: async (k: string) => {
      store.delete(k);
    },
    list: async (prefix?: string) =>
      Array.from(store.keys()).filter((k) => (prefix ? k.startsWith(prefix) : true)),
  };

  function withTenantPrefixLocal(key: string, tenantId: string | null): string {
    if (tenantId === null) return key;
    return `tenant:${tenantId}:${key}`;
  }

  return {
    getKVStore: () => inner,
    getTenantKVStore: (tenantId: string | null) => {
      if (tenantId === null) return inner;
      return {
        kind: inner.kind,
        get: (k: string) => inner.get(withTenantPrefixLocal(k, tenantId)),
        set: (k: string, v: string) => inner.set(withTenantPrefixLocal(k, tenantId), v),
        delete: (k: string) => inner.delete(withTenantPrefixLocal(k, tenantId)),
        list: (prefix?: string) => inner.list(withTenantPrefixLocal(prefix ?? "", tenantId)),
      };
    },
    kvScanAll: async (_kv: unknown, _match?: string) => [] as string[],
    resetKVStoreCache: () => {},
    clearKVReadCache: () => {},
  };
});

// Stub registry to expose a synthetic test tool that writes through
// the request context.
vi.mock("@/core/registry", () => {
  const testTool: ConnectorManifest["tools"][number] = {
    name: "test_probe_write",
    description: "Write a probe value via getContextKVStore to verify tenant isolation.",
    destructive: false,
    schema: {},
    handler: async (p: Record<string, unknown>) => {
      const key = String(p.key ?? "probe");
      const value = String(p.value ?? "v");
      const tenantAtCall = getCurrentTenantId();
      const kv = getContextKVStore();
      await kv.set(key, value);
      return { content: [{ type: "text", text: JSON.stringify({ tenantAtCall }) }] };
    },
  };
  const manifest: ConnectorManifest = {
    id: "test-connector",
    label: "Test Connector",
    description: "synthetic",
    requiredEnvVars: [],
    tools: [testTool],
  } as ConnectorManifest;
  return {
    getEnabledPacks: () => [{ manifest, enabled: true, disabledReason: null }],
    resolveRegistry: () => [{ manifest, enabled: true, disabledReason: null }],
    logRegistryState: () => {},
  };
});

// Minimal logging stub (no-op passthrough).
vi.mock("@/core/logging", () => ({
  withLogging:
    (_name: string, fn: (p: Record<string, unknown>) => Promise<unknown>) =>
    (p: Record<string, unknown>) =>
      fn(p),
}));

// Bypass admin auth for the test harness.
vi.mock("@/core/auth", async () => {
  const actual = await vi.importActual<typeof import("@/core/auth")>("@/core/auth");
  return {
    ...actual,
    checkAdminAuth: async () => null,
  };
});

describe("POST /api/admin/call — tenant context (SEC-03)", () => {
  beforeEach(() => {
    store.clear();
  });

  afterEach(() => {
    store.clear();
  });

  it("writes KV keys under the tenant prefix when x-mymcp-tenant is set", async () => {
    const { POST } = await import("../../app/api/admin/call/route");
    const req = new Request("http://mymcp.local/api/admin/call", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mymcp-tenant": "alpha",
      },
      body: JSON.stringify({
        tool: "test_probe_write",
        params: { key: "probe", value: "alpha-write" },
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { content: { text: string }[] } };
    const inner = JSON.parse(body.result.content[0].text) as { tenantAtCall: string };
    expect(inner.tenantAtCall).toBe("alpha");

    // Tenant-scoped key was written.
    expect(store.get("tenant:alpha:probe")).toBe("alpha-write");
    // Untenanted key was NOT written.
    expect(store.get("probe")).toBeUndefined();
  });

  it("defaults to null tenant (no prefix) when x-mymcp-tenant is absent", async () => {
    const { POST } = await import("../../app/api/admin/call/route");
    const req = new Request("http://mymcp.local/api/admin/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tool: "test_probe_write",
        params: { key: "default-key", value: "default-write" },
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { content: { text: string }[] } };
    const inner = JSON.parse(body.result.content[0].text) as { tenantAtCall: string | null };
    expect(inner.tenantAtCall).toBeNull();

    expect(store.get("default-key")).toBe("default-write");
  });

  it("tenant A and tenant B writes to the same key land in different namespaces", async () => {
    const { POST } = await import("../../app/api/admin/call/route");

    // Tenant A writes
    await POST(
      new Request("http://mymcp.local/api/admin/call", {
        method: "POST",
        headers: { "content-type": "application/json", "x-mymcp-tenant": "alpha" },
        body: JSON.stringify({ tool: "test_probe_write", params: { key: "shared", value: "A" } }),
      })
    );
    // Tenant B writes the same key.
    await POST(
      new Request("http://mymcp.local/api/admin/call", {
        method: "POST",
        headers: { "content-type": "application/json", "x-mymcp-tenant": "beta" },
        body: JSON.stringify({ tool: "test_probe_write", params: { key: "shared", value: "B" } }),
      })
    );

    expect(store.get("tenant:alpha:shared")).toBe("A");
    expect(store.get("tenant:beta:shared")).toBe("B");
    expect(store.get("shared")).toBeUndefined();
  });

  it("returns 400 for a malformed x-mymcp-tenant header", async () => {
    const { POST } = await import("../../app/api/admin/call/route");
    const req = new Request("http://mymcp.local/api/admin/call", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mymcp-tenant": "INVALID spaces!!",
      },
      body: JSON.stringify({ tool: "test_probe_write", params: {} }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});
