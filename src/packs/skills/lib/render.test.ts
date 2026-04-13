import { describe, it, expect } from "vitest";
import { renderSkill } from "./render";
import type { Skill } from "../store";

function inlineSkill(content: string): Skill {
  return {
    id: "test",
    name: "Test",
    description: "",
    content,
    arguments: [],
    source: { type: "inline" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function remoteSkill(cached: string): Skill {
  return {
    id: "test",
    name: "Test",
    description: "",
    content: "",
    arguments: [],
    source: { type: "remote", url: "https://example.com/s.md", cachedContent: cached },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("renderSkill mustache substitution", () => {
  it("replaces a single placeholder", () => {
    const out = renderSkill(inlineSkill("Hello {{name}}"), { name: "World" });
    expect(out).toBe("Hello World");
  });

  it("replaces multiple placeholders", () => {
    const out = renderSkill(inlineSkill("{{greeting}} {{name}}!"), {
      greeting: "Hi",
      name: "Yass",
    });
    expect(out).toBe("Hi Yass!");
  });

  it("tolerates whitespace inside mustaches", () => {
    const out = renderSkill(inlineSkill("Hello {{  name  }}"), { name: "World" });
    expect(out).toBe("Hello World");
  });

  it("replaces missing placeholders with empty string", () => {
    const out = renderSkill(inlineSkill("Hello {{name}}!"), {});
    expect(out).toBe("Hello !");
  });

  it("appends unused args at the end", () => {
    const out = renderSkill(inlineSkill("Body"), { topic: "AI" });
    expect(out).toBe("Body\n\n**topic**: AI");
  });

  it("appends only args not used as placeholders", () => {
    const out = renderSkill(inlineSkill("Hello {{name}}"), { name: "X", extra: "Y" });
    expect(out).toBe("Hello X\n\n**extra**: Y");
  });

  it("skips empty/null/undefined unused args", () => {
    const out = renderSkill(inlineSkill("Body"), { a: "", b: null, c: undefined, d: "keep" });
    expect(out).toBe("Body\n\n**d**: keep");
  });

  it("returns content unchanged when no args at all", () => {
    const out = renderSkill(inlineSkill("Just content"), {});
    expect(out).toBe("Just content");
  });

  it("coerces non-string values", () => {
    const out = renderSkill(inlineSkill("N={{n}}"), { n: 42 });
    expect(out).toBe("N=42");
  });

  it("handles empty content", () => {
    const out = renderSkill(inlineSkill(""), { topic: "AI" });
    expect(out).toBe("\n\n**topic**: AI");
  });

  it("uses cached content for remote skills with empty inline", () => {
    const out = renderSkill(remoteSkill("Cached {{x}}"), { x: "hi" });
    expect(out).toBe("Cached hi");
  });

  it("ignores non-identifier placeholder patterns", () => {
    const out = renderSkill(inlineSkill("{{ 1bad }} and {{ok}}"), { ok: "yes" });
    expect(out).toBe("{{ 1bad }} and yes");
  });
});
