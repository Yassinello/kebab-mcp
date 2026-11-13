/**
 * Kebab House phase 0 — CTX-02..05: profiles store, device binding and the
 * my_context / my_context_update tools.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const store = new Map<string, string>();
let envVars: Record<string, string> = {};
let callerProfile: string | null = null;

function scanImpl(cursor: string, opts?: { match?: string; count?: number }) {
  const match = opts?.match ?? "*";
  const prefix = match.endsWith("*") ? match.slice(0, -1) : match;
  const all = Array.from(store.keys()).filter((k) =>
    match.endsWith("*") ? k.startsWith(prefix) : k === match
  );
  const offset = cursor === "0" ? 0 : parseInt(cursor, 10) || 0;
  const count = opts?.count ?? 100;
  const nextOffset = offset + count;
  return Promise.resolve({
    cursor: nextOffset >= all.length ? "0" : String(nextOffset),
    keys: all.slice(offset, offset + count),
  });
}

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
  scan: scanImpl,
};

vi.mock("@/core/request-context", () => ({
  getContextKVStore: () => kv,
  getCurrentTenantId: () => null,
}));

vi.mock("@/core/config-facade", () => ({
  getConfig: (key: string) => envVars[key],
}));

vi.mock("@/core/config", () => ({
  getInstanceConfigAsync: async () => ({
    contextPath: envVars.KEBAB_CONTEXT_PATH ?? "System/context.md",
  }),
}));

vi.mock("@/core/migrations/v0.11-tenant-scope", () => ({
  dualReadKV: async (_kv: unknown, key: string) => store.get(key) ?? null,
}));

vi.mock("@/core/token-scope", () => ({
  getCallerMeta: () => ({ tokenId: "abcd1234", label: "test", profile: callerProfile }),
}));

const vaultFiles = new Map<string, string>();
vi.mock("@/connectors/vault/lib/github", () => ({
  vaultRead: async (path: string) => {
    const c = vaultFiles.get(path);
    if (c === undefined) throw new Error(`Note not found: ${path}`);
    return { path, name: path, sha: "sha-" + path, content: c, size: c.length };
  },
  vaultWrite: async (path: string, content: string) => {
    vaultFiles.set(path, content);
    return { path, sha: "new", created: false };
  },
}));

import {
  DEFAULT_PROFILE,
  MAX_NAMED_PROFILES,
  ProfileError,
  deleteProfile,
  getProfileContent,
  listProfiles,
  saveProfile,
} from "@/core/profiles";
import { handleMyContext, handleMyContextUpdate } from "@/connectors/context/tools/my-context";

function textOf(r: { content: { text?: string }[] }): string {
  return r.content.map((c) => c.text ?? "").join("");
}

beforeEach(() => {
  store.clear();
  vaultFiles.clear();
  envVars = {};
  callerProfile = null;
});

describe("profiles store", () => {
  it("reads the legacy inline context as the default profile without migration", async () => {
    store.set("mymcp:context:inline", "# Me\nlegacy");
    expect(await getProfileContent(DEFAULT_PROFILE)).toBe("# Me\nlegacy");
    const list = await listProfiles();
    expect(list[0]).toMatchObject({ name: "default", mode: "inline" });
  });

  it("creates, lists and deletes named profiles", async () => {
    await saveProfile("Work", "work hat");
    await saveProfile("perso", "perso hat");
    const names = (await listProfiles()).map((p) => p.name);
    expect(names).toEqual(["default", "perso", "work"]);
    expect(await getProfileContent("work")).toBe("work hat");
    await deleteProfile("work");
    expect(await getProfileContent("work")).toBeNull();
  });

  it("rejects invalid names, oversize content, too many profiles and deleting default", async () => {
    await expect(saveProfile("bad name!", "x")).rejects.toBeInstanceOf(ProfileError);
    await expect(saveProfile("big", "x".repeat(64 * 1024 + 1))).rejects.toMatchObject({
      code: "too_large",
    });
    for (let i = 0; i < MAX_NAMED_PROFILES; i++) await saveProfile(`p${i}`, "x");
    await expect(saveProfile("one-more", "x")).rejects.toMatchObject({ code: "too_many" });
    // Replacing an existing profile is still allowed at the cap.
    await expect(saveProfile("p1", "y")).resolves.toBeUndefined();
    await expect(deleteProfile("default")).rejects.toMatchObject({ code: "reserved" });
  });

  it("writing default switches it to inline mode", async () => {
    store.set("mymcp:context:mode", "vault");
    await saveProfile("default", "new default");
    expect(store.get("mymcp:context:inline")).toBe("new default");
    expect(store.get("mymcp:context:mode")).toBe("inline");
  });
});

describe("my_context resolution (CTX-02)", () => {
  it("1. returns the profile bound to the calling token", async () => {
    store.set("mymcp:context:inline", "default text");
    await saveProfile("work", "work text");
    callerProfile = "work";
    expect(textOf(await handleMyContext())).toContain("work text");
  });

  it("falls back to default when the bound profile does not exist", async () => {
    store.set("mymcp:context:inline", "default text");
    callerProfile = "gone";
    expect(textOf(await handleMyContext())).toBe("default text");
  });

  it("2. returns the inline default profile", async () => {
    store.set("mymcp:context:inline", "default text");
    expect(textOf(await handleMyContext())).toBe("default text");
  });

  it("3. reads the vault file at the configured path in vault mode", async () => {
    envVars = { GITHUB_PAT: "x", GITHUB_REPO: "a/b", KEBAB_CONTEXT_PATH: "Me/profile.md" };
    store.set("mymcp:context:mode", "vault");
    vaultFiles.set("Me/profile.md", "from vault");
    expect(textOf(await handleMyContext())).toBe("from vault");
  });

  it("4. returns help text when nothing is configured (no vault needed)", async () => {
    expect(textOf(await handleMyContext())).toMatch(/No personal profile yet/);
  });
});

describe("my_context_update (CTX-05)", () => {
  it("appends to the bound profile", async () => {
    await saveProfile("work", "line 1");
    callerProfile = "work";
    await handleMyContextUpdate({ mode: "append", content: "line 2" });
    expect(await getProfileContent("work")).toBe("line 1\n\nline 2");
  });

  it("replaces the default profile", async () => {
    store.set("mymcp:context:inline", "old");
    await handleMyContextUpdate({ mode: "replace", content: "new" });
    expect(store.get("mymcp:context:inline")).toBe("new");
  });

  it("writes into the vault file when the default profile lives in the vault", async () => {
    envVars = { GITHUB_PAT: "x", GITHUB_REPO: "a/b" };
    store.set("mymcp:context:mode", "vault");
    vaultFiles.set("System/context.md", "vault profile");
    await handleMyContextUpdate({ content: "added" });
    expect(vaultFiles.get("System/context.md")).toBe("vault profile\n\nadded");
    expect(store.get("mymcp:context:mode")).toBe("vault");
  });

  it("refuses a result over the size limit", async () => {
    await saveProfile("work", "x".repeat(64 * 1024 - 2));
    callerProfile = "work";
    const r = await handleMyContextUpdate({ content: "yyyy" });
    expect(r.isError).toBe(true);
    expect(await getProfileContent("work")).toHaveLength(64 * 1024 - 2);
  });
});
