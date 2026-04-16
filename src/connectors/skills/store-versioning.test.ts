import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  createSkillVersioned,
  updateSkillVersioned,
  listSkillVersions,
  getSkillVersion,
  getSkillCurrentVersion,
  rollbackSkill,
  listSkills,
} from "./store";

let tmpDir = "";
let originalPath: string | undefined;

async function withTempSkillsFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mymcp-skills-ver-"));
  return path.join(dir, "skills.json");
}

describe("skill versioning", () => {
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

  it("creates a skill with version 1", async () => {
    const skill = await createSkillVersioned({
      name: "Test Skill",
      description: "desc",
      content: "initial content",
      arguments: [],
      source: { type: "inline" },
    });

    const currentVer = await getSkillCurrentVersion(skill.id);
    expect(currentVer).toBe(1);

    const versions = await listSkillVersions(skill.id);
    expect(versions).toEqual([1]);

    const v1 = await getSkillVersion(skill.id, 1);
    expect(v1).not.toBeNull();
    expect(v1!.content).toBe("initial content");
    expect(v1!.version).toBe(1);
  });

  it("increments version on update", async () => {
    const skill = await createSkillVersioned({
      name: "Versioned",
      description: "",
      content: "v1",
      arguments: [],
      source: { type: "inline" },
    });

    await updateSkillVersioned(skill.id, { content: "v2" });
    expect(await getSkillCurrentVersion(skill.id)).toBe(2);

    await updateSkillVersioned(skill.id, { content: "v3" });
    expect(await getSkillCurrentVersion(skill.id)).toBe(3);

    const versions = await listSkillVersions(skill.id);
    expect(versions).toEqual([1, 2, 3]);

    const entry = await getSkillVersion(skill.id, 2);
    expect(entry!.content).toBe("v2");
  });

  it("rollback creates a new version with old content", async () => {
    const skill = await createSkillVersioned({
      name: "RollbackTest",
      description: "",
      content: "original",
      arguments: [],
      source: { type: "inline" },
    });

    await updateSkillVersioned(skill.id, { content: "changed" });
    expect(await getSkillCurrentVersion(skill.id)).toBe(2);

    const result = await rollbackSkill(skill.id, 1);
    expect(result).not.toBeNull();
    expect(result!.content).toBe("original");

    // Should be version 3 (rollback creates v3 with v1 content)
    expect(await getSkillCurrentVersion(skill.id)).toBe(3);

    const v3 = await getSkillVersion(skill.id, 3);
    expect(v3!.content).toBe("original");

    // The actual skill in the store should be updated
    const all = await listSkills();
    const current = all.find((s) => s.id === skill.id);
    expect(current!.content).toBe("original");
  });

  it("returns null when rolling back non-existent skill", async () => {
    const result = await rollbackSkill("nonexistent", 1);
    expect(result).toBeNull();
  });

  it("returns null when rolling back to non-existent version", async () => {
    const skill = await createSkillVersioned({
      name: "NoVer",
      description: "",
      content: "body",
      arguments: [],
      source: { type: "inline" },
    });
    const result = await rollbackSkill(skill.id, 999);
    expect(result).toBeNull();
  });
});
