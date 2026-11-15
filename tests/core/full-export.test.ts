/**
 * Kebab House phase 2 — EXP-01..03: full export and round-trip import.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { strFromU8, unzipSync } from "fflate";
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

import { buildFullExport, importFullExport, isExcludedFromExport } from "@/core/full-export";
import { saveProfile, getProfileContent } from "@/core/profiles";
import { getVaultBackend } from "@/connectors/vault/lib/select";
import { planImport, applyImport } from "@/connectors/skills/lib/importer";
import { listSkills } from "@/connectors/skills/store";

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
  await kv.set("settings:displayName", "Yass");
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
    for (const leaked of ["xoxb-secret", "oauth:at:", "devices:", "usage:"])
      expect(json).not.toContain(leaked);
    expect(report).toMatchObject({ profiles: 2, skills: 1, notes: 1 });
  });

  it("excludes secret and authorization prefixes, also under a tenant prefix", () => {
    expect(isExcludedFromExport("cred:X")).toBe(true);
    expect(isExcludedFromExport("tenant:acme:oauth:rt:1")).toBe(true);
    expect(isExcludedFromExport("settings:locale")).toBe(false);
  });
});

describe("round trip (EXP-03)", () => {
  it("re-imports profiles, skills and notes into an empty instance", async () => {
    await seed();
    const { zip } = await buildFullExport();
    kvRef.current = makeMemoryKV(); // a brand-new instance
    const report = await importFullExport(zip);
    expect(report.profiles).toBe(2);
    expect(report.skills.created).toBe(1);
    expect(report.notes.written).toBe(1);
    expect(await getProfileContent("work")).toBe("# Work hat");
    expect((await listSkills()).map((s) => s.id)).toContain("meeting_prep");
    expect((await getVaultBackend().read("Notes/idea.md")).content).toContain("[[Other]]");
    // Secrets never travel, even through the import.
    expect(await kvRef.current.get("cred:SLACK_BOT_TOKEN")).toBeNull();
  });

  it("keeps existing notes unless asked to overwrite", async () => {
    await seed();
    const { zip } = await buildFullExport();
    await getVaultBackend().write("Notes/idea.md", "local edit");
    expect((await importFullExport(zip)).notes.skipped).toBe(1);
    expect((await getVaultBackend().read("Notes/idea.md")).content).toBe("local edit");
    expect((await importFullExport(zip, { overwriteNotes: true })).notes.written).toBe(1);
  });
});
