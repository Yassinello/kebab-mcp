/**
 * v0.20 — per-tenant isolation for the per-token connector scope.
 *
 * A connector allowlist written under one tenant must be invisible under
 * another. Mirrors the tenant-flip pattern of tests/core/tool-toggles.test.ts:
 * a single shared KV backing map, keys prefixed per tenant, and `mockTenantId`
 * flipped between operations.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const mockKV: Record<string, string> = {};

function baseStore() {
  return {
    kind: "filesystem" as const,
    get: async (key: string) => mockKV[key] ?? null,
    set: async (key: string, value: string) => {
      mockKV[key] = value;
    },
    delete: async (key: string) => {
      delete mockKV[key];
    },
    list: async (prefix?: string) =>
      Object.keys(mockKV).filter((k) => (prefix ? k.startsWith(prefix) : true)),
  };
}

function prefixed(tenantId: string | null) {
  if (tenantId === null) return baseStore();
  const pk = (k: string) => `tenant:${tenantId}:${k}`;
  return {
    kind: "filesystem" as const,
    get: async (key: string) => mockKV[pk(key)] ?? null,
    set: async (key: string, value: string) => {
      mockKV[pk(key)] = value;
    },
    delete: async (key: string) => {
      delete mockKV[pk(key)];
    },
    list: async (prefix?: string) => {
      const full = pk(prefix ?? "");
      return Object.keys(mockKV)
        .filter((k) => k.startsWith(full))
        .map((k) => k.slice(`tenant:${tenantId}:`.length));
    },
  };
}

let mockTenantId: string | null = null;
vi.mock("@/core/request-context", () => ({
  getCurrentTenantId: () => mockTenantId,
  getContextKVStore: () => prefixed(mockTenantId),
}));

// devices.ts also imports config-facade + env-store; the scope helpers under
// test only touch getContextKVStore, but the module graph still resolves them.
vi.mock("@/core/config-facade", () => ({
  getConfig: () => undefined,
}));
vi.mock("@/core/env-store", () => ({
  getEnvStore: () => ({
    kind: "filesystem" as const,
    read: async () => ({}),
    write: async () => ({ written: 0 }),
    delete: async () => ({ deleted: false }),
  }),
}));

import { setDeviceConnectors, getDeviceConnectors } from "@/core/devices";
import { resolveTokenConnectorScope } from "@/core/token-scope";

beforeEach(() => {
  for (const k of Object.keys(mockKV)) delete mockKV[k];
  mockTenantId = null;
});

describe("connector scope tenant isolation", () => {
  it("a scope set under tenant alpha is invisible under tenant beta", async () => {
    mockTenantId = "alpha";
    await setDeviceConnectors("tok1", ["apify", "unipile"]);
    expect(await getDeviceConnectors("tok1")).toEqual(["apify", "unipile"]);

    mockTenantId = "beta";
    expect(await getDeviceConnectors("tok1")).toBeNull();
    expect(await resolveTokenConnectorScope("tok1")).toBeNull();

    mockTenantId = "alpha";
    const scope = await resolveTokenConnectorScope("tok1");
    expect(scope).not.toBeNull();
    expect(scope!.has("apify")).toBe(true);
  });

  it("null-tenant (single-user) scope does not leak into a tenant", async () => {
    mockTenantId = null;
    await setDeviceConnectors("tok2", ["apify"]);
    expect(await getDeviceConnectors("tok2")).toEqual(["apify"]);

    mockTenantId = "alpha";
    expect(await getDeviceConnectors("tok2")).toBeNull();
  });
});
