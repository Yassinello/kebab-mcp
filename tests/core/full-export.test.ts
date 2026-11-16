/**
 * Kebab House phase 2 — EXP-01..03: full export and round-trip import.
 * 2026-11 audit (B1): vault-mode default profile, additive import, notes
 * without .md, zip bombs, settings re-import.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { makeMemoryKV } from "@/connectors/vault/lib/__tests__/memory-kv";

const kvRef = { current: makeMemoryKV() };
vi.mock("@/core/request-context", async () => {
  const actual =
    await vi.importActual<typeof import("@/core/request-context")>("@/core/request-context");
  return { ...actual, getContextKVStore: () => kvRef.current, getCurrentTenantId: () => null };
});
vi.mock("@/core/config", () => ({
  getInstanceConfigAsync: async () => ({ contextPath: "System/context.md" }),
}));

import {
  buildFullExport,
  importFullExport,
  isExcludedFromExport,
  isImportableSetting,
  safeUnzip,
  ImportRejectedError,
} from "@/core/full-export";
import { saveProfile, getProfileContent, KV_CONTEXT_MODE } from "@/core/profiles";
import { getVaultBackend } from "@/connectors/vault/lib/select";
import { NOTE_PREFIX } from "@/connectors/vault/lib/kv-backend";
import { planImport, applyImport } from "@/connectors/skills/lib/importer";
import { listSkills } from "@/connectors/skills/store";
import { handleMyContext } from "@/connectors/context/tools/my-context";

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  kvRef.current = makeMemoryKV();
  for (const k of ["GITHUB_PAT", "GITHUB_REPO", "KEBAB_VAULT_BACKEND"]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved))
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
});

const API_CONNECTIONS = [
  {
    id: "conn_1",
    name: "Weather",
    baseUrl: "https://api.weather.example/v1?apikey=SHOULD-NOT-LEAK",
    auth: { type: "bearer", token: "SECRET-TOKEN-VALUE" },
    headers: { Accept: "application/json", "X-Api-Key": "SECRET-HEADER-VALUE" },
    timeoutMs: 30000,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  },
];
const API_TOOLS = [{ id: "tool_1", connectionId: "conn_1", name: "forecast" }];
const CUSTOM_TOOLS = [{ id: "ct_1", name: "daily_brief" }];

async function seed() {
  await saveProfile("default", "# Me\nDefault hat");
  await saveProfile("work", "# Work hat");
  const plan = await planImport({
    skillMd: "---\nname: meeting-prep\ndescription: Use before a meeting.\n---\n# Prep\nDo it.",
  });
  if (!plan.ok) throw new Error(plan.error);
  await applyImport(plan.items);
  await getVaultBackend().write("Notes/idea.md", "# Idea\nLinks to [[Other]].");
  const kv = kvRef.current;
  await kv.set("cred:SLACK_BOT_TOKEN", "xoxb-secret");
  await kv.set("oauth:at:abc", "{}");
  await kv.set("devices:0a1b2c3d", "{}");
  await kv.set("usage:2026-W46:total", "3");
  await kv.set("settings:displayName", "Alex");
  await kv.set("settings:timezone", "Europe/Paris");
  await kv.set("settings:locale", "fr-FR");
  await kv.set("tool:disabled:gmail_send", "true");
  await kv.set("custom-tools:all", JSON.stringify(CUSTOM_TOOLS));
  await kv.set("api:connections", JSON.stringify(API_CONNECTIONS));
  await kv.set("api:tools", JSON.stringify(API_TOOLS));
}

function textOf(r: { content: Array<{ text?: string }> }): string {
  return r.content.map((c) => c.text ?? "").join("");
}

describe("full export (EXP-01)", () => {
  it("contains profiles, skills, vault notes and settings, never secrets", async () => {
    await seed();
    const { zip, report } = await buildFullExport();
    const files = unzipSync(zip);
    expect(strFromU8(files["profiles/default.md"]!)).toContain("Default hat");
    expect(strFromU8(files["profiles/work.md"]!)).toContain("Work hat");
    expect(strFromU8(files["skills/meeting-prep/SKILL.md"]!)).toContain("name: meeting-prep");
    expect(strFromU8(files["vault/Notes/idea.md"]!)).toContain("[[Other]]");
    expect(files["README.txt"]).toBeDefined();
    const json = strFromU8(files["kebab-house.json"]!);
    expect(json).toContain("settings:displayName");
    for (const leaked of [
      "xoxb-secret",
      "oauth:at:",
      "devices:",
      "usage:",
      "SECRET-TOKEN-VALUE",
      "SECRET-HEADER-VALUE",
      "SHOULD-NOT-LEAK",
    ])
      expect(json).not.toContain(leaked);
    // API connections travel without their keys.
    const parsed = JSON.parse(json) as { apiConnections: Array<Record<string, unknown>> };
    expect(parsed.apiConnections[0]).toMatchObject({
      id: "conn_1",
      baseUrl: "https://api.weather.example/v1",
      auth: { type: "none" },
      headers: { Accept: "application/json" },
      authRemoved: "bearer",
      headersRemoved: ["X-Api-Key"],
    });
    expect(report).toMatchObject({ profiles: 2, skills: 1, notes: 1 });
  });

  it("excludes secret and authorization prefixes, also under a tenant prefix", () => {
    expect(isExcludedFromExport("cred:X")).toBe(true);
    expect(isExcludedFromExport("tenant:acme:oauth:rt:1")).toBe(true);
    expect(isExcludedFromExport("settings:locale")).toBe(false);
  });

  it("only allow-listed, non-secret settings are importable", () => {
    for (const k of [
      "settings:displayName",
      "settings:timezone",
      "settings:locale",
      "custom-tools:all",
      "api:tools",
      "tool:disabled:gmail_send",
      "tenant:acme:settings:locale",
    ])
      expect(isImportableSetting(k)).toBe(true);
    for (const k of [
      "api:connections",
      "cred:SLACK_BOT_TOKEN",
      "mymcp:firstrun:bootstrap",
      "devices:abc",
      "oauth:client:x",
      "mymcp:context:mode",
      "settings:contextPath",
      "skills:all",
    ])
      expect(isImportableSetting(k)).toBe(false);
  });

  it("B1: a vault-mode default profile is exported with its vault content", async () => {
    kvRef.current.store.set(KV_CONTEXT_MODE, "vault");
    await getVaultBackend().write("System/context.md", "# Me\nProfile kept in the vault");
    const files = unzipSync((await buildFullExport()).zip);
    expect(strFromU8(files["profiles/default.md"]!)).toBe("# Me\nProfile kept in the vault");
  });

  it("B1: every note is exported, including one saved without .md", async () => {
    await getVaultBackend().write("Notes/a.md", "a");
    await getVaultBackend().write("Inbox/2026-11-15", "legacy note without extension");
    const files = unzipSync((await buildFullExport()).zip);
    expect(strFromU8(files["vault/Inbox/2026-11-15"]!)).toBe("legacy note without extension");
    expect(files["vault/Notes/a.md"]).toBeDefined();
  });

  it("B1: a note missing from the vault index is still exported (index repaired first)", async () => {
    await getVaultBackend().write("Notes/a.md", "a");
    await getVaultBackend().tree(); // the instance has done its periodic check
    kvRef.current.store.set(
      `${NOTE_PREFIX}Notes/lost.md`,
      JSON.stringify({ content: "lost", mtime: "2026-01-01T00:00:00.000Z", size: 4 })
    );
    const { zip, report } = await buildFullExport();
    expect(strFromU8(unzipSync(zip)["vault/Notes/lost.md"]!)).toBe("lost");
    expect(report.warnings.join("\n")).toMatch(/index repaired/);
  });
});

describe("round trip (EXP-03)", () => {
  it("re-imports profiles, skills, notes and settings into an empty instance", async () => {
    await seed();
    await getVaultBackend().write("Inbox/2026-11-15", "note saved before the .md fix");
    const { zip } = await buildFullExport();
    kvRef.current = makeMemoryKV(); // a brand-new instance
    const report = await importFullExport(zip);
    expect(report.profiles.imported.sort()).toEqual(["default", "work"]);
    expect(report.skills.created).toBe(1);
    expect(report.notes).toMatchObject({ written: 2, renamed: 1, skipped: 0 });
    expect(await getProfileContent("work")).toBe("# Work hat");
    expect((await listSkills()).map((s) => s.id)).toContain("meeting_prep");
    expect((await getVaultBackend().read("Notes/idea.md")).content).toContain("[[Other]]");
    // The note without extension comes back as a regular .md note.
    expect((await getVaultBackend().read("Inbox/2026-11-15.md")).content).toBe(
      "note saved before the .md fix"
    );
    expect((await getVaultBackend().recent(10)).map((n) => n.path)).toContain(
      "Inbox/2026-11-15.md"
    );

    // Settings: custom tools, API connections (without keys), tool toggles, display.
    const kv = kvRef.current;
    expect(await kv.get("settings:displayName")).toBe("Alex");
    expect(await kv.get("settings:timezone")).toBe("Europe/Paris");
    expect(await kv.get("settings:locale")).toBe("fr-FR");
    expect(await kv.get("tool:disabled:gmail_send")).toBe("true");
    expect(JSON.parse((await kv.get("custom-tools:all"))!)).toEqual(CUSTOM_TOOLS);
    expect(JSON.parse((await kv.get("api:tools"))!)).toEqual(API_TOOLS);
    const conns = JSON.parse((await kv.get("api:connections"))!) as Array<Record<string, unknown>>;
    expect(conns[0]).toMatchObject({ id: "conn_1", name: "Weather", auth: { type: "none" } });
    expect(conns[0]).not.toHaveProperty("authRemoved");
    expect(report.warnings.join("\n")).toMatch(/"Weather" was imported without its key/);
    // Secrets never travel, even through the import.
    expect(await kv.get("cred:SLACK_BOT_TOKEN")).toBeNull();
    expect(await kv.get("oauth:at:abc")).toBeNull();
    expect(await kv.get("devices:0a1b2c3d")).toBeNull();
  });

  it("B1: vault-mode default profile survives export → re-import of the same zip", async () => {
    // The confirmed scenario: the default profile lives at System/context.md.
    kvRef.current.store.set(KV_CONTEXT_MODE, "vault");
    await getVaultBackend().write("System/context.md", "# Me\nProfile kept in the vault");
    expect(textOf(await handleMyContext())).toContain("Profile kept in the vault");

    const { zip } = await buildFullExport();
    const report = await importFullExport(zip);

    expect(await kvRef.current.get(KV_CONTEXT_MODE)).toBe("vault"); // never forced inline
    expect(textOf(await handleMyContext())).toBe("# Me\nProfile kept in the vault");
    expect(report.profiles.skipped).toContainEqual({ name: "default", reason: "unchanged" });
  });

  it("B1: an old export with an empty profiles/default.md never wipes the profile", async () => {
    kvRef.current.store.set(KV_CONTEXT_MODE, "vault");
    await getVaultBackend().write("System/context.md", "# Me\nin the vault");
    const oldZip = zipSync({ "profiles/default.md": strToU8("") });
    const report = await importFullExport(oldZip);
    expect(report.profiles.skipped).toEqual([{ name: "default", reason: "empty in the export" }]);
    expect(await kvRef.current.get(KV_CONTEXT_MODE)).toBe("vault");
    expect(textOf(await handleMyContext())).toBe("# Me\nin the vault");
  });

  it("B1: a vault-mode default is restored into a fresh instance's vault when it is in vault mode", async () => {
    kvRef.current.store.set(KV_CONTEXT_MODE, "vault");
    await getVaultBackend().write("System/context.md", "# Me\nfrom the old instance");
    const { zip } = await buildFullExport();
    kvRef.current = makeMemoryKV();
    kvRef.current.store.set(KV_CONTEXT_MODE, "vault");
    const report = await importFullExport(zip);
    expect(report.profiles.imported).toContain("default");
    expect(textOf(await handleMyContext())).toBe("# Me\nfrom the old instance");
  });

  it("B1: profiles are additive — an existing profile is kept unless overwriteProfiles", async () => {
    await saveProfile("default", "# Exported");
    await saveProfile("work", "# Work exported");
    const { zip } = await buildFullExport();
    await saveProfile("default", "# Edited since");
    await saveProfile("work", "# Work edited since");

    const kept = await importFullExport(zip);
    expect(kept.profiles.skipped).toEqual(
      expect.arrayContaining([
        { name: "default", reason: "already exists" },
        { name: "work", reason: "already exists" },
      ])
    );
    expect(await getProfileContent("default")).toBe("# Edited since");

    const over = await importFullExport(zip, { overwriteProfiles: true });
    expect(over.profiles.overwritten.sort()).toEqual(["default", "work"]);
    expect(await getProfileContent("work")).toBe("# Work exported");
  });

  it("B1: settings are additive — an existing key is kept unless overwriteSettings", async () => {
    await seed();
    const { zip } = await buildFullExport();
    await kvRef.current.set("settings:timezone", "America/New_York");
    const kept = await importFullExport(zip);
    expect(kept.settings.skipped).toContainEqual({
      key: "settings:timezone",
      reason: "already exists",
    });
    expect(await kvRef.current.get("settings:timezone")).toBe("America/New_York");
    // Existing API connections (with their real key) are never replaced by keyless copies.
    expect(JSON.parse((await kvRef.current.get("api:connections"))!)[0].auth.type).toBe("bearer");

    const over = await importFullExport(zip, { overwriteSettings: true });
    expect(over.settings.overwritten).toContain("settings:timezone");
    expect(await kvRef.current.get("settings:timezone")).toBe("Europe/Paris");
  });

  it("keeps existing notes unless asked to overwrite", async () => {
    await seed();
    const { zip } = await buildFullExport();
    await getVaultBackend().write("Notes/idea.md", "local edit");
    expect((await importFullExport(zip)).notes.skipped).toBe(1);
    expect((await getVaultBackend().read("Notes/idea.md")).content).toBe("local edit");
    expect((await importFullExport(zip, { overwriteNotes: true })).notes.overwritten).toBe(1);
    expect((await getVaultBackend().read("Notes/idea.md")).content).toContain("[[Other]]");
  });
});

describe("zip bombs (B1)", () => {
  it("refuses a zip that inflates past the cap, before inflating it", () => {
    // 8 MB of zeros compresses to a few KB.
    const bomb = zipSync({ "vault/bomb.md": new Uint8Array(8 * 1024 * 1024) }, { level: 9 });
    expect(bomb.byteLength).toBeLessThan(100 * 1024);
    expect(() => safeUnzip(bomb, { maxBytes: 1024 * 1024 })).toThrow(/expands to more than 1 MB/);
  });

  it("refuses a zip with too many entries", () => {
    const many: Record<string, Uint8Array> = {};
    for (let i = 0; i < 30; i++) many[`vault/n${i}.md`] = strToU8("x");
    expect(() => safeUnzip(zipSync(many), { maxEntries: 20 })).toThrow(/more than 20 files/);
  });

  it("stops inflating at the cap even when the zip lies about its sizes", () => {
    const bomb = zipSync({ "vault/bomb.md": new Uint8Array(4 * 1024 * 1024) }, { level: 9 });
    // Forge the declared uncompressed size (central directory + local header) to 10 bytes.
    const view = new DataView(bomb.buffer, bomb.byteOffset, bomb.byteLength);
    for (let i = 0; i < bomb.byteLength - 4; i++) {
      const sig = view.getUint32(i, true);
      if (sig === 0x02014b50) view.setUint32(i + 24, 10, true);
      if (sig === 0x04034b50) view.setUint32(i + 22, 10, true);
    }
    expect(() => safeUnzip(bomb, { maxBytes: 1024 * 1024 })).toThrow(ImportRejectedError);
    expect(() => safeUnzip(bomb, { maxBytes: 1024 * 1024 })).toThrow(/expands to more than/);
  });

  it("the import refuses a bomb with a clear error", async () => {
    // 120 MB of zeros, declared honestly: refused from the central directory.
    const bomb = zipSync({ "vault/bomb.md": new Uint8Array(120 * 1024 * 1024) }, { level: 1 });
    await expect(importFullExport(bomb)).rejects.toThrow(/expands to more than 100 MB/);
  });

  it("a regular export still unzips", async () => {
    await seed();
    const files = safeUnzip((await buildFullExport()).zip);
    expect(Object.keys(files)).toContain("profiles/default.md");
  });
});
