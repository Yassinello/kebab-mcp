/**
 * SEC-01a regression: skills connector persists under tenant prefix.
 *
 * Before this fix, all 7 callsites in src/connectors/skills/store.ts
 * called getKVStore() directly, bypassing TenantKVStore. Tenant A's
 * skills were globally visible; tenant B could overwrite them. See
 * .planning/research/RISKS-AUDIT.md #1.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { requestContext } from "@/core/request-context";

// In-memory store to observe the actual prefixed keys.
const store = new Map<string, string>();

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
    scan: async (_cursor: string, opts?: { match?: string; count?: number }) => {
      const allKeys = Array.from(store.keys());
      const match = opts?.match;
      const filtered = match?.endsWith("*")
        ? allKeys.filter((k) => k.startsWith(match.slice(0, -1)))
        : allKeys;
      return { cursor: "0", keys: filtered };
    },
  };

  function withTenantPrefixLocal(key: string, tenantId: string | null): string {
    if (tenantId === null) return key;
    return `tenant:${tenantId}:${key}`;
  }

  function makeTenantKv(tenantId: string | null) {
    if (tenantId === null) return inner;
    return {
      kind: inner.kind,
      get: (k: string) => inner.get(withTenantPrefixLocal(k, tenantId)),
      set: (k: string, v: string) => inner.set(withTenantPrefixLocal(k, tenantId), v),
      delete: (k: string) => inner.delete(withTenantPrefixLocal(k, tenantId)),
      list: (prefix?: string) => inner.list(withTenantPrefixLocal(prefix ?? "", tenantId)),
      scan: async (cursor: string, opts?: { match?: string; count?: number }) => {
        const prefixedMatch = opts?.match
          ? withTenantPrefixLocal(opts.match, tenantId)
          : withTenantPrefixLocal("*", tenantId);
        const res = await inner.scan(cursor, { ...opts, match: prefixedMatch });
        const tp = `tenant:${tenantId}:`;
        return {
          cursor: res.cursor,
          keys: res.keys.map((k) => (k.startsWith(tp) ? k.slice(tp.length) : k)),
        };
      },
    };
  }

  return {
    getKVStore: () => inner,
    getTenantKVStore: (tenantId: string | null) => makeTenantKv(tenantId),
    kvScanAll: async (
      kv: { scan?: (c: string, o?: unknown) => Promise<{ cursor: string; keys: string[] }> },
      match?: string
    ) => {
      if (typeof kv.scan !== "function") return [];
      const out: string[] = [];
      let cursor = "0";
      do {
        const res = await kv.scan(cursor, { match, count: 100 });
        out.push(...res.keys);
        cursor = res.cursor;
      } while (cursor !== "0");
      return out;
    },
    resetKVStoreCache: () => {},
    clearKVReadCache: () => {},
  };
});

describe("skills connector tenant isolation (SEC-01a)", () => {
  const ORIG_SKILLS_PATH = process.env.MYMCP_SKILLS_PATH;

  beforeEach(() => {
    // Force the KV code path (not the legacy filesystem path).
    delete process.env.MYMCP_SKILLS_PATH;
    store.clear();
  });

  afterEach(() => {
    if (ORIG_SKILLS_PATH === undefined) delete process.env.MYMCP_SKILLS_PATH;
    else process.env.MYMCP_SKILLS_PATH = ORIG_SKILLS_PATH;
    store.clear();
  });

  it("tenant A's skill is not visible to tenant B", async () => {
    const { createSkill, listSkills } = await import("@/connectors/skills/store");

    await requestContext.run({ tenantId: "alpha" }, async () => {
      await createSkill({
        name: "foo_alpha",
        description: "A's version",
        content: "alpha content",
        arguments: [],
        source: { type: "inline" },
      });
    });

    // Tenant B reads — must not see tenant A's skill.
    await requestContext.run({ tenantId: "beta" }, async () => {
      const skills = await listSkills();
      expect(skills.find((s) => s.id === "foo_alpha")).toBeUndefined();
    });

    // Tenant A still sees it.
    await requestContext.run({ tenantId: "alpha" }, async () => {
      const skills = await listSkills();
      expect(skills.find((s) => s.id === "foo_alpha")).toBeDefined();
    });

    // Verify the actual KV key is tenant-prefixed.
    expect(store.has("tenant:alpha:skills:all")).toBe(true);
    expect(store.has("skills:all")).toBe(false);
  });

  it("tenant B writing same slug does not overwrite tenant A's skill", async () => {
    const { createSkill, listSkills } = await import("@/connectors/skills/store");

    await requestContext.run({ tenantId: "alpha" }, async () => {
      await createSkill({
        name: "shared_name",
        description: "A version",
        content: "A-content",
        arguments: [],
        source: { type: "inline" },
      });
    });
    await requestContext.run({ tenantId: "beta" }, async () => {
      await createSkill({
        name: "shared_name",
        description: "B version",
        content: "B-content",
        arguments: [],
        source: { type: "inline" },
      });
    });

    await requestContext.run({ tenantId: "alpha" }, async () => {
      const skills = await listSkills();
      const found = skills.find((s) => s.id === "shared_name");
      expect(found?.content).toBe("A-content");
    });
    await requestContext.run({ tenantId: "beta" }, async () => {
      const skills = await listSkills();
      const found = skills.find((s) => s.id === "shared_name");
      expect(found?.content).toBe("B-content");
    });
  });

  it("default tenant (null) still writes to the untenanted prefix", async () => {
    const { createSkill } = await import("@/connectors/skills/store");

    await createSkill({
      name: "default_skill",
      description: "no tenant",
      content: "",
      arguments: [],
      source: { type: "inline" },
    });

    expect(store.has("skills:all")).toBe(true);
    expect(store.has("tenant:null:skills:all")).toBe(false);
  });

  it("skill versioning keys are tenant-scoped too", async () => {
    const { createSkillVersioned } = await import("@/connectors/skills/store");

    await requestContext.run({ tenantId: "alpha" }, async () => {
      await createSkillVersioned({
        name: "versioned_alpha",
        description: "",
        content: "v1",
        arguments: [],
        source: { type: "inline" },
      });
    });

    // skill:<id>:meta and skill:<id>:v1 must be under tenant prefix
    const alphaMetaKey = "tenant:alpha:skill:versioned_alpha:meta";
    const alphaV1Key = "tenant:alpha:skill:versioned_alpha:v1";
    expect(store.has(alphaMetaKey)).toBe(true);
    expect(store.has(alphaV1Key)).toBe(true);
    // Not under the untenanted prefix.
    expect(store.has("skill:versioned_alpha:meta")).toBe(false);
  });
});
