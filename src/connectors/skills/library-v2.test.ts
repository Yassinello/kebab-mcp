/**
 * Skills library v2 — bundle format, import/export round-trip, MCP surface,
 * per-token tag scoping (spec docs/specs/skills-library-v2.md).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { strFromU8, unzipSync, zipSync, strToU8 } from "fflate";
import { resetKVStoreCache } from "@/core/kv-store";
import { runWithSkillScope } from "@/core/token-scope";
import {
  createSkill,
  getSkill,
  getSkillFiles,
  listSkills,
  primeSkillsCache,
  setSkillFiles,
  updateSkill,
  deleteSkill,
  _resetSkillsCacheForTests,
} from "./store";
import {
  normalizeFilePath,
  validateFiles,
  serializeSkillMd,
  parseSkillMd,
  parseSkillsZip,
  buildSkillsZip,
  relaySkillMd,
  toAgentName,
  toKebabId,
  MAX_FILE_BYTES,
} from "./lib/bundle";
import { planImport, applyImport } from "./lib/importer";
import { exportLibraryZip, exportSkillZip, exportRelayZip, LIBRARY_MANIFEST } from "./lib/exporter";
import {
  skillsListPayload,
  skillLoadText,
  skillReadFile,
  buildSkillsInstructions,
  skillResourceProvider,
} from "./lib/library";
import { skillsConnector } from "./manifest";

let tmpDir = "";
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kebab-skills-v2-"));
  for (const k of ["MYMCP_KV_PATH", "MYMCP_SKILLS_PATH", "KEBAB_SKILLS_PATH"])
    saved[k] = process.env[k];
  delete process.env.MYMCP_SKILLS_PATH;
  delete process.env.KEBAB_SKILLS_PATH;
  process.env.MYMCP_KV_PATH = path.join(tmpDir, "kv.json");
  resetKVStoreCache();
  _resetSkillsCacheForTests();
});

afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetKVStoreCache();
  _resetSkillsCacheForTests();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function seed(name: string, extra: Record<string, unknown> = {}) {
  return createSkill({
    name,
    description: `Do ${name} things`,
    content: `Instructions for ${name}.`,
    source: { type: "inline" },
    ...extra,
  });
}

describe("bundle helpers", () => {
  it("maps names both ways", () => {
    expect(toAgentName("meeting_prep")).toBe("meeting-prep");
    expect(toKebabId("Meeting-Prep")).toBe("meeting_prep");
  });

  it.each([
    ["scripts/run.py", "scripts/run.py"],
    ["references/style guide.md", "references/style guide.md"],
    ["../etc/passwd", null],
    ["/abs.md", null],
    ["a\\b.md", null],
    ["a//b.md", null],
    ["SKILL.md", null],
    ["__MACOSX/x.md", null],
    ["ok/./x", null],
  ])("normalizeFilePath(%s) → %s", (input, out) => {
    expect(normalizeFilePath(input)).toBe(out);
  });

  it("validateFiles enforces size and path rules", () => {
    expect(validateFiles({ "a.md": "x" }).ok).toBe(true);
    expect(validateFiles({ "../a.md": "x" }).ok).toBe(false);
    expect(validateFiles({ "a.md": "x".repeat(MAX_FILE_BYTES + 1) }).ok).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`f${i}.md`, "x"]));
    expect(validateFiles(many).ok).toBe(false);
  });

  it("SKILL.md serialize → parse round-trips", () => {
    const md = serializeSkillMd({
      name: "meeting-prep",
      description: "Prepare a meeting: agenda, people, risks",
      body: "# Steps\n1. Read the invite\n",
      tags: ["work", "cadens"],
      arguments: [{ name: "company", description: "Company", required: true }],
      metadata: { title: "Meeting prep" },
    });
    expect(md.startsWith("---\nname: meeting-prep\n")).toBe(true);
    const p = parseSkillMd(md);
    expect(p).toMatchObject({
      name: "meeting-prep",
      title: "Meeting prep",
      description: "Prepare a meeting: agenda, people, risks",
      tags: ["work", "cadens"],
      arguments: [{ name: "company", description: "Company", required: true }],
    });
    expect(p.body).toBe("# Steps\n1. Read the invite\n");
  });

  it("relay skill points to skill_load with the same name + description", () => {
    const md = relaySkillMd("meeting-prep", "Prepare a meeting");
    const p = parseSkillMd(md);
    expect(p.name).toBe("meeting-prep");
    expect(p.description).toBe("Prepare a meeting");
    expect(p.body).toContain("`skill_load`");
    expect(p.body).toContain('"meeting-prep"');
  });

  it("parseSkillsZip handles single folder, root SKILL.md and libraries; skips binaries/unsafe", () => {
    const single = zipSync({
      "my-skill/SKILL.md": strToU8("---\nname: my-skill\ndescription: d\n---\nBody"),
      "my-skill/scripts/run.py": strToU8("print(1)"),
      "my-skill/assets/logo.png": new Uint8Array([137, 80, 78, 71]),
      "__MACOSX/my-skill/._SKILL.md": strToU8("junk"),
    });
    const r1 = parseSkillsZip(single);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.skills).toHaveLength(1);
    expect(r1.skills[0]!.folder).toBe("my-skill");
    expect(Object.keys(r1.skills[0]!.files)).toEqual(["scripts/run.py"]);
    expect(r1.skills[0]!.warnings.join(" ")).toContain("non-text");

    const root = zipSync({ "SKILL.md": strToU8("---\nname: x\ndescription: d\n---\nB") });
    const r2 = parseSkillsZip(root);
    expect(r2.ok && r2.skills[0]!.folder).toBe(null);

    const lib = zipSync({
      "lib/a/SKILL.md": strToU8("---\nname: a\ndescription: d\n---\nA"),
      "lib/b/SKILL.md": strToU8("---\nname: b\ndescription: d\n---\nB"),
      "lib/b/references/x.md": strToU8("X"),
    });
    const r3 = parseSkillsZip(lib);
    expect(r3.ok && r3.skills.map((s) => s.folder).sort()).toEqual(["a", "b"]);
    expect(r3.ok && r3.skills.find((s) => s.folder === "b")!.files).toEqual({
      "references/x.md": "X",
    });
  });

  it("parseSkillsZip rejects garbage, missing SKILL.md and zip bombs", () => {
    expect(parseSkillsZip(strToU8("not a zip")).ok).toBe(false);
    expect(parseSkillsZip(zipSync({ "a.md": strToU8("x") })).ok).toBe(false);
    const bomb = zipSync({
      "s/SKILL.md": strToU8("x"),
      "s/big.txt": strToU8("a".repeat(6 * 1024 * 1024)),
    });
    const r = parseSkillsZip(bomb);
    expect(r.ok).toBe(false);
  });
});

describe("store v2 fields", () => {
  it("new skills: exposeAsTool=false, tags normalized; files stored out of the hot record", async () => {
    const s = await seed("Meeting prep", { tags: ["Work", "work", "Cadens Lab"] });
    expect(s.exposeAsTool).toBe(false);
    expect(s.tags).toEqual(["work", "cadens-lab"]);
    const r = await setSkillFiles(s.id, { "references/a.md": "AAA", "scripts/x.py": "print()" });
    expect("error" in r).toBe(false);
    const got = await getSkill(s.id);
    expect(got!.files).toEqual([
      { path: "references/a.md", size: 3 },
      { path: "scripts/x.py", size: 7 },
    ]);
    expect(await getSkillFiles(s.id)).toEqual({
      "references/a.md": "AAA",
      "scripts/x.py": "print()",
    });
    const raw = await fs.readFile(path.join(tmpDir, "kv.json"), "utf-8");
    const map = JSON.parse(raw) as Record<string, string>;
    expect(map["skills:all"]).not.toContain("AAA");
  });

  it("pre-v2 records (no exposeAsTool/tags/files) keep their dedicated tool", async () => {
    const legacy = [
      {
        id: "old_one",
        name: "Old one",
        description: "legacy",
        content: "c",
        arguments: [],
        toolsAllowed: [],
        source: { type: "inline" },
        syncState: {},
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    await fs.writeFile(
      path.join(tmpDir, "kv.json"),
      JSON.stringify({ "skills:all": JSON.stringify(legacy) })
    );
    resetKVStoreCache();
    await primeSkillsCache();
    const [s] = await listSkills();
    expect(s).toMatchObject({ exposeAsTool: true, tags: [], files: [] });
    expect(skillsConnector.tools.map((t) => t.name)).toContain("skill_old_one");
  });

  it("rejects unsafe files and unknown skills", async () => {
    const s = await seed("A");
    expect(await setSkillFiles(s.id, { "../x": "y" })).toMatchObject({
      error: expect.stringContaining("Invalid file path"),
    });
    expect(await setSkillFiles("nope", {})).toEqual({ error: "skill_not_found" });
  });

  it("deleting a skill deletes its files", async () => {
    const s = await seed("A");
    await setSkillFiles(s.id, { "a.md": "x" });
    await deleteSkill(s.id);
    expect(await getSkillFiles(s.id)).toEqual({});
  });

  it("update keeps files, tags and exposeAsTool unless changed", async () => {
    const s = await seed("A", { tags: ["x"], exposeAsTool: true });
    await setSkillFiles(s.id, { "a.md": "x" });
    const u = await updateSkill(s.id, { description: "new" });
    expect(u).toMatchObject({
      tags: ["x"],
      exposeAsTool: true,
      files: [{ path: "a.md", size: 1 }],
    });
  });
});

describe("import / export", () => {
  it("imports a library zip, then exports byte-identical bodies and files", async () => {
    const zip = zipSync({
      "skills/meeting-prep/SKILL.md": strToU8(
        "---\nname: meeting-prep\ndescription: Prep meetings\nmetadata:\n  tags: [work]\n  title: Meeting prep\n---\n# Steps\nDo it.\n"
      ),
      "skills/meeting-prep/references/checklist.md": strToU8("- [ ] agenda\n"),
      "skills/meeting-prep/scripts/brief.py": strToU8("print('brief')\n"),
      "skills/Weird Name/SKILL.md": strToU8("No frontmatter here\n# Weird skill\n"),
    });
    const plan = await planImport({ zip });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const mp = plan.items.find((i) => i.name === "meeting-prep")!;
    expect(mp).toMatchObject({ action: "create", title: "Meeting prep", tags: ["work"] });
    const weird = plan.items.find((i) => i.name !== "meeting-prep")!;
    expect(weird.name).toBe("weird-name");
    expect(weird.warnings.join(" ")).toMatch(/folder name/);

    const results = await applyImport(plan.items);
    expect(results.every((r) => !r.error)).toBe(true);
    const skill = (await getSkill("meeting_prep"))!;
    expect(skill.name).toBe("Meeting prep");
    expect(skill.exposeAsTool).toBe(false);

    const out = unzipSync(await exportSkillZip(skill));
    expect(Object.keys(out).sort()).toEqual([
      "meeting-prep/SKILL.md",
      "meeting-prep/references/checklist.md",
      "meeting-prep/scripts/brief.py",
    ]);
    const reparsed = parseSkillMd(strFromU8(out["meeting-prep/SKILL.md"]!));
    expect(reparsed.body).toBe("# Steps\nDo it.\n");
    expect(reparsed.title).toBe("Meeting prep");
    expect(strFromU8(out["meeting-prep/scripts/brief.py"]!)).toBe("print('brief')\n");

    // Re-import of the export updates instead of duplicating.
    const again = await planImport({ zip: await exportSkillZip(skill) });
    expect(again.ok && again.items[0]!.action).toBe("update");
    if (again.ok) await applyImport(again.items);
    expect((await listSkills()).filter((s) => s.id === "meeting_prep")).toHaveLength(1);
  });

  it("imports a raw SKILL.md text", async () => {
    const plan = await planImport({
      skillMd: "---\nname: quick-note\ndescription: Notes\n---\nWrite it",
    });
    expect(plan.ok && plan.items[0]).toMatchObject({ name: "quick-note", action: "create" });
    expect((await planImport({ skillMd: "  " })).ok).toBe(false);
  });

  it("relay export contains a single SKILL.md stub", async () => {
    const s = await seed("Meeting prep");
    const out = unzipSync(exportRelayZip(s));
    expect(Object.keys(out)).toEqual(["meeting-prep/SKILL.md"]);
    expect(strFromU8(out["meeting-prep/SKILL.md"]!)).toContain("skill_load");
  });

  it("library export honours the tag scope and writes the manifest", async () => {
    await seed("Perso one", { tags: ["perso"] });
    await seed("Work one", { tags: ["work"] });
    await seed("Untagged");
    const all = await exportLibraryZip(null);
    expect(all.count).toBe(3);
    const scoped = await exportLibraryZip(["work"]);
    expect(scoped.count).toBe(1);
    const files = unzipSync(scoped.zip);
    expect(Object.keys(files).sort()).toEqual([LIBRARY_MANIFEST, "work-one/SKILL.md"]);
    expect(JSON.parse(strFromU8(files[LIBRARY_MANIFEST]!)).skills).toEqual(["work-one"]);
  });

  it("buildSkillsZip / parseSkillsZip round-trip", () => {
    const z = buildSkillsZip([
      { name: "a", skillMd: "---\nname: a\ndescription: d\n---\nx\n", files: { "r.md": "R" } },
    ]);
    const p = parseSkillsZip(z);
    expect(p.ok && p.skills[0]!.files).toEqual({ "r.md": "R" });
  });
});

describe("MCP surface", () => {
  beforeEach(async () => {
    const a = await seed("Meeting prep", { tags: ["work"] });
    await setSkillFiles(a.id, { "references/checklist.md": "- agenda" });
    await seed("Weekly review", {
      tags: ["perso"],
      content: "Review {{period}}",
      arguments: [{ name: "period", description: "Which week", required: true }],
    });
    await primeSkillsCache();
  });

  it("skills_list lists name/description/tags/files and filters", async () => {
    const all = await skillsListPayload({});
    expect(all.count).toBe(2);
    expect(all.skills).toEqual([
      expect.objectContaining({
        name: "meeting-prep",
        tags: ["work"],
        files: ["references/checklist.md"],
      }),
      expect.objectContaining({
        name: "weekly-review",
        arguments: [{ name: "period", required: true }],
      }),
    ]);
    expect((await skillsListPayload({ tag: "perso" })).count).toBe(1);
    expect((await skillsListPayload({ query: "meeting" })).count).toBe(1);
  });

  it("skill_load renders arguments, flags missing ones and lists files", async () => {
    const a = await skillLoadText({ name: "meeting-prep" });
    expect(a.ok && a.text).toContain("Instructions for Meeting prep.");
    expect(a.ok && a.text).toContain("references/checklist.md");
    const b = await skillLoadText({ name: "weekly_review", arguments: { period: "W45" } });
    expect(b.ok && b.text).toContain("Review W45");
    const c = await skillLoadText({ name: "weekly-review" });
    expect(c.ok && c.text).toContain("Missing required argument(s): period");
    const d = await skillLoadText({ name: "meeting" });
    expect(d.ok).toBe(false);
    expect(!d.ok && d.payload).toMatchObject({
      error: "skill_not_found",
      suggestions: ["meeting-prep"],
    });
  });

  it("skill_read_file returns content or the available list", async () => {
    const r = await skillReadFile({ name: "meeting-prep", path: "references/checklist.md" });
    expect(r).toEqual({ ok: true, text: "- agenda" });
    const miss = await skillReadFile({ name: "meeting-prep", path: "nope.md" });
    expect(!miss.ok && miss.payload).toMatchObject({
      error: "file_not_found",
      available: ["references/checklist.md"],
    });
  });

  it("tag scope hides out-of-scope skills everywhere", async () => {
    await runWithSkillScope(["work"], async () => {
      expect((await skillsListPayload({})).count).toBe(1);
      expect((await skillLoadText({ name: "weekly-review" })).ok).toBe(false);
      expect((await skillReadFile({ name: "weekly-review", path: "x" })).ok).toBe(false);
      const uris = (await skillResourceProvider.list()).map((r) => r.uri);
      expect(uris).toEqual([
        "skill://meeting-prep/SKILL.md",
        "skill://meeting-prep/references/checklist.md",
      ]);
      await expect(skillResourceProvider.read("skill://weekly-review/SKILL.md")).rejects.toThrow();
    });
    expect(buildSkillsInstructions(["perso"])).toContain("weekly-review");
    expect(buildSkillsInstructions(["perso"])).not.toContain("meeting-prep");
    expect(buildSkillsInstructions([])).toBe("");
  });

  it("instructions catalogue lists every visible skill and the loading rule", () => {
    const text = buildSkillsInstructions(null);
    expect(text).toContain("call `skill_load`");
    expect(text).toContain("- meeting-prep: Do Meeting prep things");
    expect(skillsConnector.instructions!()).toBe(text);
  });

  it("resources serve SKILL.md with frontmatter and bundled files", async () => {
    const md = await skillResourceProvider.read("skill://meeting-prep/SKILL.md");
    expect(md.text).toMatch(/^---\nname: meeting-prep\n/);
    const f = await skillResourceProvider.read("skill://meeting-prep/references/checklist.md");
    expect(f.text).toBe("- agenda");
  });

  it("tools: 3 library tools always; new skills add no dedicated tool", () => {
    const names = skillsConnector.tools.map((t) => t.name);
    expect(names).toEqual(["skills_list", "skill_load", "skill_read_file"]);
  });

  it("tool handlers return JSON errors and text results", async () => {
    const load = skillsConnector.tools.find((t) => t.name === "skill_load")!;
    const ok = await load.handler({ name: "meeting-prep" });
    expect(ok.content[0]!.text).toContain("# Skill: meeting-prep");
    const ko = await load.handler({ name: "zzz" });
    expect(JSON.parse(ko.content[0]!.text)).toMatchObject({ error: "skill_not_found" });
  });
});

describe("review fixes (pre-merge)", () => {
  it("HIGH: the skills cache is per tenant — tenant B never sees tenant A's skills", async () => {
    const { runWithTenant } = await import("@/core/request-context");
    await runWithTenant("tenant_a", async () => {
      await seed("Secret plan A");
      await primeSkillsCache();
    });
    await runWithTenant("tenant_b", async () => {
      await primeSkillsCache();
      expect(skillsConnector.tools.map((t) => t.name)).toEqual([
        "skills_list",
        "skill_load",
        "skill_read_file",
      ]);
      expect(buildSkillsInstructions(null)).toBe("");
      expect((await skillsListPayload({})).count).toBe(0);
    });
    await runWithTenant("tenant_a", async () => {
      expect((await skillsListPayload({})).count).toBe(1);
    });
  });

  it("MEDIUM: ids `load` / `read_file` are reserved and never shadow library tools", async () => {
    const s = await createSkill({
      name: "Load",
      content: "x",
      source: { type: "inline" },
      exposeAsTool: true,
    });
    expect(s.id).toBe("load_2");
    const legacy = [
      {
        id: "read_file",
        name: "Read file",
        description: "",
        content: "c",
        arguments: [],
        toolsAllowed: [],
        source: { type: "inline" },
        syncState: {},
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    await fs.writeFile(
      path.join(tmpDir, "kv.json"),
      JSON.stringify({ "skills:all": JSON.stringify(legacy) })
    );
    resetKVStoreCache();
    await primeSkillsCache();
    const names = skillsConnector.tools.map((t) => t.name);
    expect(names.filter((n) => n === "skill_read_file")).toHaveLength(1);
  });

  it("MEDIUM: updating via a pasted SKILL.md keeps existing files and tags", async () => {
    const s = await seed("Meeting prep", { tags: ["work"] });
    await setSkillFiles(s.id, { "references/a.md": "A" });
    const plan = await planImport({
      skillMd: "---\nname: meeting-prep\ndescription: New desc\n---\nNew body",
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.items[0]).toMatchObject({ action: "update", keepFiles: true, tags: ["work"] });
    expect(plan.items[0]!.warnings.join(" ")).toMatch(/keeps its 1 existing bundled file/);
    await applyImport(plan.items);
    expect(await getSkillFiles(s.id)).toEqual({ "references/a.md": "A" });
    expect((await getSkill(s.id))!).toMatchObject({ description: "New desc", tags: ["work"] });
  });

  it("MEDIUM: zip entry-count limit aborts early", () => {
    const tree: Record<string, Uint8Array> = {
      "s/SKILL.md": strToU8("---\nname: s\ndescription: d\n---\nx"),
    };
    for (let i = 0; i < 250; i++) tree[`s/references/f${i}.md`] = strToU8("x");
    const r = parseSkillsZip(zipSync(tree));
    expect(r).toEqual({ ok: false, error: expect.stringContaining("exceeds limits") });
  });

  it("LOW: duplicate names in one import produce a single item", async () => {
    const zip = zipSync({
      "a/SKILL.md": strToU8("---\nname: dup\ndescription: first\n---\nA"),
      "b/SKILL.md": strToU8("---\nname: dup\ndescription: second\n---\nB"),
    });
    const plan = await planImport({ zip });
    expect(plan.ok && plan.items).toHaveLength(1);
  });

  it("LOW: skills_list tag filter normalizes like stored tags", async () => {
    await seed("Tagged", { tags: ["Perso Pro"] });
    expect((await skillsListPayload({ tag: "Perso Pro" })).count).toBe(1);
  });

  it("LOW: legacy tool re-checks scope on the fresh skill", async () => {
    const s = await seed("Legacy", { exposeAsTool: true, tags: ["work"] });
    await primeSkillsCache();
    const tool = skillsConnector.tools.find((t) => t.name === `skill_${s.id}`)!;
    await updateSkill(s.id, { tags: ["perso"] });
    const out = await runWithSkillScope(["work"], () => tool.handler({}));
    expect(JSON.parse(out.content[0]!.text)).toMatchObject({ error: "skill_not_found" });
  });
});
