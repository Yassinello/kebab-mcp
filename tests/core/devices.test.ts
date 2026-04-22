/**
 * Phase 52 / DEV-02 — unit tests for src/core/devices.ts.
 *
 * Covers:
 *   - listDevices: empty / multi-token / KV-label hydration / fallback
 *   - setDeviceLabel: validation + preserves createdAt
 *   - deleteDevice: KV entry + rate-limit buckets cleared
 *   - rotateDeviceToken: comma-list splice without disturbing others
 *   - getLastSeenAt: null / latest bucket
 *   - clearDeviceRateLimit: sweep count
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const store = new Map<string, string>();
let envVars: Record<string, string> = {};

// Scoped by default tenant (null). TenantKVStore passthrough for null → no prefix.
vi.mock("@/core/request-context", () => {
  const kv = {
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
    scan: async (cursor: string, opts?: { match?: string; count?: number }) => {
      const match = opts?.match ?? "*";
      const prefix = match.endsWith("*") ? match.slice(0, -1) : match;
      const all = Array.from(store.keys()).filter((k) =>
        match.endsWith("*") ? k.startsWith(prefix) : k === match
      );
      const offset = cursor === "0" ? 0 : parseInt(cursor, 10) || 0;
      const count = opts?.count ?? 100;
      const slice = all.slice(offset, offset + count);
      const nextOffset = offset + count;
      const nextCursor = nextOffset >= all.length ? "0" : String(nextOffset);
      return { cursor: nextCursor, keys: slice };
    },
  };
  return {
    getContextKVStore: () => kv,
    getCurrentTenantId: () => null,
  };
});

vi.mock("@/core/config-facade", () => ({
  getConfig: (key: string) => envVars[key],
}));

vi.mock("@/core/env-store", () => ({
  getEnvStore: () => ({
    kind: "filesystem" as const,
    read: async () => ({ ...envVars }),
    write: async (vars: Record<string, string>) => {
      envVars = { ...envVars, ...vars };
      return { written: Object.keys(vars).length };
    },
    delete: async (key: string) => {
      const had = key in envVars;
      delete envVars[key];
      return { deleted: had };
    },
  }),
}));

// Import under test AFTER mocks.
import {
  listDevices,
  setDeviceLabel,
  deleteDevice,
  rotateDeviceToken,
  getLastSeenAt,
  clearDeviceRateLimit,
} from "@/core/devices";
import { tokenId } from "@/core/auth";
import { createHash } from "node:crypto";

function idHash16(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

const TOKEN_A = "a".repeat(64);
const TOKEN_B = "b".repeat(64);

beforeEach(() => {
  store.clear();
  envVars = {};
});

describe("listDevices", () => {
  it("returns [] when MCP_AUTH_TOKEN is unset", async () => {
    const rows = await listDevices();
    expect(rows).toEqual([]);
  });

  it("returns one row per token; tokenId matches auth.tokenId()", async () => {
    envVars.MCP_AUTH_TOKEN = `${TOKEN_A},${TOKEN_B}`;
    const rows = await listDevices();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.tokenId).toBe(tokenId(TOKEN_A));
    expect(rows[1]!.tokenId).toBe(tokenId(TOKEN_B));
  });

  it("hydrates label from KV when present, 'unnamed' when absent", async () => {
    envVars.MCP_AUTH_TOKEN = TOKEN_A;
    store.set(
      `devices:${tokenId(TOKEN_A)}`,
      JSON.stringify({ label: "Claude Desktop", createdAt: "2026-04-22T00:00:00.000Z" })
    );
    const rows = await listDevices();
    expect(rows[0]!.label).toBe("Claude Desktop");
    expect(rows[0]!.createdAt).toBe("2026-04-22T00:00:00.000Z");

    envVars.MCP_AUTH_TOKEN = `${TOKEN_A},${TOKEN_B}`;
    const rows2 = await listDevices();
    const rowB = rows2.find((r) => r.tokenId === tokenId(TOKEN_B))!;
    expect(rowB.label).toBe("unnamed");
    expect(rowB.createdAt).toBe("unknown");
  });
});

describe("setDeviceLabel", () => {
  it("rejects empty / newline / >40-char labels", async () => {
    await expect(setDeviceLabel("abcd1234", "")).rejects.toThrow(/label/i);
    await expect(setDeviceLabel("abcd1234", "  ")).rejects.toThrow(/label/i);
    await expect(setDeviceLabel("abcd1234", "has\nnewline")).rejects.toThrow(/label/i);
    await expect(setDeviceLabel("abcd1234", "x".repeat(41))).rejects.toThrow(/label/i);
  });

  it("accepts a normal label and writes KV", async () => {
    await setDeviceLabel("abcd1234", "Claude Desktop");
    const raw = store.get("devices:abcd1234");
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.label).toBe("Claude Desktop");
    expect(typeof parsed.createdAt).toBe("string");
  });

  it("preserves createdAt when entry already exists", async () => {
    const original = "2026-01-01T00:00:00.000Z";
    store.set("devices:abcd1234", JSON.stringify({ label: "Old", createdAt: original }));
    await setDeviceLabel("abcd1234", "Renamed");
    const parsed = JSON.parse(store.get("devices:abcd1234")!);
    expect(parsed.label).toBe("Renamed");
    expect(parsed.createdAt).toBe(original);
  });
});

describe("deleteDevice", () => {
  it("deletes KV entry + clears rate-limit buckets", async () => {
    const tid = tokenId(TOKEN_A);
    const hash = idHash16(TOKEN_A);
    store.set(`devices:${tid}`, JSON.stringify({ label: "L", createdAt: "x" }));
    store.set(`ratelimit:mcp:${hash}:100`, "1");
    store.set(`ratelimit:mcp:${hash}:101`, "1");
    store.set(`ratelimit:admin:${hash}:100`, "3");
    // Unrelated bucket — MUST NOT be touched
    store.set(`ratelimit:mcp:deadbeefdeadbeef:100`, "99");

    const result = await deleteDevice(tid, TOKEN_A);
    expect(result.kvDeleted).toBe(true);
    expect(result.rateLimitBucketsDeleted).toBe(3);
    expect(store.has(`devices:${tid}`)).toBe(false);
    expect(store.has(`ratelimit:mcp:${hash}:100`)).toBe(false);
    expect(store.has(`ratelimit:mcp:${hash}:101`)).toBe(false);
    expect(store.has(`ratelimit:admin:${hash}:100`)).toBe(false);
    expect(store.has(`ratelimit:mcp:deadbeefdeadbeef:100`)).toBe(true);
  });
});

describe("rotateDeviceToken", () => {
  it("replaces the correct token; preserves others; returns 64-hex distinct token", async () => {
    envVars.MCP_AUTH_TOKEN = `${TOKEN_A},${TOKEN_B}`;
    const tidA = tokenId(TOKEN_A);
    store.set(
      `devices:${tidA}`,
      JSON.stringify({ label: "Device A", createdAt: "2026-01-01T00:00:00.000Z" })
    );

    const { newToken, newTokenId } = await rotateDeviceToken(tidA);

    expect(newToken).toMatch(/^[a-f0-9]{64}$/);
    expect(newToken).not.toBe(TOKEN_A);
    expect(newTokenId).toBe(tokenId(newToken));

    const parts = envVars.MCP_AUTH_TOKEN!.split(",");
    expect(parts).toHaveLength(2);
    expect(parts).toContain(newToken);
    expect(parts).toContain(TOKEN_B);
    expect(parts).not.toContain(TOKEN_A);

    // Old KV entry gone, new one carries preserved label
    expect(store.has(`devices:${tidA}`)).toBe(false);
    const newRaw = store.get(`devices:${newTokenId}`);
    expect(newRaw).toBeTruthy();
    const parsed = JSON.parse(newRaw!);
    expect(parsed.label).toBe("Device A");
  });

  it("throws when tokenId not found", async () => {
    envVars.MCP_AUTH_TOKEN = TOKEN_A;
    await expect(rotateDeviceToken("deadbeef")).rejects.toThrow(/not_found/i);
  });
});

describe("getLastSeenAt", () => {
  it("returns null when no buckets exist", async () => {
    const t = await getLastSeenAt(TOKEN_A);
    expect(t).toBeNull();
  });

  it("returns latest bucket timestamp", async () => {
    const hash = idHash16(TOKEN_A);
    store.set(`ratelimit:mcp:${hash}:100`, "1");
    store.set(`ratelimit:mcp:${hash}:200`, "1");
    store.set(`ratelimit:admin:${hash}:150`, "1");
    const t = await getLastSeenAt(TOKEN_A);
    // bucket 200 * 60_000ms end = 201 * 60_000 = 12_060_000
    const expected = new Date(201 * 60_000).toISOString();
    expect(t).toBe(expected);
  });
});

describe("clearDeviceRateLimit", () => {
  it("deletes all matching buckets across scopes", async () => {
    const hash = idHash16(TOKEN_A);
    store.set(`ratelimit:mcp:${hash}:100`, "1");
    store.set(`ratelimit:admin:${hash}:100`, "1");
    store.set(`ratelimit:welcome-device-claim:${hash}:100`, "1");
    store.set(`ratelimit:mcp:cafebabecafebabe:100`, "1");
    const count = await clearDeviceRateLimit(TOKEN_A);
    expect(count).toBe(3);
    expect(store.has(`ratelimit:mcp:cafebabecafebabe:100`)).toBe(true);
  });
});
