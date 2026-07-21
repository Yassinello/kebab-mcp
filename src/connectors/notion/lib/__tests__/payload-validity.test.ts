/**
 * Payload VALIDITY — would Notion accept what we send? (v0.21 review fixes)
 *
 * Distinct from the round-trip suite in rich-blocks.test.ts, which proves the
 * renderer and the parser agree with each other. Two things can agree and
 * still both be wrong: the round-trip re-serves nested children as a separate
 * fetch, so it never exercises the WRITE payload's nesting depth, and it can't
 * see that a value falls outside one of Notion's closed enums.
 *
 * These tests assert the constraints the API enforces:
 *   · at most 2 levels of nesting per request
 *   · `color` and `code.language` are closed enums
 *   · every table_row carries exactly table_width cells
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { markdownToBlocks, readPage, TRUNCATION_MARKER } from "../notion-api";

const TOKENS = { NOTION_API_KEY: "ntn-test" };

type Block = { object: string; type: string; [k: string]: unknown };

/** Deepest nesting level in a block payload (a leaf block is level 1). */
function depthOf(block: Block, level = 1): number {
  const payload = block[block.type] as { children?: Block[] } | undefined;
  const kids = payload?.children;
  if (!Array.isArray(kids) || kids.length === 0) return level;
  return Math.max(...kids.map((k) => depthOf(k, level + 1)));
}

function maxDepth(md: string): number {
  const blocks = markdownToBlocks(md) as Block[];
  return blocks.length === 0 ? 0 : Math.max(...blocks.map((b) => depthOf(b)));
}

/** Collect every block in the tree, including nested children. */
function flatten(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (const b of blocks) {
    out.push(b);
    const payload = b[b.type] as { children?: Block[] } | undefined;
    if (Array.isArray(payload?.children)) out.push(...flatten(payload.children));
  }
  return out;
}

describe("nesting depth never exceeds Notion's 2-level limit", () => {
  it("a table inside a toggle degrades instead of emitting 3 levels", () => {
    // toggle → table → table_row is 3 levels, and a table MUST carry its rows
    // inline, so this input is an unconditional 400 without the depth guard.
    const md = "<details> Summary\n  | A | B |\n  | --- | --- |\n  | 1 | 2 |";
    expect(maxDepth(md)).toBeLessThanOrEqual(2);
  });

  it("keeps the table content as text when it can't be a real table", () => {
    const md = "<details> S\n  | A | B |\n  | 1 | 2 |";
    const blocks = markdownToBlocks(md) as Block[];
    const all = flatten(blocks);
    // No table block survives at that depth, but the rows are still readable.
    expect(all.some((b) => b.type === "table")).toBe(false);
    const text = JSON.stringify(all);
    expect(text).toContain("A");
    expect(text).toContain("B");
    expect(text).toContain("1");
  });

  it("deeply nested toggles stay within the limit and keep their content", () => {
    const md = "<details> A\n  <details> B\n    <details> C\n      deep text";
    expect(maxDepth(md)).toBeLessThanOrEqual(2);
    expect(JSON.stringify(markdownToBlocks(md))).toContain("deep text");
  });

  it("a single toggle with children is exactly 2 levels (still valid)", () => {
    expect(maxDepth("<details> A\n  inner")).toBe(2);
  });

  it("a top-level table is exactly 2 levels", () => {
    expect(maxDepth("| A | B |\n| --- | --- |\n| 1 | 2 |")).toBe(2);
  });
});

describe("closed enums are respected", () => {
  const VALID_COLORS = new Set([
    "default",
    "gray",
    "brown",
    "orange",
    "yellow",
    "green",
    "blue",
    "purple",
    "pink",
    "red",
    "gray_background",
    "brown_background",
    "orange_background",
    "yellow_background",
    "green_background",
    "blue_background",
    "purple_background",
    "pink_background",
    "red_background",
  ]);

  it("only strips a {suffix} that names a real color", () => {
    const [b] = markdownToBlocks("> [!💡] set {my_var}") as Block[];
    const callout = b!.callout as { color: string };
    expect(VALID_COLORS.has(callout.color)).toBe(true);
    expect(callout.color).toBe("default");
    // The text keeps its tail — it was never a color.
    const runs = (b!.callout as { rich_text: { text: { content: string } }[] }).rich_text;
    expect(runs.map((r) => r.text.content).join("")).toContain("{my_var}");
  });

  it("accepts a real color and removes it from the text", () => {
    const [b] = markdownToBlocks("> [!⚠️] Careful {red_background}") as Block[];
    const callout = b!.callout as {
      color: string;
      rich_text: { text: { content: string } }[];
    };
    expect(callout.color).toBe("red_background");
    expect(callout.rich_text.map((r) => r.text.content).join("")).toBe("Careful");
  });

  it("normalizes code fence aliases to Notion's language enum", () => {
    const cases: [string, string][] = [
      ["ts", "typescript"],
      ["js", "javascript"],
      ["sh", "shell"],
      ["py", "python"],
      ["yml", "yaml"],
      ["notalanguage", "plain text"],
      ["", "plain text"],
    ];
    for (const [fence, expected] of cases) {
      const [b] = markdownToBlocks("```" + fence + "\nx\n```") as Block[];
      expect((b!.code as { language: string }).language).toBe(expected);
    }
  });
});

describe("table rows always carry exactly table_width cells", () => {
  it("pads and trims rows to the declared width", () => {
    for (const md of [
      "| A | B | C |\n| 1 |",
      "| A |\n| 1 | 2 | 3 |",
      "| A | B |\n| --- | --- |\n| 1 | 2 |",
    ]) {
      const [b] = markdownToBlocks(md) as Block[];
      const table = b!.table as { table_width: number; children: Block[] };
      for (const row of table.children) {
        expect((row.table_row as { cells: unknown[] }).cells).toHaveLength(table.table_width);
      }
    }
  });

  it("handles a cell containing an escaped pipe without changing the width", () => {
    const [b] = markdownToBlocks("| a \\| b | c |\n| 1 | 2 |") as Block[];
    const table = b!.table as { table_width: number; children: Block[] };
    expect(table.table_width).toBe(2);
    const firstCell = (table.children[0]!.table_row as { cells: { text: { content: string } }[][] })
      .cells[0]!;
    expect(firstCell.map((r) => r.text.content).join("")).toBe("a | b");
  });

  it("does not drop a lone separator line", () => {
    const blocks = markdownToBlocks("| --- |") as Block[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe("paragraph");
  });
});

// --- Read-side guards that protect the write path ---

function jsonRes(body: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as Response;
}
const PAGE_META = jsonRes({
  properties: { Name: { type: "title", title: [{ plain_text: "T" }] } },
});
function para(id: string, text: string) {
  return {
    id,
    type: "paragraph",
    has_children: false,
    paragraph: { rich_text: [{ plain_text: text }] },
  };
}

describe("truncation detection (guards replace_content)", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
  });

  it("flags truncation when has_more is true but no cursor comes back", async () => {
    // Without this, deleteAllBlocks would believe it saw the whole page and
    // replace_content would append below orphaned blocks.
    fetchSpy
      .mockResolvedValueOnce(PAGE_META)
      .mockResolvedValueOnce(
        jsonRes({ results: [para("a", "one")], has_more: true, next_cursor: null })
      );

    const page = await readPage(TOKENS, "p1");
    expect(page.truncated).toBe(true);
  });

  it("does NOT flag truncation for a page that ends exactly on a page boundary", async () => {
    fetchSpy
      .mockResolvedValueOnce(PAGE_META)
      .mockResolvedValueOnce(
        jsonRes({ results: [para("a", "one")], has_more: true, next_cursor: "c2" })
      )
      .mockResolvedValueOnce(jsonRes({ results: [], has_more: false }));

    const page = await readPage(TOKENS, "p1");
    expect(page.truncated).toBe(false);
  });

  it("the truncation marker contains no inline-mark characters", () => {
    expect(TRUNCATION_MARKER).not.toMatch(/[*_~`]/);
  });

  it("the truncation marker is dropped on write-back, not stored as content", () => {
    const blocks = markdownToBlocks(`real content\n\n${TRUNCATION_MARKER}`) as Block[];
    expect(blocks).toHaveLength(1);
    expect(JSON.stringify(blocks)).not.toContain("truncated");
  });
});
