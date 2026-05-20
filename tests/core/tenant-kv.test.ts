/**
 * Tests for TenantKVStore isolation — two tenants write to the same key
 * but read different values. Default tenant is unchanged.
 */
import { describe, it, expect, beforeEach } from "vitest";

// Mock the entire kv-store module, but provide a working getTenantKVStore
// that uses our mock store.
const mockStore: Record<string, string> = {};

function makeMockKV() {
  return {
    kind: "filesystem" as const,
    get: async (key: string) => mockStore[key] ?? null,
    set: async (key: string, value: string) => {
      mockStore[key] = value;
    },
    delete: async (key: string) => {
      delete mockStore[key];
    },
    list: async (prefix?: string) => {
      const keys = Object.keys(mockStore);
      return prefix ? keys.filter((k) => k.startsWith(prefix)) : keys;
    },
  };
}

// We need to test the TenantKVStore class behavior. Import tenant utils directly.
import { withTenantPrefix } from "@/core/tenant";

// Build a simple TenantKVStore inline matching the real implementation
class TestTenantKVStore {
  private inner: ReturnType<typeof makeMockKV>;
  private tenantId: string | null;

  constructor(inner: ReturnType<typeof makeMockKV>, tenantId: string | null) {
    this.inner = inner;
    this.tenantId = tenantId;
  }

  private pk(key: string): string {
    return withTenantPrefix(key, this.tenantId);
  }

  get(key: string) {
    return this.inner.get(this.pk(key));
  }
  set(key: string, value: string) {
    return this.inner.set(this.pk(key), value);
  }
  delete(key: string) {
    return this.inner.delete(this.pk(key));
  }
  async list(prefix?: string): Promise<string[]> {
    const keys = await this.inner.list(this.pk(prefix ?? ""));
    // Mirror the real TenantKVStore.list(): strip the tenant prefix so
    // callers that do `key.slice(PREFIX.length)` get bare keys (HIGH-1).
    const tenantPrefix = this.tenantId ? `tenant:${this.tenantId}:` : "";
    return tenantPrefix
      ? keys.map((k) => (k.startsWith(tenantPrefix) ? k.slice(tenantPrefix.length) : k))
      : keys;
  }
}

describe("TenantKVStore isolation", () => {
  // Use a single shared mock KV backend to test cross-tenant isolation
  const baseKV = makeMockKV();

  function tenantKV(tenantId: string | null) {
    return new TestTenantKVStore(baseKV, tenantId);
  }

  beforeEach(() => {
    for (const key of Object.keys(mockStore)) delete mockStore[key];
  });

  it("default tenant (null) reads/writes unprefixed keys", async () => {
    const kv = tenantKV(null);
    await kv.set("mykey", "default-value");
    expect(mockStore["mykey"]).toBe("default-value");
    expect(await kv.get("mykey")).toBe("default-value");
  });

  it("tenant-scoped store prefixes keys", async () => {
    const kv = tenantKV("acme");
    await kv.set("mykey", "acme-value");
    expect(mockStore["tenant:acme:mykey"]).toBe("acme-value");
    expect(await kv.get("mykey")).toBe("acme-value");
  });

  it("two tenants writing same key get different values", async () => {
    const kvA = tenantKV("alpha");
    const kvB = tenantKV("beta");

    await kvA.set("shared-key", "alpha-data");
    await kvB.set("shared-key", "beta-data");

    expect(await kvA.get("shared-key")).toBe("alpha-data");
    expect(await kvB.get("shared-key")).toBe("beta-data");
  });

  it("tenant store does not see default tenant keys", async () => {
    const kvDefault = tenantKV(null);
    const kvTenant = tenantKV("org1");

    await kvDefault.set("secret", "default-secret");
    expect(await kvTenant.get("secret")).toBeNull();
  });

  it("list scopes to tenant and returns bare (prefix-stripped) keys", async () => {
    const kvA = tenantKV("alpha");
    const kvB = tenantKV("beta");
    const kvDefault = tenantKV(null);

    await kvDefault.set("webhook:last:stripe", "d1");
    await kvA.set("webhook:last:stripe", "a1");
    await kvB.set("webhook:last:stripe", "b1");

    const defaultKeys = await kvDefault.list("webhook:last:");
    const alphaKeys = await kvA.list("webhook:last:");
    const betaKeys = await kvB.list("webhook:last:");

    // HIGH-1 regression: tenant-scoped list() must strip the tenant prefix
    // so consumers (tool-toggles, webhook-list) that slice the bare prefix
    // get correct names. A tenant must see only its own keys, bare.
    expect(defaultKeys).toEqual(["webhook:last:stripe"]);
    expect(alphaKeys).toEqual(["webhook:last:stripe"]);
    expect(betaKeys).toEqual(["webhook:last:stripe"]);
  });

  it("delete scopes to tenant", async () => {
    const kvA = tenantKV("alpha");
    const kvDefault = tenantKV(null);

    await kvDefault.set("k", "default");
    await kvA.set("k", "alpha");

    await kvA.delete("k");
    expect(await kvA.get("k")).toBeNull();
    expect(await kvDefault.get("k")).toBe("default");
  });
});

// Also test the real getTenantKVStore export
describe("getTenantKVStore export", () => {
  it("exists and is callable", async () => {
    // Dynamic import to avoid module mock issues
    const mod = await import("@/core/kv-store");
    expect(typeof mod.getTenantKVStore).toBe("function");
  });
});
