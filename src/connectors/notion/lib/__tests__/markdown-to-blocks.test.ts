/**
 * markdownToBlocks — markdown → Notion block objects.
 *
 * The builder is the inverse of readPage()'s block switch, so content written
 * by notion_create / notion_update round-trips through notion_read. These
 * tests lock the block shapes Notion's API expects (object/type/<type>) and
 * the read↔write symmetry for each recognized construct.
 */
import { describe, it, expect } from "vitest";
import { markdownToBlocks } from "../notion-api";

type Block = { object: string; type: string; [k: string]: unknown };

function textOf(b: Block): string {
  const payload = b[b.type] as { rich_text?: { text: { content: string } }[] } | undefined;
  return (payload?.rich_text ?? []).map((r) => r.text.content).join("");
}

describe("markdownToBlocks", () => {
  it("maps headings #/##/### to heading_1/2/3", () => {
    const blocks = markdownToBlocks("# A\n\n## B\n\n### C") as Block[];
    expect(blocks.map((b) => b.type)).toEqual(["heading_1", "heading_2", "heading_3"]);
    expect(blocks.map(textOf)).toEqual(["A", "B", "C"]);
  });

  it("maps bulleted and numbered lists", () => {
    const blocks = markdownToBlocks("- one\n- two\n1. first\n2. second") as Block[];
    expect(blocks.map((b) => b.type)).toEqual([
      "bulleted_list_item",
      "bulleted_list_item",
      "numbered_list_item",
      "numbered_list_item",
    ]);
    expect(blocks.map(textOf)).toEqual(["one", "two", "first", "second"]);
  });

  it("maps checkboxes to to_do with checked flag (both [ ] and - [x] forms)", () => {
    const blocks = markdownToBlocks("[ ] todo\n[x] done\n- [X] also done") as Block[];
    expect(blocks.map((b) => b.type)).toEqual(["to_do", "to_do", "to_do"]);
    expect(blocks.map((b) => (b.to_do as { checked: boolean }).checked)).toEqual([
      false,
      true,
      true,
    ]);
    expect(blocks.map(textOf)).toEqual(["todo", "done", "also done"]);
  });

  it("maps a fenced code block (multi-line) with language", () => {
    const blocks = markdownToBlocks("```ts\nconst a = 1;\nconst b = 2;\n```") as Block[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe("code");
    const code = blocks[0]!.code as {
      language: string;
      rich_text: { text: { content: string } }[];
    };
    // `ts` is normalized to Notion's enum value — the API rejects "ts".
    expect(code.language).toBe("typescript");
    expect(code.rich_text[0]!.text.content).toBe("const a = 1;\nconst b = 2;");
  });

  it("a fenced block with no language tag uses 'plain text'", () => {
    const blocks = markdownToBlocks("```\nraw\n```") as Block[];
    expect((blocks[0]!.code as { language: string }).language).toBe("plain text");
  });

  it("maps --- to a divider", () => {
    const blocks = markdownToBlocks("above\n\n---\n\nbelow") as Block[];
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "divider", "paragraph"]);
  });

  it("groups blank-line-separated runs into paragraphs", () => {
    const blocks = markdownToBlocks("line one\nline two\n\nsecond para") as Block[];
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "paragraph"]);
    expect(textOf(blocks[0]!)).toBe("line one\nline two");
    expect(textOf(blocks[1]!)).toBe("second para");
  });

  it("every block carries the Notion envelope { object: 'block', type, [type] }", () => {
    const blocks = markdownToBlocks("# H\n\ntext\n\n- item") as Block[];
    for (const b of blocks) {
      expect(b.object).toBe("block");
      expect(b).toHaveProperty(b.type);
    }
  });

  it("empty / whitespace-only content yields no blocks", () => {
    expect(markdownToBlocks("")).toEqual([]);
    expect(markdownToBlocks("   \n\n  ")).toEqual([]);
  });

  it("round-trips the format readPage() emits (headings/list/todo/code/divider)", () => {
    // This is exactly what readPage() produces (joined with \n\n).
    const fromRead = ["# Title", "para", "- bullet", "[x] done", "```js\ncode\n```", "---"].join(
      "\n\n"
    );
    const blocks = markdownToBlocks(fromRead) as Block[];
    expect(blocks.map((b) => b.type)).toEqual([
      "heading_1",
      "paragraph",
      "bulleted_list_item",
      "to_do",
      "code",
      "divider",
    ]);
  });
});
