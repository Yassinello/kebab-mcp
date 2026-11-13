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
  getDeviceConnectors,
  setDeviceConnectors,
  setDeviceSkillTags,
  getDeviceSkillTags,
  setDeviceProfile,
  getDeviceMetaFrom,
  createOAuthDevice,
  isOAuthDevice,
  revokeOAuthDevice,
  setDeviceWriteAllowed,
  getDeviceWriteAllowedFrom,
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

describe("setDeviceLabel — SEC-03b exploit regression", () => {
  it("renaming a scoped token keeps its connector scope", async () => {
    store.set(
      "devices:abcd1234",
      JSON.stringify({ label: "agent", createdAt: "2026-01-01", connectors: ["apify"] })
    );
    await setDeviceLabel("abcd1234", "renamed");
    const parsed = JSON.parse(store.get("devices:abcd1234")!);
    expect(parsed.label).toBe("renamed");
    expect(parsed.connectors).toEqual(["apify"]);
    expect(await getDeviceConnectors("abcd1234")).toEqual(["apify"]);
  });

  it("renaming keeps a revocation tombstone", async () => {
    store.set(
      "devices:abcd1234",
      JSON.stringify({ label: "old", createdAt: "2026-01-01", revokedAt: "2026-11-01" })
    );
    await setDeviceLabel("abcd1234", "renamed");
    expect(JSON.parse(store.get("devices:abcd1234")!).revokedAt).toBe("2026-11-01");
  });

  it("refuses to rewrite a corrupt entry (would silently grant full access)", async () => {
    store.set("devices:abcd1234", "{ not json");
    await expect(setDeviceLabel("abcd1234", "x")).rejects.toThrow(/corrupt/i);
  });
});

describe("rotateDeviceToken — SEC-06", () => {
  it("carries the scope to the new token and tombstones the old one", async () => {
    envVars.MCP_AUTH_TOKEN = `${TOKEN_A}`;
    const tidA = tokenId(TOKEN_A);
    store.set(
      `devices:${tidA}`,
      JSON.stringify({ label: "Agent", createdAt: "2026-01-01", connectors: ["apify"] })
    );
    const { newTokenId } = await rotateDeviceToken(tidA);
    expect(JSON.parse(store.get(`devices:${newTokenId}`)!).connectors).toEqual(["apify"]);
    expect(await getDeviceConnectors(tidA)).toEqual([]);
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
  it("tombstones the KV entry (SEC-06) + clears rate-limit buckets", async () => {
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
    // SEC-06: the entry is replaced by a revocation tombstone, not deleted —
    // a deleted entry would mean "no scope" = full access while the token
    // still sits in a not-yet-redeployed env.
    const tomb = JSON.parse(store.get(`devices:${tid}`)!);
    expect(typeof tomb.revokedAt).toBe("string");
    expect(tomb.label).toBe("L");
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

    // SEC-06: old entry becomes a revocation tombstone; new one carries the label
    expect(JSON.parse(store.get(`devices:${tidA}`)!).revokedAt).toBeTruthy();
    const newRaw = store.get(`devices:${newTokenId}`);
    expect(newRaw).toBeTruthy();
    const parsed = JSON.parse(newRaw!);
    expect(parsed.label).toBe("Device A");
  });

  it("throws when tokenId not found", async () => {
    envVars.MCP_AUTH_TOKEN = TOKEN_A;
    await expect(rotateDeviceToken("deadbeef")).rejects.toThrow(/not_found/i);
  });

  it("preserves the connector allowlist across rotation (no privilege escalation)", async () => {
    envVars.MCP_AUTH_TOKEN = TOKEN_A;
    const tidA = tokenId(TOKEN_A);
    store.set(
      `devices:${tidA}`,
      JSON.stringify({
        label: "Team token",
        createdAt: "2026-01-01T00:00:00.000Z",
        connectors: ["apify", "unipile"],
      })
    );

    const { newTokenId } = await rotateDeviceToken(tidA);

    const parsed = JSON.parse(store.get(`devices:${newTokenId}`)!);
    expect(parsed.label).toBe("Team token");
    expect(parsed.connectors).toEqual(["apify", "unipile"]);
  });

  it("does not add a connectors field when the source token was unscoped", async () => {
    envVars.MCP_AUTH_TOKEN = TOKEN_A;
    const tidA = tokenId(TOKEN_A);
    store.set(
      `devices:${tidA}`,
      JSON.stringify({ label: "Full-access token", createdAt: "2026-01-01T00:00:00.000Z" })
    );

    const { newTokenId } = await rotateDeviceToken(tidA);

    const parsed = JSON.parse(store.get(`devices:${newTokenId}`)!);
    expect(parsed.connectors).toBeUndefined();
  });
});

describe("getDeviceConnectors", () => {
  it("returns null when no entry exists (full access)", async () => {
    expect(await getDeviceConnectors("nope1234")).toBeNull();
  });

  it("returns null when entry has no connectors field", async () => {
    store.set("devices:abcd1234", JSON.stringify({ label: "L", createdAt: "x" }));
    expect(await getDeviceConnectors("abcd1234")).toBeNull();
  });

  it("returns the stored allowlist array", async () => {
    store.set(
      "devices:abcd1234",
      JSON.stringify({ label: "L", createdAt: "x", connectors: ["apify", "unipile"] })
    );
    expect(await getDeviceConnectors("abcd1234")).toEqual(["apify", "unipile"]);
  });

  it("returns an empty array when the allowlist is empty (nothing-but-core lock)", async () => {
    store.set("devices:abcd1234", JSON.stringify({ label: "L", createdAt: "x", connectors: [] }));
    expect(await getDeviceConnectors("abcd1234")).toEqual([]);
  });

  it("fails CLOSED ([]) on a corrupt entry (SEC-04)", async () => {
    store.set("devices:abcd1234", "{ not json");
    expect(await getDeviceConnectors("abcd1234")).toEqual([]);
  });

  it("returns [] for a revoked token", async () => {
    store.set("devices:abcd1234", JSON.stringify({ label: "x", createdAt: "x", revokedAt: "now" }));
    expect(await getDeviceConnectors("abcd1234")).toEqual([]);
  });
});

describe("setDeviceConnectors", () => {
  it("writes a validated allowlist and preserves label + createdAt", async () => {
    const original = "2026-01-01T00:00:00.000Z";
    store.set("devices:abcd1234", JSON.stringify({ label: "Team", createdAt: original }));
    await setDeviceConnectors("abcd1234", ["apify", "unipile"]);
    const parsed = JSON.parse(store.get("devices:abcd1234")!);
    expect(parsed.label).toBe("Team");
    expect(parsed.createdAt).toBe(original);
    expect(parsed.connectors).toEqual(["apify", "unipile"]);
  });

  it("creates an entry for a previously-unlabelled token", async () => {
    await setDeviceConnectors("abcd1234", ["apify"]);
    const parsed = JSON.parse(store.get("devices:abcd1234")!);
    expect(parsed.label).toBe("unnamed");
    expect(typeof parsed.createdAt).toBe("string");
    expect(parsed.connectors).toEqual(["apify"]);
  });

  it("rejects unknown connector ids", async () => {
    await expect(setDeviceConnectors("abcd1234", ["apify", "not-a-connector"])).rejects.toThrow(
      /unknown connector/i
    );
    // Nothing written on rejection.
    expect(store.has("devices:abcd1234")).toBe(false);
  });

  it("dedupes while preserving order", async () => {
    await setDeviceConnectors("abcd1234", ["apify", "unipile", "apify"]);
    const parsed = JSON.parse(store.get("devices:abcd1234")!);
    expect(parsed.connectors).toEqual(["apify", "unipile"]);
  });

  it("accepts an empty array (nothing-but-core lock)", async () => {
    await setDeviceConnectors("abcd1234", []);
    const parsed = JSON.parse(store.get("devices:abcd1234")!);
    expect(parsed.connectors).toEqual([]);
  });

  it("clears the scope on null (back to full access) and drops the field", async () => {
    store.set(
      "devices:abcd1234",
      JSON.stringify({ label: "Team", createdAt: "x", connectors: ["apify"] })
    );
    await setDeviceConnectors("abcd1234", null);
    const parsed = JSON.parse(store.get("devices:abcd1234")!);
    expect(parsed.connectors).toBeUndefined();
    expect(parsed.label).toBe("Team");
  });

  it("surfaces the allowlist through listDevices()", async () => {
    envVars.MCP_AUTH_TOKEN = TOKEN_A;
    await setDeviceConnectors(tokenId(TOKEN_A), ["apify"]);
    const rows = await listDevices();
    expect(rows[0]!.connectors).toEqual(["apify"]);
  });

  it("listDevices() reports null connectors for an unscoped token", async () => {
    envVars.MCP_AUTH_TOKEN = TOKEN_A;
    store.set(`devices:${tokenId(TOKEN_A)}`, JSON.stringify({ label: "L", createdAt: "x" }));
    const rows = await listDevices();
    expect(rows[0]!.connectors).toBeNull();
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

describe("skills v2 — setDeviceSkillTags / field preservation", () => {
  it("stores normalized tags and reads them back; null clears", async () => {
    store.set(
      "devices:abcd1234",
      JSON.stringify({ label: "Claude", createdAt: "2026-01-01T00:00:00.000Z" })
    );
    await setDeviceSkillTags("abcd1234", ["Perso", "perso", "Cadens Lab"]);
    expect(await getDeviceSkillTags("abcd1234")).toEqual(["perso", "cadens-lab"]);
    await setDeviceSkillTags("abcd1234", null);
    expect(await getDeviceSkillTags("abcd1234")).toBeNull();
    expect(JSON.parse(store.get("devices:abcd1234")!).label).toBe("Claude");
  });

  it("rename keeps the connector scope and skill tags (regression: rename used to wipe the scope)", async () => {
    store.set(
      "devices:abcd1234",
      JSON.stringify({
        label: "Old",
        createdAt: "2026-01-01T00:00:00.000Z",
        connectors: ["apify"],
        skillTags: ["work"],
      })
    );
    await setDeviceLabel("abcd1234", "New name");
    const parsed = JSON.parse(store.get("devices:abcd1234")!);
    expect(parsed).toMatchObject({ label: "New name", connectors: ["apify"], skillTags: ["work"] });
  });

  it("setDeviceConnectors keeps skill tags; setDeviceSkillTags keeps connectors", async () => {
    store.set(
      "devices:abcd1234",
      JSON.stringify({ label: "T", createdAt: "x", skillTags: ["work"] })
    );
    await setDeviceConnectors("abcd1234", ["apify"]);
    expect(JSON.parse(store.get("devices:abcd1234")!)).toMatchObject({
      connectors: ["apify"],
      skillTags: ["work"],
    });
    await setDeviceSkillTags("abcd1234", ["perso"]);
    expect(JSON.parse(store.get("devices:abcd1234")!)).toMatchObject({
      connectors: ["apify"],
      skillTags: ["perso"],
    });
  });

  it("rotation carries skill tags to the new token", async () => {
    envVars.MCP_AUTH_TOKEN = TOKEN_A;
    const id = tokenId(TOKEN_A);
    store.set(`devices:${id}`, JSON.stringify({ label: "T", createdAt: "x", skillTags: ["work"] }));
    const { newTokenId } = await rotateDeviceToken(id);
    expect(JSON.parse(store.get(`devices:${newTokenId}`)!).skillTags).toEqual(["work"]);
  });

  it("listDevices exposes skillTags (null when unset)", async () => {
    envVars.MCP_AUTH_TOKEN = `${TOKEN_A},${TOKEN_B}`;
    store.set(
      `devices:${tokenId(TOKEN_A)}`,
      JSON.stringify({ label: "A", createdAt: "x", skillTags: ["work"] })
    );
    const rows = await listDevices();
    expect(rows.find((r) => r.tokenId === tokenId(TOKEN_A))!.skillTags).toEqual(["work"]);
    expect(rows.find((r) => r.tokenId === tokenId(TOKEN_B))!.skillTags).toBeNull();
  });
});

describe("device profile (Kebab House CTX-04)", () => {
  it("binds a profile, shows it in listDevices and keeps it across rename, scope edits and rotation", async () => {
    envVars.MCP_AUTH_TOKEN = TOKEN_A;
    const id = tokenId(TOKEN_A);
    await setDeviceConnectors(id, []);
    await setDeviceProfile(id, "Work");
    expect((await listDevices())[0]!.profile).toBe("work");

    await setDeviceLabel(id, "laptop");
    await setDeviceSkillTags(id, ["perso"]);
    await setDeviceConnectors(id, null);
    const kv = { get: async (k: string) => store.get(k) ?? null };
    expect(await getDeviceMetaFrom(id, kv)).toEqual({ label: "laptop", profile: "work" });

    const { newTokenId } = await rotateDeviceToken(id);
    expect(await getDeviceMetaFrom(newTokenId, kv)).toEqual({ label: "laptop", profile: "work" });
    // The rotated (tombstoned) entry carries nothing.
    expect(await getDeviceMetaFrom(id, kv)).toEqual({ label: null, profile: null });
  });

  it("clears the binding with null or 'default' and rejects invalid names", async () => {
    envVars.MCP_AUTH_TOKEN = TOKEN_A;
    const id = tokenId(TOKEN_A);
    await setDeviceProfile(id, "perso");
    await setDeviceProfile(id, "default");
    expect((await listDevices())[0]!.profile).toBeNull();
    await expect(setDeviceProfile(id, "not valid!")).rejects.toThrow(/profile/i);
  });

  it("a malformed profile field never makes the entry corrupt (no access change)", async () => {
    envVars.MCP_AUTH_TOKEN = TOKEN_A;
    const id = tokenId(TOKEN_A);
    store.set(`devices:${id}`, JSON.stringify({ label: "x", createdAt: "t", profile: 42 }));
    expect(await getDeviceConnectors(id)).toBeNull();
    expect((await listDevices())[0]!.profile).toBeNull();
  });
});

describe("OAuth devices (Kebab House OAU-08, TRU-05)", () => {
  const kv = { get: async (k: string) => store.get(k) ?? null };

  it("are listed next to static tokens, read-only by default, and revocable", async () => {
    envVars.MCP_AUTH_TOKEN = TOKEN_A;
    await createOAuthDevice({
      id: "0a1b2c3d",
      label: "Claude",
      clientId: "kc_x",
      clientName: "Claude",
      connectors: null,
      skillTags: ["perso"],
      profile: "perso",
      writeAllowed: false,
    });
    const rows = await listDevices();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      tokenId: "0a1b2c3d",
      kind: "oauth",
      writeAllowed: false,
      profile: "perso",
    });
    expect(await getDeviceWriteAllowedFrom("0a1b2c3d", kv)).toBe(false);
    // Static tokens keep their behaviour (no entry, or no oauth marker → writes allowed).
    expect(await getDeviceWriteAllowedFrom(tokenId(TOKEN_A), kv)).toBe(true);

    await setDeviceWriteAllowed("0a1b2c3d", true);
    await setDeviceLabel("0a1b2c3d", "Claude perso");
    expect(await getDeviceWriteAllowedFrom("0a1b2c3d", kv)).toBe(true);
    expect(await isOAuthDevice("0a1b2c3d")).toBe(true);

    await revokeOAuthDevice("0a1b2c3d");
    expect(await isOAuthDevice("0a1b2c3d")).toBe(false);
    expect(await listDevices()).toHaveLength(1);
  });
});
