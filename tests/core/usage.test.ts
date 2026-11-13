/**
 * Kebab House phase 0 — USE-01..05 weekly usage counters.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const store = new Map<string, string>();
let envVars: Record<string, string> = {};
let incrFails = false;

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
  incr: async (k: string) => {
    if (incrFails) throw new Error("kv down");
    const n = Number(store.get(k) ?? 0) + 1;
    store.set(k, String(n));
    return n;
  },
};

vi.mock("@/core/request-context", () => ({
  getContextKVStore: () => kv,
  getCurrentTenantId: () => null,
}));
vi.mock("@/core/config-facade", () => ({
  getConfig: (key: string) => envVars[key],
}));
// Run post-response work synchronously-ish so the test can await it.
const pending: Promise<unknown>[] = [];
vi.mock("@/core/after-response", () => ({
  runAfterResponse: (task: () => Promise<unknown>) => {
    pending.push(task().catch(() => undefined));
  },
}));

import { isoWeek, recentWeeks, recordToolCall, readWeekUsage, usageKeysFor } from "@/core/usage";

async function flush() {
  await Promise.all(pending.splice(0));
}

beforeEach(() => {
  store.clear();
  envVars = {};
  incrFails = false;
});

describe("isoWeek", () => {
  it("follows ISO-8601 (year boundaries)", () => {
    expect(isoWeek(new Date("2026-11-13T12:00:00Z"))).toBe("2026-W46");
    expect(isoWeek(new Date("2027-01-01T12:00:00Z"))).toBe("2026-W53");
    expect(isoWeek(new Date("2025-12-29T12:00:00Z"))).toBe("2026-W01");
  });
  it("recentWeeks returns distinct weeks newest first", () => {
    expect(recentWeeks(3, new Date("2026-11-13T12:00:00Z"))).toEqual([
      "2026-W46",
      "2026-W45",
      "2026-W44",
    ]);
  });
});

describe("recordToolCall", () => {
  it("increments total, tool, client, skill and notes counters — names only", async () => {
    recordToolCall({ tool: "skill_load", client: "Claude perso", skill: "meeting-prep" });
    recordToolCall({ tool: "vault_append", client: "Claude perso" });
    await flush();
    const week = isoWeek();
    const u = await readWeekUsage(week);
    expect(u.total).toBe(2);
    expect(u.notes).toBe(1);
    expect(u.skills).toEqual([{ name: "meeting-prep", count: 1 }]);
    expect(u.clients).toEqual([{ name: "Claude_perso", count: 2 }]);
    expect(u.tools.map((t) => t.name).sort()).toEqual(["skill_load", "vault_append"]);
    // Nothing but counters was written.
    for (const k of store.keys()) expect(k.startsWith(`usage:${week}:`)).toBe(true);
  });

  it("never throws when the KV fails", async () => {
    incrFails = true;
    expect(() => recordToolCall({ tool: "my_context", client: "x" })).not.toThrow();
    await flush();
  });

  it("is disabled by KEBAB_USAGE_COUNTERS=off", async () => {
    envVars.KEBAB_USAGE_COUNTERS = "off";
    recordToolCall({ tool: "my_context", client: "x" });
    await flush();
    expect(store.size).toBe(0);
  });

  it("sanitizes key segments", () => {
    const keys = usageKeysFor({ tool: "a:b", client: "my laptop:1" }, "2026-W46");
    expect(keys).toContain("usage:2026-W46:tool:a_b");
    expect(keys).toContain("usage:2026-W46:client:my_laptop_1");
  });
});
