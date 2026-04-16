import { describe, it, expect } from "vitest";
import { toClaudeSkillFile, type SkillLike } from "./export-claude";

describe("toClaudeSkillFile", () => {
  const base: SkillLike = {
    name: "Weekly Report",
    description: "Generates a weekly status report from notes",
    content: "Summarize: {{notes}}",
    source: { type: "inline" },
  };

  it("converts an inline skill to Claude Skill format", () => {
    const result = toClaudeSkillFile(base, { exportedAt: "2026-04-15T00:00:00.000Z" });
    expect(result).toEqual({
      name: "Weekly Report",
      description: "Generates a weekly status report from notes",
      content: "Summarize: {{notes}}",
      metadata: {
        source: "mymcp",
        version: "1.0",
        exportedAt: "2026-04-15T00:00:00.000Z",
      },
    });
  });

  it("uses cached content for remote skills with empty content", () => {
    const remote: SkillLike = {
      name: "Remote Skill",
      description: "A remote skill",
      content: "",
      source: { type: "remote", cachedContent: "Cached body here" },
    };
    const result = toClaudeSkillFile(remote);
    expect(result.content).toBe("Cached body here");
  });

  it("prefers inline content over cached content", () => {
    const mixed: SkillLike = {
      name: "Mixed",
      description: "Has both",
      content: "Inline body",
      source: { type: "remote", cachedContent: "Cached body" },
    };
    const result = toClaudeSkillFile(mixed);
    expect(result.content).toBe("Inline body");
  });

  it("falls back to name when description is empty", () => {
    const noDesc: SkillLike = {
      name: "My Skill",
      description: "",
      content: "body",
    };
    const result = toClaudeSkillFile(noDesc);
    expect(result.description).toBe("My Skill");
  });

  it("accepts custom version override", () => {
    const result = toClaudeSkillFile(base, { version: "2.0" });
    expect(result.metadata.version).toBe("2.0");
  });

  it("generates exportedAt when not provided", () => {
    const result = toClaudeSkillFile(base);
    expect(result.metadata.exportedAt).toBeTruthy();
    // Should be valid ISO string
    expect(new Date(result.metadata.exportedAt).toISOString()).toBe(result.metadata.exportedAt);
  });

  it("handles missing source gracefully", () => {
    const noSource: SkillLike = {
      name: "Plain",
      description: "No source",
      content: "Body text",
    };
    const result = toClaudeSkillFile(noSource);
    expect(result.content).toBe("Body text");
  });

  it("returns empty content for remote skill with no cache", () => {
    const emptyRemote: SkillLike = {
      name: "Empty Remote",
      description: "No cache",
      content: "",
      source: { type: "remote" },
    };
    const result = toClaudeSkillFile(emptyRemote);
    expect(result.content).toBe("");
  });
});
