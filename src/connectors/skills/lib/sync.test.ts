import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Skill } from "../store";
import { listSyncTargets, renderSkillMarkdown, syncSkillToTarget, getSyncTarget } from "./sync";

function makeSkill(partial: Partial<Skill> = {}): Skill {
  return {
    id: "demo_skill",
    name: "Demo Skill",
    description: "A test skill for sync",
    content: "Body content {{arg}}",
    arguments: [{ name: "arg", description: "an arg", required: false }],
    toolsAllowed: ["gmail_search", "slack_send_dm"],
    source: { type: "inline" },
    syncState: {},
    tags: [],
    files: [],
    exposeAsTool: true,
    createdAt: "2026-04-24T00:00:00.000Z",
    updatedAt: "2026-04-24T00:00:00.000Z",
    ...partial,
  };
}

describe("renderSkillMarkdown frontmatter", () => {
  it("emits a YAML-like frontmatter with arguments and tools_allowed", () => {
    const md = renderSkillMarkdown(makeSkill());
    expect(md).toMatch(/^---\n/);
    expect(md).toContain("name: demo_skill");
    expect(md).toContain('display_name: "Demo Skill"');
    expect(md).toContain("arguments:");
    expect(md).toContain("  - name: arg");
    expect(md).toContain("tools_allowed:");
    expect(md).toContain("  - gmail_search");
    expect(md).toContain("  - slack_send_dm");
    expect(md).toContain("Body content {{arg}}");
  });

  it("omits arguments/tools_allowed sections when empty", () => {
    const md = renderSkillMarkdown(makeSkill({ toolsAllowed: [], arguments: [] }));
    expect(md).not.toContain("arguments:");
    expect(md).not.toContain("tools_allowed:");
  });

  it("falls back to cached content for remote skills with empty body", () => {
    const md = renderSkillMarkdown(
      makeSkill({
        content: "",
        source: { type: "remote", url: "https://x", cachedContent: "from-remote" },
      })
    );
    expect(md).toContain("from-remote");
  });
});

describe("listSyncTargets / getSyncTarget", () => {
  const originalEnv = process.env["KEBAB_SKILLS_SYNC_TARGETS"];

  afterEach(() => {
    if (originalEnv === undefined) delete process.env["KEBAB_SKILLS_SYNC_TARGETS"];
    else process.env["KEBAB_SKILLS_SYNC_TARGETS"] = originalEnv;
  });

  it("returns [] when env var unset", () => {
    delete process.env["KEBAB_SKILLS_SYNC_TARGETS"];
    expect(listSyncTargets()).toEqual([]);
  });

  it("parses a JSON array", () => {
    process.env["KEBAB_SKILLS_SYNC_TARGETS"] = JSON.stringify([
      { name: "claude-code", path: "/tmp/out" },
    ]);
    const targets = listSyncTargets();
    expect(targets).toHaveLength(1);
    expect(targets[0]!.name).toBe("claude-code");
    expect(getSyncTarget("claude-code")?.path).toBe("/tmp/out");
    expect(getSyncTarget("missing")).toBeNull();
  });

  it("returns [] on invalid JSON", () => {
    process.env["KEBAB_SKILLS_SYNC_TARGETS"] = "{not-json";
    expect(listSyncTargets()).toEqual([]);
  });

  it("returns [] when schema mismatches", () => {
    process.env["KEBAB_SKILLS_SYNC_TARGETS"] = JSON.stringify([{ foo: "bar" }]);
    expect(listSyncTargets()).toEqual([]);
  });
});

describe("syncSkillToTarget", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kebab-skills-sync-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes <id>.md into the target directory", async () => {
    const skill = makeSkill();
    const result = await syncSkillToTarget(skill, { name: "t", path: tmpDir });
    expect(result.filePath).toBe(path.join(tmpDir, "demo_skill.md"));
    const written = await fs.readFile(result.filePath, "utf-8");
    expect(written).toContain("name: demo_skill");
    expect(written).toContain("Body content {{arg}}");
    expect(result.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("creates the target directory if missing", async () => {
    const nested = path.join(tmpDir, "deeper", "still");
    const result = await syncSkillToTarget(makeSkill(), { name: "t", path: nested });
    const exists = await fs
      .stat(result.filePath)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);
  });

  it("refuses to sync to the root path", async () => {
    await expect(syncSkillToTarget(makeSkill(), { name: "t", path: "/" })).rejects.toThrow(/root/i);
  });
});
