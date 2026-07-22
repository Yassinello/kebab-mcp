/**
 * readPage — pagination + child recursion (v0.21, NREAD-01..04).
 *
 * The pre-v0.21 implementation issued a single `?page_size=100` request and
 * rendered only the first level, so:
 *   · a page over 100 blocks was silently cut off, and
 *   · every nested block (toggle/list children) was invisible.
 * Both were silent data loss — no error, no marker. These tests lock the fix:
 * follow next_cursor to exhaustion, descend into has_children, and when a
 * safety bound IS hit, say so in the output instead of stopping quietly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readPage, MAX_CHILD_DEPTH } from "../notion-api";

const TOKENS = { NOTION_API_KEY: "ntn-test" };

function jsonRes(body: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as Response;
}

function urlOf(call: unknown[]): string {
  return call[0] as string;
}

/** A paragraph block as Notion returns it. */
function para(id: string, text: string, hasChildren = false) {
  return {
    id,
    type: "paragraph",
    has_children: hasChildren,
    paragraph: { rich_text: [{ plain_text: text }] },
  };
}

/** The page-metadata response readPage fetches first. */
const PAGE_META = jsonRes({
  properties: { Name: { type: "title", title: [{ plain_text: "T" }] } },
});

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn();
  global.fetch = fetchSpy as unknown as typeof fetch;
});

describe("readPage pagination (NREAD-01)", () => {
  it("follows next_cursor until has_more is false", async () => {
    fetchSpy
      .mockResolvedValueOnce(PAGE_META)
      .mockResolvedValueOnce(
        jsonRes({ results: [para("b1", "one")], has_more: true, next_cursor: "cur-2" })
      )
      .mockResolvedValueOnce(
        jsonRes({ results: [para("b2", "two")], has_more: true, next_cursor: "cur-3" })
      )
      .mockResolvedValueOnce(
        jsonRes({ results: [para("b3", "three")], has_more: false, next_cursor: null })
      );

    const page = await readPage(TOKENS, "p1");

    // All three cursor pages are represented — the old code stopped after one.
    expect(page.content).toContain("one");
    expect(page.content).toContain("two");
    expect(page.content).toContain("three");
    expect(page.truncated).toBe(false);

    // The 2nd and 3rd children requests carry the cursor handed back.
    const childCalls = fetchSpy.mock.calls.filter((c) => urlOf(c).includes("/children"));
    expect(childCalls).toHaveLength(3);
    expect(urlOf(childCalls[1]!)).toContain("start_cursor=cur-2");
    expect(urlOf(childCalls[2]!)).toContain("start_cursor=cur-3");
  });

  it("stops after one request when has_more is false", async () => {
    fetchSpy
      .mockResolvedValueOnce(PAGE_META)
      .mockResolvedValueOnce(jsonRes({ results: [para("b1", "only")], has_more: false }));

    await readPage(TOKENS, "p1");

    expect(fetchSpy.mock.calls.filter((c) => urlOf(c).includes("/children"))).toHaveLength(1);
  });

  it("requests the max page size Notion allows", async () => {
    fetchSpy
      .mockResolvedValueOnce(PAGE_META)
      .mockResolvedValueOnce(jsonRes({ results: [], has_more: false }));

    await readPage(TOKENS, "p1");

    const childCall = fetchSpy.mock.calls.find((c) => urlOf(c).includes("/children"))!;
    expect(urlOf(childCall)).toContain("page_size=100");
  });
});

describe("readPage child recursion (NREAD-02/04)", () => {
  it("descends into blocks flagged has_children and indents them", async () => {
    fetchSpy
      .mockResolvedValueOnce(PAGE_META)
      // top level: one block WITH children, one without
      .mockResolvedValueOnce(
        jsonRes({
          results: [para("parent", "outer", true), para("plain", "sibling")],
          has_more: false,
        })
      )
      // children of "parent"
      .mockResolvedValueOnce(jsonRes({ results: [para("child", "inner")], has_more: false }));

    const page = await readPage(TOKENS, "p1");

    expect(page.content).toContain("outer");
    // Nested content is present (it was invisible pre-v0.21) and indented.
    expect(page.content).toContain("  inner");
    expect(page.content).toContain("sibling");

    const childCalls = fetchSpy.mock.calls.filter((c) => urlOf(c).includes("/children"));
    expect(childCalls.map(urlOf).some((u) => u.includes("/blocks/parent/children"))).toBe(true);
  });

  it("does NOT issue a request for blocks without children (NREAD-04)", async () => {
    fetchSpy
      .mockResolvedValueOnce(PAGE_META)
      .mockResolvedValueOnce(
        jsonRes({ results: [para("a", "x"), para("b", "y"), para("c", "z")], has_more: false })
      );

    await readPage(TOKENS, "p1");

    // One children call for the page itself, none for the three leaf blocks.
    expect(fetchSpy.mock.calls.filter((c) => urlOf(c).includes("/children"))).toHaveLength(1);
  });

  it("flags truncation when nesting exceeds the depth bound (NREAD-03)", async () => {
    // Every level claims to have children, so the walk hits MAX_CHILD_DEPTH.
    fetchSpy.mockResolvedValueOnce(PAGE_META);
    for (let i = 0; i <= MAX_CHILD_DEPTH; i++) {
      fetchSpy.mockResolvedValueOnce(
        jsonRes({ results: [para(`lvl${i}`, `level ${i}`, true)], has_more: false })
      );
    }

    const page = await readPage(TOKENS, "p1");

    expect(page.truncated).toBe(true);
    expect(page.content).toContain("truncated");
  });

  it("renders a clean page without any truncation marker", async () => {
    fetchSpy
      .mockResolvedValueOnce(PAGE_META)
      .mockResolvedValueOnce(jsonRes({ results: [para("b1", "hello")], has_more: false }));

    const page = await readPage(TOKENS, "p1");

    expect(page.truncated).toBe(false);
    expect(page.content).not.toContain("truncated");
    expect(page.content).toBe("hello");
  });
});

describe("readPage block rendering is unchanged", () => {
  it("still renders headings, lists, todos, code and dividers", async () => {
    fetchSpy.mockResolvedValueOnce(PAGE_META).mockResolvedValueOnce(
      jsonRes({
        results: [
          { id: "1", type: "heading_1", heading_1: { rich_text: [{ plain_text: "H1" }] } },
          { id: "2", type: "heading_2", heading_2: { rich_text: [{ plain_text: "H2" }] } },
          { id: "3", type: "heading_3", heading_3: { rich_text: [{ plain_text: "H3" }] } },
          {
            id: "4",
            type: "bulleted_list_item",
            bulleted_list_item: { rich_text: [{ plain_text: "bullet" }] },
          },
          {
            id: "5",
            type: "numbered_list_item",
            numbered_list_item: { rich_text: [{ plain_text: "num" }] },
          },
          { id: "6", type: "to_do", to_do: { rich_text: [{ plain_text: "done" }], checked: true } },
          {
            id: "7",
            type: "code",
            code: { rich_text: [{ plain_text: "x=1" }], language: "python" },
          },
          { id: "8", type: "divider", divider: {} },
        ],
        has_more: false,
      })
    );

    const page = await readPage(TOKENS, "p1");

    expect(page.content).toContain("# H1");
    expect(page.content).toContain("## H2");
    expect(page.content).toContain("### H3");
    expect(page.content).toContain("- bullet");
    expect(page.content).toContain("1. num");
    expect(page.content).toContain("[x] done");
    expect(page.content).toContain("```python\nx=1\n```");
    expect(page.content).toContain("---");
  });
});
