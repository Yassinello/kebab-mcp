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

import {
  addsNote,
  isFailedResult,
  isoWeek,
  recentWeeks,
  recordToolCall,
  readWeekUsage,
  skillForUsage,
  usageKeysFor,
} from "@/core/usage";

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

describe("what counts (audit 2026-11, A6)", () => {
  const text = (t: string, isError?: boolean) => ({
    content: [{ type: "text" as const, text: t }],
    ...(isError ? { isError } : {}),
  });

  it("an error result is never a success (isError, or a JSON body with a top-level error)", () => {
    expect(isFailedResult(text("boom", true))).toBe(true);
    expect(isFailedResult(text(JSON.stringify({ error: "skill_not_found", name: "x" })))).toBe(
      true
    );
    expect(isFailedResult(text(JSON.stringify({ success: true, action: "created" })))).toBe(false);
    expect(isFailedResult(text("# Skill: meeting-prep\n\nbody"))).toBe(false);
    // A nested "error" field is data, not a failure.
    expect(isFailedResult(text(JSON.stringify({ results: [{ error: "x" }] })))).toBe(false);
  });

  it("skill usage: skill_load with the canonical library name, legacy skill tools; nothing else", () => {
    const loaded = text("# Skill: meeting-prep\n> Prepare a meeting\n\nSteps…");
    expect(skillForUsage("skill_load", "skills", loaded)).toBe("meeting-prep");
    // The loaded skill's own name is used, whatever the model typed.
    expect(skillForUsage("skill_load", "skills", text("no header"))).toBeNull();
    expect(skillForUsage("skill_weekly_review", "skills", text("rendered"))).toBe("weekly-review");
    // Library and template tools are not skills.
    expect(skillForUsage("skill_read_file", "skills", text("file"))).toBeNull();
    expect(skillForUsage("skills_list", "skills", text("{}"))).toBeNull();
    expect(skillForUsage("skill_template_install", "context", text("{}"))).toBeNull();
    expect(skillForUsage("skill_templates_list", "context", text("{}"))).toBeNull();
  });

  it("notes: vault_write only when it created a note, vault_append, save_article", () => {
    const created = text(JSON.stringify({ success: true, action: "created", path: "a.md" }));
    const updated = text(JSON.stringify({ success: true, action: "updated", path: "a.md" }));
    expect(addsNote("vault_write", created)).toBe(true);
    expect(addsNote("vault_write", updated)).toBe(false);
    expect(addsNote("vault_append", text("ok"))).toBe(true);
    expect(addsNote("save_article", text("ok"))).toBe(true);
    expect(addsNote("my_context_update", text("ok"))).toBe(false);
    expect(addsNote("vault_delete", text("ok"))).toBe(false);
    expect(usageKeysFor({ tool: "my_context_update", client: "c" }, "2026-W46")).not.toContain(
      "usage:2026-W46:notes"
    );
    expect(usageKeysFor({ tool: "vault_write", client: "c" }, "2026-W46")).not.toContain(
      "usage:2026-W46:notes"
    );
    expect(usageKeysFor({ tool: "vault_write", client: "c", note: true }, "2026-W46")).toContain(
      "usage:2026-W46:notes"
    );
  });
});
