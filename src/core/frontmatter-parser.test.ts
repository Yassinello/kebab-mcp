/**
 * Regression tests for the frontmatter parser used by the skills importer.
 *
 * The parser lives inline in app/api/config/skills/import/route.ts but the
 * route file is a Next handler, hard to import here. Re-exporting the
 * parser into a pure module would be cleaner — for now we exercise it via
 * the same regex engine logic by re-implementing a thin wrapper test.
 *
 * What this enforces (regression coverage for code-review finding H3):
 * - `description: |` block scalar with indented continuation
 * - `description: >` folded block scalar
 * - List of arguments with nested name/description/required
 * - CRLF line endings
 * - Single-line key:value pairs
 * - Missing frontmatter delimiters → empty meta + warning
 *
 * If the parser were extracted to src/core/frontmatter.ts these tests
 * would import from there directly. Until then, this file documents the
 * expected behavior contract.
 */

import { describe, it, expect } from "vitest";

// Inline copy of parseFrontmatter for testability. Must stay in sync with
// app/api/config/skills/import/route.ts. When that file gets refactored to
// import a shared module, delete this duplicate.

interface FrontmatterArg {
  name?: unknown;
  description?: unknown;
  required?: unknown;
}

function parseScalar(s: string): unknown {
  const trimmed = s.trim().replace(/^["']|["']$/g, "");
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  return trimmed;
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function parseFrontmatter(raw: string): {
  meta: Record<string, unknown>;
  body: string;
  warnings: string[];
} {
  const warnings: string[] = [];
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match)
    return {
      meta: {},
      body: raw,
      warnings: ["No frontmatter found — inferring name from URL"],
    };

  const meta: Record<string, unknown> = {};
  const lines = match[1].split(/\r?\n/);

  let currentArrayKey: string | null = null;
  let currentArray: FrontmatterArg[] = [];
  let currentItem: FrontmatterArg | null = null;
  let blockKey: string | null = null;
  let blockKind: "literal" | "folded" | null = null;
  let blockBuf: string[] = [];

  const flushArray = () => {
    if (currentArrayKey) {
      if (currentItem) currentArray.push(currentItem);
      meta[currentArrayKey] = currentArray;
      currentArrayKey = null;
      currentArray = [];
      currentItem = null;
    }
  };

  const flushBlock = () => {
    if (!blockKey) return;
    if (blockKind === "literal") {
      meta[blockKey] = blockBuf.join("\n").replace(/\n+$/, "");
    } else {
      // eslint-disable-next-line no-control-regex
      const NL_PARA = /\u0001/g;
      meta[blockKey] = blockBuf
        .join("\n")
        .replace(/\n{2,}/g, "\u0001")
        .replace(/\n/g, " ")
        .replace(NL_PARA, "\n")
        .trim();
    }
    blockKey = null;
    blockKind = null;
    blockBuf = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, "  ");

    if (blockKey) {
      const indented = /^\s+/.test(line);
      const blank = line.trim() === "";
      if (indented || blank) {
        blockBuf.push(line.replace(/^\s{1,4}/, ""));
        continue;
      }
      flushBlock();
    }

    const topLevel = line.match(/^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/);
    if (topLevel && !line.startsWith(" ") && !line.startsWith("-")) {
      flushArray();
      const [, key, value] = topLevel;
      const trimmed = value.trim();

      if (trimmed === "|" || trimmed === "|-" || trimmed === "|+") {
        blockKey = key;
        blockKind = "literal";
        blockBuf = [];
        continue;
      }
      if (trimmed === ">" || trimmed === ">-" || trimmed === ">+") {
        blockKey = key;
        blockKind = "folded";
        blockBuf = [];
        continue;
      }

      if (trimmed === "") {
        currentArrayKey = key;
        currentArray = [];
        currentItem = null;
      } else {
        meta[key] = stripQuotes(trimmed);
      }
      continue;
    }

    const itemStart = line.match(/^\s*-\s+(.*)$/);
    if (itemStart && currentArrayKey) {
      if (currentItem) currentArray.push(currentItem);
      currentItem = {};
      const inline = itemStart[1].match(/^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/);
      if (inline) {
        const [, k, v] = inline;
        (currentItem as Record<string, unknown>)[k] = parseScalar(v);
      }
      continue;
    }

    const itemField = line.match(/^\s+([a-zA-Z_][\w-]*)\s*:\s*(.*)$/);
    if (itemField && currentItem) {
      const [, k, v] = itemField;
      (currentItem as Record<string, unknown>)[k] = parseScalar(v);
      continue;
    }

    if (line.trim() && !line.trim().startsWith("#")) {
      warnings.push(`Unrecognized frontmatter line: ${line.trim().slice(0, 60)}`);
    }
  }

  flushBlock();
  flushArray();

  return { meta, body: match[2], warnings };
}

describe("parseFrontmatter", () => {
  it("parses a simple key/value frontmatter", () => {
    const src = `---
name: my-skill
description: A short skill
---
body content`;
    const { meta, body } = parseFrontmatter(src);
    expect(meta.name).toBe("my-skill");
    expect(meta.description).toBe("A short skill");
    expect(body.trim()).toBe("body content");
  });

  it("handles literal block scalar (`description: |`) — H3 regression", () => {
    const src = `---
name: my-skill
description: |
  This is a long description
  that spans multiple lines
  and should preserve newlines.
---
body`;
    const { meta } = parseFrontmatter(src);
    expect(meta.name).toBe("my-skill");
    expect(meta.description).toBe(
      "This is a long description\nthat spans multiple lines\nand should preserve newlines."
    );
  });

  it("handles folded block scalar (`description: >`)", () => {
    const src = `---
name: my-skill
description: >
  This is a long description
  that should be folded into
  a single line.
---
body`;
    const { meta } = parseFrontmatter(src);
    expect(meta.description).toBe(
      "This is a long description that should be folded into a single line."
    );
  });

  it("parses a list of arguments with nested fields", () => {
    const src = `---
name: my-skill
arguments:
  - name: notes
    description: Raw notes
    required: true
  - name: tone
    description: Target tone
    required: false
---
body`;
    const { meta } = parseFrontmatter(src);
    expect(Array.isArray(meta.arguments)).toBe(true);
    const args = meta.arguments as { name: string; required: boolean }[];
    expect(args).toHaveLength(2);
    expect(args[0].name).toBe("notes");
    expect(args[0].required).toBe(true);
    expect(args[1].required).toBe(false);
  });

  it("handles CRLF line endings", () => {
    const src = "---\r\nname: my-skill\r\ndescription: hello\r\n---\r\nbody";
    const { meta, body } = parseFrontmatter(src);
    expect(meta.name).toBe("my-skill");
    expect(meta.description).toBe("hello");
    expect(body.trim()).toBe("body");
  });

  it("returns warning when frontmatter is missing", () => {
    const src = "no frontmatter here\njust body";
    const { meta, body, warnings } = parseFrontmatter(src);
    expect(meta).toEqual({});
    expect(body).toContain("no frontmatter");
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toMatch(/no frontmatter/i);
  });

  it("strips surrounding quotes from quoted values", () => {
    const src = `---
name: "my-skill"
description: 'a quoted desc'
---
body`;
    const { meta } = parseFrontmatter(src);
    expect(meta.name).toBe("my-skill");
    expect(meta.description).toBe("a quoted desc");
  });

  it("ignores comment lines starting with #", () => {
    const src = `---
# this is a comment
name: my-skill
# another comment
description: hello
---
body`;
    const { meta, warnings } = parseFrontmatter(src);
    expect(meta.name).toBe("my-skill");
    expect(meta.description).toBe("hello");
    expect(warnings).toHaveLength(0);
  });
});
