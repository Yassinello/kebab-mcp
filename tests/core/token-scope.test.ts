/**
 * Unit tests for src/core/token-scope.ts.
 *
 * Covers resolveTokenAccess / resolveTokenConnectorScope / isConnectorAllowed:
 *   - null / empty caller token → no filter (full access)
 *   - no stored entry (KV-only bootstrap token) → no filter
 *   - stored allowlist → strict set ∪ scope-exempt core (skills, NOT admin)
 *   - corrupt entry → fail closed (SEC-04)
 *   - revoked tombstone → revoked (SEC-06)
 *   - root-namespace scope still applies under an arbitrary tenant header
 *     (SEC-04 exploit regression)
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Two namespaces backed by plain maps: root (null tenant) and tenant.
const rootKV = new Map<string, string>();
const tenantKVs = new Map<string, Map<string, string>>();
let currentTenant: string | null = null;

function mapStore(m: Map<string, string>) {
  return {
    get: async (k: string) => m.get(k) ?? null,
    set: async (k: string, v: string) => {
      m.set(k, v);
    },
  };
}

vi.mock("@/core/kv-store", () => ({
  getKVStore: () => mapStore(rootKV),
  getTenantKVStore: (t: string | null) => {
    if (t === null) return mapStore(rootKV);
    if (!tenantKVs.has(t)) tenantKVs.set(t, new Map());
    return mapStore(tenantKVs.get(t)!);
  },
  kvScanAll: async () => [],
}));

vi.mock("@/core/request-context", () => ({
  getCurrentTenantId: () => currentTenant,
  getContextKVStore: () => {
    if (currentTenant === null) return mapStore(rootKV);
    if (!tenantKVs.has(currentTenant)) tenantKVs.set(currentTenant, new Map());
    return mapStore(tenantKVs.get(currentTenant)!);
  },
}));

import {
  resolveTokenAccess,
  resolveTokenConnectorScope,
  isConnectorAllowed,
  getScopeExemptConnectorIds,
} from "@/core/token-scope";
import { CORE_CONNECTOR_IDS } from "@/core/registry";

function put(kv: Map<string, string>, id: string, entry: unknown) {
  kv.set(`devices:${id}`, typeof entry === "string" ? entry : JSON.stringify(entry));
}

beforeEach(() => {
  rootKV.clear();
  tenantKVs.clear();
  currentTenant = null;
});

describe("resolveTokenConnectorScope", () => {
  it("returns null (no filter) when caller token is null/undefined/empty", async () => {
    expect(await resolveTokenConnectorScope(null)).toBeNull();
    expect(await resolveTokenConnectorScope(undefined)).toBeNull();
    expect(await resolveTokenConnectorScope("")).toBeNull();
  });

  it("returns null (no filter) when no entry is stored — KV-only bootstrap token", async () => {
    expect(await resolveTokenConnectorScope("abcd1234")).toBeNull();
  });

  it("returns null when an entry exists without a connectors field", async () => {
    put(rootKV, "abcd1234", { label: "laptop", createdAt: "x" });
    expect(await resolveTokenConnectorScope("abcd1234")).toBeNull();
  });

  it("returns the allowlist ∪ skills (not admin) when a scope is stored", async () => {
    put(rootKV, "abcd1234", { label: "agent", createdAt: "x", connectors: ["apify", "unipile"] });
    const scope = await resolveTokenConnectorScope("abcd1234");
    expect(scope).not.toBeNull();
    expect(scope!.has("apify")).toBe(true);
    expect(scope!.has("unipile")).toBe(true);
    expect(scope!.has("skills")).toBe(true);
    // SEC-03: admin is core but must be granted explicitly.
    expect(scope!.has("admin")).toBe(false);
    expect(scope!.has("google")).toBe(false);
  });

  it("grants admin when it is listed explicitly", async () => {
    put(rootKV, "abcd1234", { label: "ops", createdAt: "x", connectors: ["admin"] });
    const scope = await resolveTokenConnectorScope("abcd1234");
    expect(scope!.has("admin")).toBe(true);
  });

  it("returns skills-only when the allowlist is empty", async () => {
    put(rootKV, "abcd1234", { label: "x", createdAt: "x", connectors: [] });
    const scope = await resolveTokenConnectorScope("abcd1234");
    expect([...scope!]).toEqual(getScopeExemptConnectorIds());
  });
});

describe("resolveTokenAccess — SEC-04 / SEC-06", () => {
  it("fails closed on corrupt JSON", async () => {
    put(rootKV, "abcd1234", "{not json");
    const access = await resolveTokenAccess("abcd1234");
    expect(access.kind).toBe("scoped");
    if (access.kind === "scoped") expect(access.connectors.has("google")).toBe(false);
  });

  it("fails closed when connectors is present but not a string array", async () => {
    put(rootKV, "abcd1234", { label: "x", createdAt: "x", connectors: "google" });
    const access = await resolveTokenAccess("abcd1234");
    expect(access.kind).toBe("scoped");
  });

  it("returns revoked for a tombstoned token", async () => {
    put(rootKV, "abcd1234", { label: "x", createdAt: "x", revokedAt: "2026-11-11T00:00:00Z" });
    expect((await resolveTokenAccess("abcd1234")).kind).toBe("revoked");
  });

  it("EXPLOIT: a scoped global token cannot shed its scope via an arbitrary tenant header", async () => {
    put(rootKV, "abcd1234", { label: "agent", createdAt: "x", connectors: ["apify"] });
    currentTenant = "anything";
    const access = await resolveTokenAccess("abcd1234");
    expect(access.kind).toBe("scoped");
    if (access.kind === "scoped") {
      expect(access.connectors.has("apify")).toBe(true);
      expect(access.connectors.has("google")).toBe(false);
    }
  });

  it("keeps the most restrictive answer when both namespaces carry a scope", async () => {
    put(rootKV, "abcd1234", { label: "a", createdAt: "x", connectors: ["apify", "slack"] });
    currentTenant = "acme";
    tenantKVs.set("acme", new Map());
    put(tenantKVs.get("acme")!, "abcd1234", {
      label: "a",
      createdAt: "x",
      connectors: ["slack", "notion"],
    });
    const access = await resolveTokenAccess("abcd1234");
    expect(access.kind).toBe("scoped");
    if (access.kind === "scoped") {
      expect(access.connectors.has("slack")).toBe(true);
      expect(access.connectors.has("apify")).toBe(false);
      expect(access.connectors.has("notion")).toBe(false);
    }
  });

  it("a tenant-only scope applies to a tenant-specific token", async () => {
    currentTenant = "acme";
    tenantKVs.set("acme", new Map());
    put(tenantKVs.get("acme")!, "abcd1234", { label: "a", createdAt: "x", connectors: ["slack"] });
    const access = await resolveTokenAccess("abcd1234");
    expect(access.kind).toBe("scoped");
  });

  it("revoked in the root namespace wins over a tenant entry", async () => {
    put(rootKV, "abcd1234", { label: "a", createdAt: "x", revokedAt: "now" });
    currentTenant = "acme";
    expect((await resolveTokenAccess("abcd1234")).kind).toBe("revoked");
  });
});

describe("isConnectorAllowed", () => {
  it("allows everything when scope is null (no filter)", () => {
    expect(isConnectorAllowed(null, "google")).toBe(true);
  });

  it("allows only members of a non-null scope", () => {
    const scope = new Set(["apify", "unipile"]);
    expect(isConnectorAllowed(scope, "apify")).toBe(true);
    expect(isConnectorAllowed(scope, "google")).toBe(false);
  });
});

describe("core connector set sanity", () => {
  it("admin and skills are core; only skills is scope-exempt", () => {
    expect(CORE_CONNECTOR_IDS).toContain("admin");
    expect(CORE_CONNECTOR_IDS).toContain("skills");
    expect(getScopeExemptConnectorIds()).toContain("skills");
    expect(getScopeExemptConnectorIds()).not.toContain("admin");
  });
});
