import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createSkill, listSkills, updateSkill, deleteSkill } from "./store";

let tmpDir = "";
let originalPath: string | undefined;

async function withTempSkillsFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mymcp-skills-"));
  return path.join(dir, "skills.json");
}

describe("skills store CRUD", () => {
  beforeEach(async () => {
    originalPath = process.env.MYMCP_SKILLS_PATH;
    const p = await withTempSkillsFile();
    tmpDir = path.dirname(p);
    process.env.MYMCP_SKILLS_PATH = p;
  });

  afterEach(async () => {
    if (originalPath === undefined) delete process.env.MYMCP_SKILLS_PATH;
    else process.env.MYMCP_SKILLS_PATH = originalPath;
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("lists empty when no file", async () => {
    const all = await listSkills();
    expect(all).toEqual([]);
  });

  it("creates and reads back a skill", async () => {
    const s = await createSkill({
      name: "Weekly Review",
      description: "desc",
      content: "body",
      arguments: [],
      source: { type: "inline" },
    });
    expect(s.id).toBeTruthy();
    const all = await listSkills();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("Weekly Review");
  });

  it("updates an existing skill", async () => {
    const s = await createSkill({
      name: "Alpha",
      description: "",
      content: "v1",
      arguments: [],
      source: { type: "inline" },
    });
    const updated = await updateSkill(s.id, { content: "v2" });
    expect(updated?.content).toBe("v2");
    expect(updated?.createdAt).toBe(s.createdAt);
  });

  it("deletes a skill", async () => {
    const s = await createSkill({
      name: "Beta",
      description: "",
      content: "",
      arguments: [],
      source: { type: "inline" },
    });
    const ok = await deleteSkill(s.id);
    expect(ok).toBe(true);
    expect(await listSkills()).toHaveLength(0);
  });

  it("returns false when deleting an unknown id", async () => {
    expect(await deleteSkill("missing")).toBe(false);
  });

  it("serializes concurrent createSkill calls via write mutex", async () => {
    const [a, b] = await Promise.all([
      createSkill({
        name: "Concurrent A",
        description: "",
        content: "",
        arguments: [],
        source: { type: "inline" },
      }),
      createSkill({
        name: "Concurrent B",
        description: "",
        content: "",
        arguments: [],
        source: { type: "inline" },
      }),
    ]);
    const all = await listSkills();
    expect(all).toHaveLength(2);
    const ids = all.map((s) => s.id).sort();
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
  });

  it("generates unique ids for duplicate names", async () => {
    const a = await createSkill({
      name: "Same Name",
      description: "",
      content: "",
      arguments: [],
      source: { type: "inline" },
    });
    const b = await createSkill({
      name: "Same Name",
      description: "",
      content: "",
      arguments: [],
      source: { type: "inline" },
    });
    expect(a.id).not.toBe(b.id);
  });
});
