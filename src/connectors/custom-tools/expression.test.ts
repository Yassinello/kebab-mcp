import { describe, it, expect } from "vitest";
import { renderTemplate, validateTemplate, expandArgs, ExpressionError } from "./expression";

describe("expression — interpolation", () => {
  it("substitutes a single variable", () => {
    expect(renderTemplate("Hello {{name}}!", { name: "Yass" })).toBe("Hello Yass!");
  });

  it("renders missing variables as empty string", () => {
    expect(renderTemplate("X={{missing}}Y", {})).toBe("X=Y");
  });

  it("supports dotted property access", () => {
    expect(
      renderTemplate("v={{obj.field.nested}}", {
        obj: { field: { nested: "deep" } },
      })
    ).toBe("v=deep");
  });

  it("returns empty string when a path segment is missing mid-walk", () => {
    expect(renderTemplate("v={{obj.missing.deep}}", { obj: {} })).toBe("v=");
  });

  it("stringifies numbers and booleans", () => {
    expect(renderTemplate("{{n}}/{{b}}", { n: 42, b: true })).toBe("42/true");
  });

  it("JSON-encodes object/array values", () => {
    expect(renderTemplate("{{x}}", { x: { a: 1, b: [2, 3] } })).toBe('{"a":1,"b":[2,3]}');
  });
});

describe("expression — conditionals", () => {
  it("renders a section body when the var is truthy", () => {
    expect(
      renderTemplate("Task{{#priority}} #{{priority}}{{/priority}}.", {
        priority: "high",
      })
    ).toBe("Task #high.");
  });

  it("skips a section body when the var is falsy", () => {
    expect(renderTemplate("Task{{#priority}} #{{priority}}{{/priority}}.", {})).toBe("Task.");
    expect(
      renderTemplate("Task{{#priority}} #{{priority}}{{/priority}}.", {
        priority: "",
      })
    ).toBe("Task.");
  });

  it("supports inverse {{^}} sections", () => {
    expect(renderTemplate("{{^x}}empty{{/x}}", {})).toBe("empty");
    expect(renderTemplate("{{^x}}empty{{/x}}", { x: "set" })).toBe("");
  });

  it("treats empty arrays / empty objects as falsy", () => {
    expect(renderTemplate("{{#xs}}has{{/xs}}", { xs: [] })).toBe("");
    expect(renderTemplate("{{#xs}}has{{/xs}}", { xs: [1] })).toBe("has");
    expect(renderTemplate("{{#o}}has{{/o}}", { o: {} })).toBe("");
    expect(renderTemplate("{{#o}}has{{/o}}", { o: { k: 1 } })).toBe("has");
  });
});

describe("expression — strict refusal of unsupported tags", () => {
  it("rejects triple-stash {{{ }}}", () => {
    expect(() => validateTemplate("{{{raw}}}")).toThrow(ExpressionError);
  });

  it("rejects partials {{> ...}}", () => {
    expect(() => validateTemplate("{{> partial}}")).toThrow(ExpressionError);
  });

  it("rejects comments {{! ...}}", () => {
    expect(() => validateTemplate("{{! note }}")).toThrow(ExpressionError);
  });

  it("rejects delimiter swap {{= ... =}}", () => {
    expect(() => validateTemplate("{{=<% %>=}}")).toThrow(ExpressionError);
  });

  it("rejects unescape modifier {{& ...}}", () => {
    expect(() => validateTemplate("{{& raw}}")).toThrow(ExpressionError);
  });

  it("rejects invalid path segments (digits-prefixed)", () => {
    expect(() => validateTemplate("{{1var}}")).toThrow(ExpressionError);
  });

  it("rejects unclosed sections", () => {
    expect(() => validateTemplate("{{#x}}body")).toThrow(ExpressionError);
  });

  it("rejects mismatched closing tags", () => {
    expect(() => validateTemplate("{{#x}}body{{/y}}")).toThrow(ExpressionError);
  });

  it("rejects empty {{}} tags", () => {
    expect(() => validateTemplate("{{}}")).toThrow(ExpressionError);
  });
});

describe("expression — text + escape semantics", () => {
  it("preserves whitespace and literal newlines around tags", () => {
    const t = "line1\n  {{x}}\nline3";
    expect(renderTemplate(t, { x: "Y" })).toBe("line1\n  Y\nline3");
  });

  it("does not interpret HTML entities (raw output)", () => {
    expect(renderTemplate("{{html}}", { html: "<b>x</b>" })).toBe("<b>x</b>");
  });
});

describe("expression — expandArgs", () => {
  it("renders string leaves only", () => {
    const args = {
      path: "Tasks/Kanban.md",
      content: "{{newKanban}}",
      flags: { dry: false, count: 3 },
      tags: ["{{tag}}", "static"],
    };
    const ctx = { newKanban: "BODY", tag: "T1" };
    const out = expandArgs(args, ctx) as Record<string, unknown>;
    expect(out.path).toBe("Tasks/Kanban.md");
    expect(out.content).toBe("BODY");
    expect(out.flags).toEqual({ dry: false, count: 3 });
    expect(out.tags).toEqual(["T1", "static"]);
  });

  it("returns null/undefined unchanged", () => {
    expect(expandArgs(null, {})).toBeNull();
    expect(expandArgs(undefined, {})).toBeUndefined();
  });
});
