/**
 * Rich blocks + inline marks (v0.21 phase 79, NRICH-01..06).
 *
 * The connector's core invariant is read/write SYMMETRY: content written by
 * notion_create/notion_update must read back through notion_read as the same
 * markdown. Pre-v0.21 that was held by keeping the converter deliberately
 * poor (no marks at all). This phase widens what's supported on BOTH sides at
 * once — hence the round-trip suite at the bottom, which is the real contract
 * test. Anything we can parse but not render back would silently mangle a
 * page on the next edit.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { markdownToBlocks, readPage } from "../notion-api";

const TOKENS = { NOTION_API_KEY: "ntn-test" };

type Block = { object: string; type: string; [k: string]: unknown };
type Run = {
  text: { content: string; link?: { url: string } };
  annotations?: Record<string, unknown>;
};

function runsOf(b: Block): Run[] {
  const payload = b[b.type] as { rich_text?: Run[] } | undefined;
  return payload?.rich_text ?? [];
}
function textOf(b: Block): string {
  return runsOf(b)
    .map((r) => r.text.content)
    .join("");
}

describe("inline marks (NRICH-05)", () => {
  it("splits a paragraph into annotated runs", () => {
    const [b] = markdownToBlocks("plain **bold** and *italic* end") as Block[];
    const runs = runsOf(b!);
    expect(runs.map((r) => r.text.content)).toEqual(["plain ", "bold", " and ", "italic", " end"]);
    expect(runs[1]!.annotations).toEqual({ bold: true });
    expect(runs[3]!.annotations).toEqual({ italic: true });
    expect(runs[0]!.annotations).toBeUndefined();
  });

  it("supports __bold__ and _italic_ alternates", () => {
    const [b] = markdownToBlocks("__b__ and _i_") as Block[];
    const runs = runsOf(b!);
    expect(runs[0]!.annotations).toEqual({ bold: true });
    expect(runs[2]!.annotations).toEqual({ italic: true });
  });

  it("maps `code` spans and leaves their content literal", () => {
    const [b] = markdownToBlocks("call `foo(**x**)` now") as Block[];
    const runs = runsOf(b!);
    expect(runs[1]!.text.content).toBe("foo(**x**)");
    expect(runs[1]!.annotations).toEqual({ code: true });
  });

  it("maps ~~strikethrough~~", () => {
    const [b] = markdownToBlocks("~~gone~~") as Block[];
    expect(runsOf(b!)[0]!.annotations).toEqual({ strikethrough: true });
  });

  it("maps [text](url) links to text.link", () => {
    const [b] = markdownToBlocks("see [docs](https://example.com) here") as Block[];
    const runs = runsOf(b!);
    expect(runs[1]!.text.content).toBe("docs");
    expect(runs[1]!.text.link).toEqual({ url: "https://example.com" });
  });

  it("applies marks inside headings and list items too", () => {
    const blocks = markdownToBlocks("# A **bold** title\n\n- item with `code`") as Block[];
    expect(runsOf(blocks[0]!)[1]!.annotations).toEqual({ bold: true });
    expect(runsOf(blocks[1]!)[1]!.annotations).toEqual({ code: true });
  });

  it("leaves unmarked text as a single run", () => {
    const [b] = markdownToBlocks("nothing special here") as Block[];
    expect(runsOf(b!)).toHaveLength(1);
    expect(runsOf(b!)[0]!.annotations).toBeUndefined();
  });

  it("does NOT treat intra-word underscores as emphasis", () => {
    // Regression: `MAX_PAGE_BLOCKS` used to parse as MAX<italic>PAGE</italic>
    // BLOCKS, corrupting every snake_case identifier written to a page — and
    // breaking the round-trip, since rendering back produced asterisks.
    for (const text of [
      "MAX_PAGE_BLOCKS and MAX_CHILD_DEPTH",
      "snake_case_name here",
      "file_name_with_underscores.txt",
      "path/to_file and other_thing",
      "a_b_c_d_e",
    ]) {
      const [b] = markdownToBlocks(text) as Block[];
      expect(runsOf(b!)).toHaveLength(1);
      expect(runsOf(b!)[0]!.text.content).toBe(text);
      expect(runsOf(b!)[0]!.annotations).toBeUndefined();
    }
  });

  it("still treats word-boundary underscores as emphasis", () => {
    const [b] = markdownToBlocks("an _emphasised_ word") as Block[];
    const runs = runsOf(b!);
    expect(runs[1]!.text.content).toBe("emphasised");
    expect(runs[1]!.annotations).toEqual({ italic: true });
  });

  it("does not mangle arithmetic with asterisks", () => {
    const text = "50% * 3 = 150 and 2 * 4";
    const [b] = markdownToBlocks(text) as Block[];
    expect(runsOf(b!)).toHaveLength(1);
    expect(runsOf(b!)[0]!.text.content).toBe(text);
  });

  it("leaves an unclosed delimiter as literal text", () => {
    const [b] = markdownToBlocks("**unclosed bold") as Block[];
    expect(runsOf(b!)[0]!.text.content).toBe("**unclosed bold");
    expect(runsOf(b!)[0]!.annotations).toBeUndefined();
  });

  it("does NOT parse marks inside fenced code blocks", () => {
    const [b] = markdownToBlocks("```js\nconst a = **b**;\n```") as Block[];
    const runs = runsOf(b!);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.text.content).toBe("const a = **b**;");
    expect(runs[0]!.annotations).toBeUndefined();
  });
});

describe("callouts (NRICH-01)", () => {
  it("parses > [!emoji] text into a callout with an icon", () => {
    const [b] = markdownToBlocks("> [!💡] Heads up") as Block[];
    expect(b!.type).toBe("callout");
    const payload = b!.callout as { icon: unknown; color: string };
    expect(payload.icon).toEqual({ type: "emoji", emoji: "💡" });
    expect(payload.color).toBe("default");
    expect(textOf(b!)).toBe("Heads up");
  });

  it("honors a trailing {color} attribute", () => {
    const [b] = markdownToBlocks("> [!⚠️] Careful {red_background}") as Block[];
    expect((b!.callout as { color: string }).color).toBe("red_background");
    expect(textOf(b!)).toBe("Careful");
  });

  it("supports an empty icon slot", () => {
    const [b] = markdownToBlocks("> [!] No icon") as Block[];
    expect(b!.type).toBe("callout");
    expect(b!.callout).not.toHaveProperty("icon");
  });

  it("parses inline marks inside a callout", () => {
    const [b] = markdownToBlocks("> [!💡] Use **this**") as Block[];
    expect(runsOf(b!)[1]!.annotations).toEqual({ bold: true });
  });
});

describe("GitHub admonition callouts (field feedback)", () => {
  it("maps [!NOTE]-style keywords to an emoji instead of sending the word", () => {
    // Regression: `> [!note] x` sent {"emoji": "note"} and Notion 400'd. This
    // is the syntax essentially every LLM writes, because it's GitHub's.
    for (const [label, emoji] of [
      ["note", "💡"],
      ["NOTE", "💡"],
      ["warning", "⚠️"],
      ["tip", "✅"],
      ["danger", "🚨"],
      ["important", "❗"],
    ] as const) {
      const [b] = markdownToBlocks(`> [!${label}] Contenu`) as Block[];
      expect(b!.type).toBe("callout");
      expect((b!.callout as { icon: { emoji: string } }).icon.emoji).toBe(emoji);
      expect(textOf(b!)).toBe("Contenu");
    }
  });

  it("gives each admonition a sensible colour", () => {
    const warn = markdownToBlocks("> [!warning] careful")[0] as Block;
    expect((warn.callout as { color: string }).color).toBe("yellow_background");
    const danger = markdownToBlocks("> [!danger] stop")[0] as Block;
    expect((danger.callout as { color: string }).color).toBe("red_background");
  });

  it("an explicit {color} still overrides the admonition default", () => {
    const [b] = markdownToBlocks("> [!warning] careful {purple_background}") as Block[];
    expect((b!.callout as { color: string }).color).toBe("purple_background");
    expect(textOf(b!)).toBe("careful");
  });

  it("folds continuation `>` lines into the same callout", () => {
    // Regression: the body lines became separate paragraphs that kept a
    // literal ">" prefix.
    const [b, ...rest] = markdownToBlocks("> [!note] Ligne un\n> Ligne deux") as Block[];
    expect(rest).toHaveLength(0);
    expect(b!.type).toBe("callout");
    expect(textOf(b!)).toBe("Ligne un\nLigne deux");
  });

  it("a second [!marker] starts a NEW callout rather than being swallowed", () => {
    const blocks = markdownToBlocks("> [!note] one\n> [!warning] two") as Block[];
    expect(blocks.map((b) => b.type)).toEqual(["callout", "callout"]);
    expect(blocks.map(textOf)).toEqual(["one", "two"]);
  });

  it("an unknown label passes through (keeps `> [!💡]` round-tripping)", () => {
    const [b] = markdownToBlocks("> [!💡] direct emoji") as Block[];
    expect((b!.callout as { icon: { emoji: string } }).icon.emoji).toBe("💡");
  });
});

describe("plain blockquotes (field feedback)", () => {
  it("maps `> text` with no marker to a native quote block", () => {
    // Regression: this kept its literal ">" inside a paragraph.
    const [b] = markdownToBlocks("> juste une citation") as Block[];
    expect(b!.type).toBe("quote");
    expect(textOf(b!)).toBe("juste une citation");
  });

  it("folds a multi-line quote into one block", () => {
    const blocks = markdownToBlocks("> line one\n> line two") as Block[];
    expect(blocks).toHaveLength(1);
    expect(textOf(blocks[0]!)).toBe("line one\nline two");
  });
});

describe("toggles (NRICH-02)", () => {
  it("parses the real HTML form authors actually write", () => {
    // v0.21 only accepted the compact `<details> Summary` form, so this —
    // the form every LLM emits — leaked the tags as literal text.
    const [b, ...rest] = markdownToBlocks(
      "<details>\n<summary>Titre</summary>\nContenu\n</details>"
    ) as Block[];
    expect(rest).toHaveLength(0);
    expect(b!.type).toBe("toggle");
    expect(textOf(b!)).toBe("Titre");
    const children = (b!.toggle as { children: Block[] }).children;
    expect(children.map((c) => c.type)).toEqual(["paragraph"]);
  });

  it("handles the HTML form with no <summary> tag", () => {
    const [b] = markdownToBlocks("<details>\nFirst line\nSecond\n</details>") as Block[];
    expect(b!.type).toBe("toggle");
    expect(textOf(b!)).toBe("First line");
  });

  it("keeps parsing content that follows a closed </details>", () => {
    const blocks = markdownToBlocks(
      "<details>\n<summary>T</summary>\nbody\n</details>\n\nafter"
    ) as Block[];
    expect(blocks.map((b) => b.type)).toEqual(["toggle", "paragraph"]);
    expect(textOf(blocks[1]!)).toBe("after");
  });

  it("parses rich children inside the HTML form", () => {
    const [b] = markdownToBlocks(
      "<details>\n<summary>FAQ</summary>\n- one\n- two\n</details>"
    ) as Block[];
    const children = (b!.toggle as { children: Block[] }).children;
    expect(children.map((c) => c.type)).toEqual(["bulleted_list_item", "bulleted_list_item"]);
  });
});

describe("toggles — compact form (NRICH-02)", () => {
  it("parses <details> with indented children", () => {
    const [b] = markdownToBlocks("<details> Summary here\n  inner text\n  - a bullet") as Block[];
    expect(b!.type).toBe("toggle");
    expect(textOf(b!)).toBe("Summary here");
    const children = (b!.toggle as { children: Block[] }).children;
    expect(children.map((c) => c.type)).toEqual(["paragraph", "bulleted_list_item"]);
  });

  it("a toggle with no body has no children key", () => {
    const [b] = markdownToBlocks("<details> Just a summary") as Block[];
    expect(b!.toggle).not.toHaveProperty("children");
  });

  it("stops consuming at the first unindented line", () => {
    const blocks = markdownToBlocks("<details> S\n  inside\nafter") as Block[];
    expect(blocks.map((b) => b.type)).toEqual(["toggle", "paragraph"]);
    expect(textOf(blocks[1]!)).toBe("after");
  });
});

describe("tables (NRICH-03)", () => {
  it("parses a header table into table + table_row children", () => {
    const md = "| A | B |\n| --- | --- |\n| 1 | 2 |";
    const [b] = markdownToBlocks(md) as Block[];

    expect(b!.type).toBe("table");
    const table = b!.table as {
      table_width: number;
      has_column_header: boolean;
      children: Block[];
    };
    expect(table.table_width).toBe(2);
    expect(table.has_column_header).toBe(true);
    expect(table.children).toHaveLength(2);

    const firstRow = table.children[0]!.table_row as { cells: Run[][] };
    expect(firstRow.cells.map((c) => c.map((r) => r.text.content).join(""))).toEqual(["A", "B"]);
  });

  it("a table without a separator row has no column header", () => {
    const [b] = markdownToBlocks("| x | y |\n| 1 | 2 |") as Block[];
    expect((b!.table as { has_column_header: boolean }).has_column_header).toBe(false);
  });

  it("pads short rows to table_width (Notion requires exact cell counts)", () => {
    const [b] = markdownToBlocks("| A | B | C |\n| 1 |") as Block[];
    const table = b!.table as { table_width: number; children: Block[] };
    expect(table.table_width).toBe(3);
    const second = table.children[1]!.table_row as { cells: unknown[][] };
    expect(second.cells).toHaveLength(3);
  });
});

describe("media blocks (NRICH-04)", () => {
  it("parses ![caption](url) into an external image", () => {
    const [b] = markdownToBlocks("![a chart](https://x.com/i.png)") as Block[];
    expect(b!.type).toBe("image");
    const img = b!.image as { external: { url: string }; caption: Run[] };
    expect(img.external.url).toBe("https://x.com/i.png");
    expect(img.caption.map((r) => r.text.content).join("")).toBe("a chart");
  });

  it("an image with no caption omits the caption key", () => {
    const [b] = markdownToBlocks("![](https://x.com/i.png)") as Block[];
    expect(b!.image).not.toHaveProperty("caption");
  });

  it("parses [bookmark](url) and [embed](url)", () => {
    const blocks = markdownToBlocks(
      "[bookmark](https://a.com)\n\n[embed](https://b.com)"
    ) as Block[];
    expect(blocks.map((b) => b.type)).toEqual(["bookmark", "embed"]);
    expect((blocks[0]!.bookmark as { url: string }).url).toBe("https://a.com");
  });

  it("a normal link is still inline text, not a media block", () => {
    const [b] = markdownToBlocks("read [this](https://a.com) page") as Block[];
    expect(b!.type).toBe("paragraph");
  });
});

// --- The contract: what we write, we can read back (NRICH-06) ---

function jsonRes(body: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as Response;
}
const PAGE_META = jsonRes({
  properties: { Name: { type: "title", title: [{ plain_text: "T" }] } },
});

/**
 * Turn the blocks our converter produces into the shape Notion returns on
 * read (plain_text + annotations + has_children), so we can feed them through
 * readPage and compare the rendered markdown to the original input.
 */
function asApiBlock(b: Block, idx: number): Record<string, unknown> {
  const payload = { ...(b[b.type] as Record<string, unknown>) };
  const children = payload.children as Block[] | undefined;
  delete payload.children;

  if (Array.isArray(payload.rich_text)) {
    payload.rich_text = (payload.rich_text as Run[]).map((r) => ({
      plain_text: r.text.content,
      annotations: r.annotations ?? {},
      href: r.text.link?.url ?? null,
    }));
  }
  if (Array.isArray(payload.caption)) {
    payload.caption = (payload.caption as Run[]).map((r) => ({
      plain_text: r.text.content,
      annotations: r.annotations ?? {},
      href: null,
    }));
  }
  if (Array.isArray(payload.cells)) {
    payload.cells = (payload.cells as Run[][]).map((cell) =>
      cell.map((r) => ({
        plain_text: r.text.content,
        annotations: r.annotations ?? {},
        href: null,
      }))
    );
  }

  return {
    id: `b${idx}`,
    type: b.type,
    has_children: Boolean(children?.length),
    [b.type]: payload,
    __children: children ?? [],
  };
}

/** Feed markdown → blocks → (mocked API) → readPage, and return the markdown. */
async function roundTrip(md: string): Promise<string> {
  const blocks = markdownToBlocks(md) as Block[];
  const top = blocks.map(asApiBlock);

  const fetchSpy = vi.fn();
  global.fetch = fetchSpy as unknown as typeof fetch;
  fetchSpy.mockImplementation((url: string) => {
    if (url.includes("/pages/")) return Promise.resolve(PAGE_META);
    // Which block's children are being asked for?
    const match = url.match(/\/blocks\/([^/]+)\/children/);
    const id = match?.[1];
    if (id === "p1") {
      return Promise.resolve(jsonRes({ results: top, has_more: false }));
    }
    const parent = top.find((b) => b.id === id);
    const kids = ((parent?.__children as Block[]) ?? []).map(asApiBlock);
    return Promise.resolve(jsonRes({ results: kids, has_more: false }));
  });

  const page = await readPage(TOKENS, "p1");
  return page.content;
}

describe("read/write round-trip (NRICH-06)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("round-trips inline marks", async () => {
    const md = "plain **bold** and *italic* and `code` and ~~gone~~";
    expect(await roundTrip(md)).toBe(md);
  });

  it("round-trips a link", async () => {
    const md = "see [docs](https://example.com) here";
    expect(await roundTrip(md)).toBe(md);
  });

  it("round-trips a callout with an icon", async () => {
    const md = "> [!💡] Heads up";
    expect(await roundTrip(md)).toBe(md);
  });

  it("round-trips a colored callout", async () => {
    const md = "> [!⚠️] Careful {red_background}";
    expect(await roundTrip(md)).toBe(md);
  });

  it("round-trips an image with a caption", async () => {
    const md = "![a chart](https://x.com/i.png)";
    expect(await roundTrip(md)).toBe(md);
  });

  it("round-trips bookmark and embed", async () => {
    expect(await roundTrip("[bookmark](https://a.com)")).toBe("[bookmark](https://a.com)");
    expect(await roundTrip("[embed](https://b.com)")).toBe("[embed](https://b.com)");
  });

  it("round-trips a table with a header", async () => {
    const md = "| A | B |\n| --- | --- |\n| 1 | 2 |";
    expect(await roundTrip(md)).toBe(md);
  });

  it("round-trips the pre-v0.21 constructs unchanged", async () => {
    const md = ["# Title", "para", "- bullet", "1. numbered", "[x] done", "---"].join("\n\n");
    expect(await roundTrip(md)).toBe(md);
  });

  it("round-trips a fenced code block without touching its contents", async () => {
    // Canonical language names round-trip exactly; aliases (js, ts, sh) are
    // normalized on the way in because Notion's `language` is a closed enum.
    const md = "```javascript\nconst a = **b**;\n```";
    expect(await roundTrip(md)).toBe(md);
  });

  it("round-trips a plain quote", async () => {
    expect(await roundTrip("> juste une citation")).toBe("> juste une citation");
  });

  it("normalizes an admonition to its emoji form on read-back", async () => {
    // `[!note]` is an INPUT convenience; the canonical form we render is the
    // emoji, which re-parses to the same callout. Colour is preserved via the
    // {…} suffix so the second pass produces identical blocks.
    const out = await roundTrip("> [!note] Contenu");
    expect(out).toBe("> [!💡] Contenu {blue_background}");
    // The normalized form is stable — a second pass changes nothing.
    expect(await roundTrip(out)).toBe(out);
  });

  it("normalizes the HTML toggle form to the compact one, then holds stable", async () => {
    const out = await roundTrip("<details>\n<summary>Titre</summary>\nContenu\n</details>");
    expect(out).toBe("<details> Titre\n\n  Contenu");
    expect(await roundTrip(out)).toBe(out);
  });

  it("round-trips prose containing snake_case identifiers", async () => {
    const md = "Set MAX_PAGE_BLOCKS and check other_thing in to_file.txt";
    expect(await roundTrip(md)).toBe(md);
  });

  it("round-trips a paragraph mixing marks and identifiers", async () => {
    const md = "The **MAX_CHILD_DEPTH** bound guards `fetch_block_tree` calls";
    expect(await roundTrip(md)).toBe(md);
  });
});
