import { describe, it, expect } from "vitest";
import { getTenantId, withTenantPrefix, TenantError } from "./tenant";

describe("getTenantId", () => {
  it("returns null when header is absent", () => {
    const req = new Request("http://localhost/api/mcp");
    expect(getTenantId(req)).toBeNull();
  });

  it("returns null when header is empty string", () => {
    const req = new Request("http://localhost/api/mcp", {
      headers: { "x-mymcp-tenant": "" },
    });
    expect(getTenantId(req)).toBeNull();
  });

  it("returns lowercased tenant id", () => {
    const req = new Request("http://localhost/api/mcp", {
      headers: { "x-mymcp-tenant": "Acme-Corp" },
    });
    expect(getTenantId(req)).toBe("acme-corp");
  });

  it("trims whitespace", () => {
    const req = new Request("http://localhost/api/mcp", {
      headers: { "x-mymcp-tenant": "  tenant1  " },
    });
    expect(getTenantId(req)).toBe("tenant1");
  });

  it("throws on invalid tenant id", () => {
    const req = new Request("http://localhost/api/mcp", {
      headers: { "x-mymcp-tenant": "bad tenant!" },
    });
    expect(() => getTenantId(req)).toThrow(TenantError);
  });

  it("throws on tenant id starting with hyphen", () => {
    const req = new Request("http://localhost/api/mcp", {
      headers: { "x-mymcp-tenant": "-leading" },
    });
    expect(() => getTenantId(req)).toThrow(TenantError);
  });
});

describe("withTenantPrefix", () => {
  it("returns key unchanged for null tenantId", () => {
    expect(withTenantPrefix("settings:name", null)).toBe("settings:name");
  });

  it("prefixes key for non-null tenantId", () => {
    expect(withTenantPrefix("settings:name", "acme")).toBe("tenant:acme:settings:name");
  });

  it("prefixes empty key correctly", () => {
    expect(withTenantPrefix("", "acme")).toBe("tenant:acme:");
  });
});

describe("getTenantId — Q-03 x-kebab-tenant alias", () => {
  it("accepts x-kebab-tenant and prefers it over the legacy header", async () => {
    const { getTenantId } = await import("./tenant");
    const both = new Request("http://x/", {
      headers: { "x-kebab-tenant": "acme", "x-mymcp-tenant": "legacy" },
    });
    expect(getTenantId(both)).toBe("acme");
    const legacy = new Request("http://x/", { headers: { "x-mymcp-tenant": "legacy" } });
    expect(getTenantId(legacy)).toBe("legacy");
  });
});
