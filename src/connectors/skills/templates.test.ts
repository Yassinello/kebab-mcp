/**
 * Kebab House phase 0 — ritual templates (RIT-01..04) and the master
 * relay (RLY-01/02). Spec: docs/specs/kebab-house-phase-0.md §4-5.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { strFromU8, unzipSync } from "fflate";
import { resetKVStoreCache } from "@/core/kv-store";
import { runWithSkillScope } from "@/core/token-scope";
import {
  createSkill,
  getSkill,
  getSkillCurrentVersion,
  listSkills,
  updateSkill,
  _resetSkillsCacheForTests,
} from "./store";
import {
  MASTER_RELAY_NAME,
  MAX_DESCRIPTION_CHARS,
  masterRelayDescription,
  parseSkillMd,
} from "./lib/bundle";
import { planImport } from "./lib/importer";
import { exportMasterRelayZip } from "./lib/exporter";
import { skillsListPayload, skillLoadText } from "./lib/library";
import {
  RITUALS_TAG,
  installSkillTemplate,
  listSkillTemplates,
  templateCatalog,
} from "./lib/templates";
import { SKILL_TEMPLATE_SOURCES } from "./lib/templates.generated";

const TEMPLATES_DIR = path.resolve(__dirname, "../../../content/skill-templates");
const EXPECTED = ["remember", "morning-brief", "meeting-prep", "weekly-review", "read-later"];

/** Tools a template may reference (spec RIT-01) — anything else must be optional. */
const GENERIC_TOOLS = new Set([
  "my_context",
  "my_context_update",
  "vault_write",
  "vault_append",
  "vault_search",
  "vault_recent",
  "vault_read",
  "save_article",
  "skills_list",
  "skill_load",
  "kebab_weekly_recap",
]);

let tmpDir = "";
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kebab-templates-"));
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

describe("template loader (RIT-01/02)", () => {
  it("finds the 5 ritual templates, in display order", () => {
    expect(listSkillTemplates().map((t) => t.name)).toEqual(EXPECTED);
  });

  it("the bundled module matches content/skill-templates (run `npm run gen:skill-templates`)", () => {
    const folders = readdirSync(TEMPLATES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    expect(SKILL_TEMPLATE_SOURCES.map((s) => s.folder)).toEqual(folders);
    for (const src of SKILL_TEMPLATE_SOURCES) {
      const onDisk = readFileSync(path.join(TEMPLATES_DIR, src.folder, "SKILL.md"), "utf-8");
      expect(src.skillMd, `${src.folder}/SKILL.md is stale in templates.generated.ts`).toBe(onDisk);
    }
  });

  it.each(EXPECTED)("%s has valid Agent Skills frontmatter", (name) => {
    const t = listSkillTemplates().find((x) => x.name === name)!;
    const parsed = parseSkillMd(t.skillMd);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.name).toBe(name);
    expect(parsed.description.length).toBeGreaterThan(80);
    // Agent Skills limit: 1024 characters (the store accepts the same).
    expect(parsed.description.length).toBeLessThanOrEqual(1024);
    expect(parsed.description).toMatch(/^Use /);
    expect(parsed.tags).toEqual([RITUALS_TAG]);
    expect(parsed.arguments).toEqual([]);
    expect(t.icon).not.toBe("");
  });

  it.each(EXPECTED)("%s parses through the importer without warnings", async (name) => {
    const t = listSkillTemplates().find((x) => x.name === name)!;
    const plan = await planImport({ skillMd: t.skillMd });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]!.warnings).toEqual([]);
    expect(plan.items[0]!.name).toBe(name);
    expect(plan.items[0]!.action).toBe("create");
  });

  it.each(EXPECTED)("%s only relies on generic tools and degrades gracefully", (name) => {
    const t = listSkillTemplates().find((x) => x.name === name)!;
    const toolRefs = [...t.body.matchAll(/`([a-z][a-z0-9_]*_[a-z0-9_]+|[a-z]+_[a-z]+)`/g)]
      .map((m) => m[1]!)
      .filter((ref) => /^(my_|vault_|save_|skill|kebab_)/.test(ref));
    expect(toolRefs.length).toBeGreaterThan(0);
    for (const ref of toolRefs) expect(GENERIC_TOOLS.has(ref), ref).toBe(true);
    expect(t.body).toMatch(/my_context/);
    // Every template says what to do when a tool is missing.
    expect(t.body).toMatch(/not available|is missing|tool is not|Without vault tools/i);
    // No personal data in public templates.
    expect(t.body).not.toMatch(/cadens|yassine|@[a-z0-9-]+\.[a-z]{2,}/i);
  });

  it("weekly-review prefers kebab_weekly_recap and falls back to vault_recent", () => {
    const t = listSkillTemplates().find((x) => x.name === "weekly-review")!;
    expect(t.body).toMatch(/kebab_weekly_recap[^\n]*available[^\n]*Otherwise[^\n]*vault_recent/);
  });
});

describe("template install (RIT-02/03/04)", () => {
  it("installs through the import path: rituals tag, inline source, versioned", async () => {
    const res = await installSkillTemplate("morning-brief");
    expect(res).toMatchObject({ ok: true, id: "morning_brief", action: "created" });
    const skill = await getSkill("morning_brief");
    expect(skill).not.toBeNull();
    expect(skill!.tags).toEqual([RITUALS_TAG]);
    expect(skill!.source.type).toBe("inline");
    expect(skill!.exposeAsTool).toBe(false);
    expect(skill!.name).toBe("Morning brief");
    expect(skill!.content).toMatch(/^# Morning brief/);
    expect(await getSkillCurrentVersion("morning_brief")).toBe(1);
  });

  it("is idempotent: installing twice keeps one skill and does not add a version", async () => {
    await installSkillTemplate("remember");
    const again = await installSkillTemplate("remember");
    expect(again).toMatchObject({ ok: true, id: "remember", action: "unchanged" });
    const all = await listSkills();
    expect(all.filter((s) => s.id.startsWith("remember"))).toHaveLength(1);
    expect(await getSkillCurrentVersion("remember")).toBe(1);
  });

  it("accepts the Kebab id as well as the Agent Skills name", async () => {
    expect(await installSkillTemplate("read_later")).toMatchObject({ ok: true, id: "read_later" });
  });

  it("updates a modified copy (new version, no duplicate) and keeps the user's name and tags", async () => {
    await installSkillTemplate("meeting-prep");
    await updateSkill("meeting_prep", {
      name: "My meeting prep",
      content: "my own edits",
      tags: ["rituals", "perso"],
    });
    expect((await templateCatalog()).find((t) => t.id === "meeting-prep")!.status).toBe("modified");

    const res = await installSkillTemplate("meeting-prep");
    expect(res).toMatchObject({ ok: true, id: "meeting_prep", action: "updated" });
    const all = await listSkills();
    expect(all.filter((s) => s.id.startsWith("meeting_prep"))).toHaveLength(1);
    const skill = await getSkill("meeting_prep");
    expect(skill!.content).toMatch(/^# Meeting prep/);
    expect(skill!.name).toBe("My meeting prep");
    expect(skill!.tags).toEqual(["rituals", "perso"]);
    expect(await getSkillCurrentVersion("meeting_prep")).toBe(2);
    expect((await templateCatalog()).find((t) => t.id === "meeting-prep")!.status).toBe(
      "installed"
    );
  });

  it("re-adds the rituals tag when the user removed it", async () => {
    await installSkillTemplate("weekly-review");
    await updateSkill("weekly_review", { tags: ["perso"] });
    await installSkillTemplate("weekly-review");
    expect((await getSkill("weekly_review"))!.tags).toEqual(["rituals", "perso"]);
  });

  it("rejects an unknown template", async () => {
    expect(await installSkillTemplate("summarize-article")).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it("leaves previously installed starter skills untouched (RIT-04)", async () => {
    const legacy = await createSkill({
      name: "summarize-article",
      description: "Reads a URL and produces a tight TL;DR.",
      content: "Read the article at {{url}} and produce a TL;DR.",
      arguments: [{ name: "url", description: "URL", required: true }],
      exposeAsTool: true,
      source: { type: "inline" },
    });
    const before = JSON.stringify(await getSkill(legacy.id));
    for (const name of EXPECTED) await installSkillTemplate(name);
    expect(JSON.stringify(await getSkill(legacy.id))).toBe(before);
    expect((await listSkills()).map((s) => s.id).sort()).toEqual(
      [legacy.id, "meeting_prep", "morning_brief", "read_later", "remember", "weekly_review"].sort()
    );
  });

  it("catalogue reports the install status of each template", async () => {
    await installSkillTemplate("remember");
    const cat = await templateCatalog();
    expect(cat.map((t) => t.id)).toEqual(EXPECTED);
    expect(cat.find((t) => t.id === "remember")).toMatchObject({
      status: "installed",
      installed: true,
      skillId: "remember",
      title: "Remember",
      tags: [RITUALS_TAG],
    });
    expect(cat.find((t) => t.id === "morning-brief")).toMatchObject({
      status: "available",
      installed: false,
    });
  });

  it("installed templates follow the per-token tag scope (RIT-03)", async () => {
    await installSkillTemplate("remember");
    const names = async (scope: string[] | null) =>
      runWithSkillScope(scope, async () => {
        const p = (await skillsListPayload({})) as { skills: { name: string }[] };
        return p.skills.map((s) => s.name);
      });
    expect(await names(["perso"])).toEqual([]);
    expect(await names(["rituals"])).toEqual(["remember"]);
    expect(await names(null)).toEqual(["remember"]);
    const hidden = await runWithSkillScope(["perso"], () => skillLoadText({ name: "remember" }));
    expect(hidden.ok).toBe(false);
  });
});

describe("master relay (RLY-01/02)", () => {
  function readZip(zip: Uint8Array): Record<string, string> {
    const files = unzipSync(zip);
    return Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strFromU8(v)]));
  }

  it("is a zip with kebab-house/SKILL.md listing the skill names", async () => {
    await createSkill({ name: "pitch deck", description: "d", source: { type: "inline" } });
    await installSkillTemplate("remember");
    const { zip, count } = await exportMasterRelayZip(null);
    expect(count).toBe(2);
    const files = readZip(zip);
    expect(Object.keys(files)).toEqual([`${MASTER_RELAY_NAME}/SKILL.md`]);
    const md = files[`${MASTER_RELAY_NAME}/SKILL.md`]!;
    const parsed = parseSkillMd(md);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.name).toBe("kebab-house");
    expect(parsed.description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS);
    expect(parsed.description).toMatch(/^Use for /);
    expect(parsed.description).toContain("Skills: pitch-deck, remember.");
    // Body: my_context → skills_list → skill_load, then stop if unavailable.
    const order = ["my_context", "skills_list", "skill_load"].map((t) => parsed.body.indexOf(t));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(parsed.body).toMatch(/not available in this conversation, say so and stop/);
  });

  it("truncates the name list cleanly to fit 1024 characters", () => {
    const names = Array.from({ length: 120 }, (_, i) => `a-rather-long-skill-name-${i}`);
    const desc = masterRelayDescription(names);
    expect(desc.length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS);
    const m = desc.match(/, and (\d+) more \(see skills_list\)\.$/);
    expect(m).not.toBeNull();
    const listed = desc.slice(desc.indexOf("Skills: ") + 8, desc.indexOf(", and ")).split(", ");
    // Whole names only, and the count adds up.
    expect(listed.every((n) => names.includes(n))).toBe(true);
    expect(listed.length + Number(m![1])).toBe(names.length);
  });

  it("handles an empty library", async () => {
    const { zip, count } = await exportMasterRelayZip(null);
    expect(count).toBe(0);
    const md = readZip(zip)[`${MASTER_RELAY_NAME}/SKILL.md`]!;
    expect(parseSkillMd(md).description).toMatch(/No skills yet/);
  });

  it("?tag= keeps only the skills carrying that tag (RLY-02)", async () => {
    await createSkill({ name: "perso one", source: { type: "inline" }, tags: ["perso"] });
    await createSkill({ name: "work one", source: { type: "inline" }, tags: ["work"] });
    const { zip, count } = await exportMasterRelayZip("perso");
    expect(count).toBe(1);
    const parsed = parseSkillMd(readZip(zip)[`${MASTER_RELAY_NAME}/SKILL.md`]!);
    expect(parsed.description).toContain("perso-one");
    expect(parsed.description).not.toContain("work-one");
    expect(parsed.description).toContain("(#perso)");
    expect(parsed.body).toContain('`skills_list` with `tag: "perso"`');
  });
});
