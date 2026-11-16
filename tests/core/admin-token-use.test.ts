/**
 * Audit 2026-11 (A2, contract 2) — the transport records, throttled to once
 * an hour, that an MCP client authenticated with the key that also opens
 * the dashboard: KV `security:admin-token-mcp-last` (ISO timestamp).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const store = new Map<string, string>();
let envVars: Record<string, string> = {};
const pending: Promise<unknown>[] = [];

vi.mock("@/core/config-facade", () => ({
  getConfig: (k: string) => envVars[k],
  getConfigInt: (_k: string, d: number) => d,
}));
vi.mock("@/core/request-context", () => ({
  getContextKVStore: () => ({
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string) => void store.set(k, v),
  }),
  getCurrentTenantId: () => null,
}));
vi.mock("@/core/after-response", () => ({
  runAfterResponse: (task: () => Promise<unknown>) => {
    pending.push(task());
  },
}));

import {
  ADMIN_TOKEN_MCP_LAST_KEY,
  __resetAdminTokenUseForTests,
  noteAdminTokenMcpUse,
} from "@/core/admin-token-use";
import { tokenId } from "@/core/auth";

const SHARED = "s".repeat(64);
const OTHER = "o".repeat(64);

async function flush() {
  await Promise.all(pending.splice(0));
}

beforeEach(() => {
  store.clear();
  envVars = {};
  __resetAdminTokenUseForTests();
});

describe("noteAdminTokenMcpUse", () => {
  it("records when the MCP token also opens the dashboard (no separate admin key)", async () => {
    envVars.MCP_AUTH_TOKEN = `${SHARED},${OTHER}`;
    noteAdminTokenMcpUse(tokenId(SHARED));
    await flush();
    const at = store.get(ADMIN_TOKEN_MCP_LAST_KEY);
    expect(at).toBeDefined();
    expect(new Date(at!).toISOString()).toBe(at);
  });

  it("is throttled to once an hour (in-process and in KV)", async () => {
    envVars.MCP_AUTH_TOKEN = SHARED;
    noteAdminTokenMcpUse(tokenId(SHARED));
    await flush();
    store.set(ADMIN_TOKEN_MCP_LAST_KEY, "marker-unchanged");
    noteAdminTokenMcpUse(tokenId(SHARED));
    await flush();
    expect(store.get(ADMIN_TOKEN_MCP_LAST_KEY)).toBe("marker-unchanged");
    // Another process (fresh in-memory throttle) sees a recent KV value.
    __resetAdminTokenUseForTests();
    const recent = new Date(Date.now() - 60_000).toISOString();
    store.set(ADMIN_TOKEN_MCP_LAST_KEY, recent);
    noteAdminTokenMcpUse(tokenId(SHARED));
    await flush();
    expect(store.get(ADMIN_TOKEN_MCP_LAST_KEY)).toBe(recent);
    // An old value is refreshed.
    __resetAdminTokenUseForTests();
    store.set(ADMIN_TOKEN_MCP_LAST_KEY, new Date(Date.now() - 2 * 3600_000).toISOString());
    noteAdminTokenMcpUse(tokenId(SHARED));
    await flush();
    expect(Date.parse(store.get(ADMIN_TOKEN_MCP_LAST_KEY)!)).toBeGreaterThan(Date.now() - 5000);
  });

  it("does not record device tokens when a separate admin key is set", async () => {
    envVars.MCP_AUTH_TOKEN = SHARED;
    envVars.ADMIN_AUTH_TOKEN = OTHER;
    noteAdminTokenMcpUse(tokenId(SHARED));
    await flush();
    expect(store.has(ADMIN_TOKEN_MCP_LAST_KEY)).toBe(false);
    // …but does when a client uses that admin key on the MCP endpoint.
    noteAdminTokenMcpUse(tokenId(OTHER));
    await flush();
    expect(store.has(ADMIN_TOKEN_MCP_LAST_KEY)).toBe(true);
  });

  it("does not record OAuth devices, loopback calls, or a production instance that refuses the fallback", async () => {
    envVars.MCP_AUTH_TOKEN = SHARED;
    noteAdminTokenMcpUse("0a1b2c3d");
    noteAdminTokenMcpUse(null);
    await flush();
    expect(store.has(ADMIN_TOKEN_MCP_LAST_KEY)).toBe(false);
    envVars.NODE_ENV = "production";
    noteAdminTokenMcpUse(tokenId(SHARED));
    await flush();
    expect(store.has(ADMIN_TOKEN_MCP_LAST_KEY)).toBe(false);
  });
});
