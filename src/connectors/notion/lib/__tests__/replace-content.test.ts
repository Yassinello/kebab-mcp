/**
 * updatePage write path — replace_content, chunking, icon/cover, positioning,
 * and 429 backoff (v0.21, NWRITE-01..08).
 *
 * The pre-v0.21 tool could only APPEND, so rewriting a document meant creating
 * a new page. These tests lock the overwrite semantics (delete every existing
 * block, then write), the API limits that make it non-trivial (100 blocks per
 * request, 2000 chars per rich_text run, ~3 req/s), and the guarantee that a
 * conflicting call mutates nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  updatePage,
  createPage,
  buildIcon,
  buildCover,
  markdownToBlocks,
  MAX_BLOCKS_PER_REQUEST,
  MAX_RICH_TEXT_LENGTH,
  MAX_REPLACE_BLOCKS,
} from "../notion-api";

const TOKENS = { NOTION_API_KEY: "ntn-test" };

function jsonRes(body: unknown, init?: { ok?: boolean; status?: number; retryAfter?: string }) {
  const ok = init?.ok ?? true;
  return {
    ok,
    status: init?.status ?? (ok ? 200 : 500),
    statusText: ok ? "OK" : "Error",
    json: () => Promise.resolve(body),
    headers: { get: (h: string) => (h === "Retry-After" ? (init?.retryAfter ?? null) : null) },
  } as unknown as Response;
}

function bodyOf(call: unknown[]): Record<string, unknown> {
  return JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>;
}
function urlOf(call: unknown[]): string {
  return call[0] as string;
}
function methodOf(call: unknown[]): string {
  return ((call[1] as RequestInit).method as string) || "GET";
}

const FINAL_PAGE = jsonRes({ id: "p1", url: "https://notion.so/p1" });

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn();
  global.fetch = fetchSpy as unknown as typeof fetch;
});

describe("replace_content (NWRITE-01)", () => {
  it("deletes every existing block, then appends the new content", async () => {
    fetchSpy
      // list existing children
      .mockResolvedValueOnce(
        jsonRes({
          results: [
            { id: "old1", type: "paragraph" },
            { id: "old2", type: "paragraph" },
          ],
          has_more: false,
        })
      )
      .mockResolvedValueOnce(jsonRes({ id: "old1" })) // DELETE old1
      .mockResolvedValueOnce(jsonRes({ id: "old2" })) // DELETE old2
      .mockResolvedValueOnce(jsonRes({ results: [{ id: "new1" }] })) // append
      .mockResolvedValueOnce(FINAL_PAGE);

    const res = await updatePage(TOKENS, "p1", { replaceContent: "# Fresh" });

    const deletes = fetchSpy.mock.calls.filter((c) => methodOf(c) === "DELETE");
    expect(deletes.map(urlOf)).toEqual([
      expect.stringContaining("/blocks/old1"),
      expect.stringContaining("/blocks/old2"),
    ]);
    expect(res.deletedBlocks).toBe(2);

    const append = fetchSpy.mock.calls.find(
      (c) => methodOf(c) === "PATCH" && urlOf(c).includes("/children")
    )!;
    const children = bodyOf(append).children as { type: string }[];
    expect(children.map((b) => b.type)).toEqual(["heading_1"]);
  });

  it("deletes blocks BEYOND the first cursor page (the truncation bug)", async () => {
    // 2 cursor pages of existing blocks: pre-v0.21 only the first would have
    // been seen, leaving the rest in place and duplicating content.
    fetchSpy
      .mockResolvedValueOnce(
        jsonRes({ results: [{ id: "a", type: "paragraph" }], has_more: true, next_cursor: "c2" })
      )
      .mockResolvedValueOnce(
        jsonRes({ results: [{ id: "b", type: "paragraph" }], has_more: false })
      )
      .mockResolvedValueOnce(jsonRes({ id: "a" }))
      .mockResolvedValueOnce(jsonRes({ id: "b" }))
      .mockResolvedValueOnce(jsonRes({ results: [] }))
      .mockResolvedValueOnce(FINAL_PAGE);

    const res = await updatePage(TOKENS, "p1", { replaceContent: "new" });

    expect(res.deletedBlocks).toBe(2);
    expect(fetchSpy.mock.calls.filter((c) => methodOf(c) === "DELETE").map(urlOf)).toEqual([
      expect.stringContaining("/blocks/a"),
      expect.stringContaining("/blocks/b"),
    ]);
  });

  it("reports a PARTIAL state and the trash recovery path when a delete fails", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        jsonRes({
          results: [
            { id: "ok", type: "paragraph" },
            { id: "boom", type: "paragraph" },
          ],
          has_more: false,
        })
      )
      .mockResolvedValueOnce(jsonRes({ id: "ok" }))
      .mockResolvedValueOnce(jsonRes({ message: "conflict" }, { ok: false, status: 409 }));

    await expect(updatePage(TOKENS, "p1", { replaceContent: "x" })).rejects.toThrow(
      /PARTIAL state.*trash/s
    );
    // Nothing was written after the failure.
    expect(
      fetchSpy.mock.calls.some((c) => methodOf(c) === "PATCH" && urlOf(c).includes("/children"))
    ).toBe(false);
  });

  it("refuses a page too large to replace within the lambda budget", async () => {
    // One DELETE per block at ~3 req/s: 200 blocks is already ~68s, past the
    // 60s Hobby clamp. Being killed mid-delete would half-empty the page AND
    // swallow the message saying where the blocks went — so refuse up front.
    const many = Array.from({ length: MAX_REPLACE_BLOCKS + 1 }, (_, i) => ({
      id: `b${i}`,
      type: "paragraph",
    }));
    fetchSpy.mockResolvedValueOnce(jsonRes({ results: many, has_more: false }));

    await expect(updatePage(TOKENS, "p1", { replaceContent: "new" })).rejects.toThrow(
      /capped at 150/
    );
    // Nothing was touched.
    expect(fetchSpy.mock.calls.filter((c) => methodOf(c) === "DELETE")).toHaveLength(0);
  });

  it("allows a page exactly at the replace cap", async () => {
    const atCap = Array.from({ length: MAX_REPLACE_BLOCKS }, (_, i) => ({
      id: `b${i}`,
      type: "paragraph",
    }));
    fetchSpy.mockResolvedValueOnce(jsonRes({ results: atCap, has_more: false }));
    for (let i = 0; i < MAX_REPLACE_BLOCKS; i++) fetchSpy.mockResolvedValueOnce(jsonRes({}));
    fetchSpy.mockResolvedValueOnce(jsonRes({ results: [{ id: "n" }] }));
    fetchSpy.mockResolvedValueOnce(FINAL_PAGE);

    const res = await updatePage(TOKENS, "p1", { replaceContent: "new" });
    expect(res.deletedBlocks).toBe(MAX_REPLACE_BLOCKS);
  });

  it("handles replacing an empty page (no blocks to delete)", async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonRes({ results: [], has_more: false }))
      .mockResolvedValueOnce(jsonRes({ results: [{ id: "n1" }] }))
      .mockResolvedValueOnce(FINAL_PAGE);

    const res = await updatePage(TOKENS, "p1", { replaceContent: "hello" });

    expect(res.deletedBlocks).toBe(0);
    expect(fetchSpy.mock.calls.filter((c) => methodOf(c) === "DELETE")).toHaveLength(0);
  });
});

describe("append/replace exclusivity (NWRITE-02)", () => {
  it("rejects both and performs NO request at all", async () => {
    await expect(
      updatePage(TOKENS, "p1", { appendContent: "a", replaceContent: "b" })
    ).rejects.toThrow(/mutually exclusive/);

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("icon / cover (NWRITE-03)", () => {
  it("buildIcon maps emoji, URL and the remove sentinel", () => {
    expect(buildIcon("🎯")).toEqual({ type: "emoji", emoji: "🎯" });
    expect(buildIcon("https://x.com/i.png")).toEqual({
      type: "external",
      external: { url: "https://x.com/i.png" },
    });
    expect(buildIcon("none")).toBeNull();
    expect(buildIcon("NONE")).toBeNull();
  });

  it("buildCover requires a URL and rejects an emoji", () => {
    expect(buildCover("https://x.com/c.jpg")).toEqual({
      type: "external",
      external: { url: "https://x.com/c.jpg" },
    });
    expect(buildCover("none")).toBeNull();
    expect(() => buildCover("🎯")).toThrow(/must be an external image URL/);
  });

  it("PATCHes icon and cover together in one request", async () => {
    fetchSpy.mockResolvedValueOnce(jsonRes({ id: "p1" })).mockResolvedValueOnce(FINAL_PAGE);

    await updatePage(TOKENS, "p1", { icon: "🚀", cover: "https://x.com/c.jpg" });

    const patch = fetchSpy.mock.calls.find(
      (c) => methodOf(c) === "PATCH" && urlOf(c).includes("/pages/")
    )!;
    expect(bodyOf(patch)).toEqual({
      icon: { type: "emoji", emoji: "🚀" },
      cover: { type: "external", external: { url: "https://x.com/c.jpg" } },
    });
  });

  it("an invalid cover throws BEFORE any block mutation", async () => {
    await expect(updatePage(TOKENS, "p1", { cover: "not-a-url" })).rejects.toThrow(
      /external image URL/
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("createPage passes icon and cover in the POST body", async () => {
    fetchSpy.mockResolvedValueOnce(jsonRes({ id: "new", url: "u" }));

    await createPage(TOKENS, {
      parentId: "db1",
      title: "T",
      parentType: "database",
      icon: "📘",
      cover: "https://x.com/c.png",
    });

    const body = bodyOf(fetchSpy.mock.calls[0]!);
    expect(body.icon).toEqual({ type: "emoji", emoji: "📘" });
    expect(body.cover).toEqual({ type: "external", external: { url: "https://x.com/c.png" } });
  });
});

describe("block chunking (NWRITE-05)", () => {
  it("splits an append over 100 blocks into multiple requests, chained by anchor", async () => {
    const md = Array.from({ length: 150 }, (_, i) => `- item ${i}`).join("\n");
    expect(markdownToBlocks(md)).toHaveLength(150);

    fetchSpy
      .mockResolvedValueOnce(jsonRes({ results: [{ id: "last-of-chunk-1" }] }))
      .mockResolvedValueOnce(jsonRes({ results: [{ id: "last-of-chunk-2" }] }))
      .mockResolvedValueOnce(FINAL_PAGE);

    await updatePage(TOKENS, "p1", { appendContent: md });

    const appends = fetchSpy.mock.calls.filter(
      (c) => methodOf(c) === "PATCH" && urlOf(c).includes("/children")
    );
    expect(appends).toHaveLength(2);
    expect((bodyOf(appends[0]!).children as unknown[]).length).toBe(MAX_BLOCKS_PER_REQUEST);
    expect((bodyOf(appends[1]!).children as unknown[]).length).toBe(50);
    // Second chunk anchors after the last block of the first — otherwise the
    // chunks would interleave or reverse.
    expect(bodyOf(appends[1]!).after).toBe("last-of-chunk-1");
  });

  it("createPage sends at most 100 children inline and appends the overflow", async () => {
    const md = Array.from({ length: 120 }, (_, i) => `- i${i}`).join("\n");

    fetchSpy
      .mockResolvedValueOnce(jsonRes({ id: "new", url: "u" }))
      .mockResolvedValueOnce(jsonRes({ results: [{ id: "x" }] }));

    await createPage(TOKENS, { parentId: "db1", title: "T", parentType: "database", content: md });

    const create = fetchSpy.mock.calls[0]!;
    expect((bodyOf(create).children as unknown[]).length).toBe(MAX_BLOCKS_PER_REQUEST);
    const append = fetchSpy.mock.calls[1]!;
    expect(urlOf(append)).toContain("/blocks/new/children");
    expect((bodyOf(append).children as unknown[]).length).toBe(20);
  });
});

describe("rich_text splitting (NWRITE-06)", () => {
  it("splits a paragraph over 2000 chars into multiple runs without losing text", () => {
    const long = "word ".repeat(1000).trim(); // ~4999 chars
    const blocks = markdownToBlocks(long) as {
      type: string;
      paragraph: { rich_text: { text: { content: string } }[] };
    }[];

    expect(blocks).toHaveLength(1);
    const runs = blocks[0]!.paragraph.rich_text;
    expect(runs.length).toBeGreaterThan(1);
    for (const run of runs) {
      expect(run.text.content.length).toBeLessThanOrEqual(MAX_RICH_TEXT_LENGTH);
    }
    // Concatenation is lossless — Notion renders the runs joined.
    expect(runs.map((r) => r.text.content).join("")).toBe(long);
  });

  it("leaves short text as a single run", () => {
    const blocks = markdownToBlocks("short") as {
      paragraph: { rich_text: unknown[] };
    }[];
    expect(blocks[0]!.paragraph.rich_text).toHaveLength(1);
  });
});

describe("positioned insert (NWRITE-04)", () => {
  it("passes after_block_id as Notion's flat `after` param", async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonRes({ results: [{ id: "n" }] }))
      .mockResolvedValueOnce(FINAL_PAGE);

    await updatePage(TOKENS, "p1", { appendContent: "text", afterBlockId: "anchor-block" });

    const append = fetchSpy.mock.calls.find(
      (c) => methodOf(c) === "PATCH" && urlOf(c).includes("/children")
    )!;
    expect(bodyOf(append).after).toBe("anchor-block");
  });

  it("explains that after_block_id must be a direct child when Notion rejects it", async () => {
    // Notion's validation error never names the anchor, so an agent that
    // passed a nested block id would get no clue what to fix.
    fetchSpy.mockResolvedValueOnce(
      jsonRes({ message: "body failed validation" }, { ok: false, status: 400 })
    );

    await expect(
      updatePage(TOKENS, "p1", { appendContent: "text", afterBlockId: "nested-block" })
    ).rejects.toThrow(/must be a DIRECT child/);
  });

  it("does not rewrite unrelated append errors", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonRes({ message: "rate limited" }, { ok: false, status: 403 })
    );

    await expect(
      updatePage(TOKENS, "p1", { appendContent: "text", afterBlockId: "anchor" })
    ).rejects.toThrow(/403/);
  });

  it("annotates a 400 on block writes with the likely payload causes", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonRes({ message: "body failed validation" }, { ok: false, status: 400 })
    );

    await expect(updatePage(TOKENS, "p1", { appendContent: "text" })).rejects.toThrow(
      /nests more than 2 levels/
    );
  });

  it("fails loudly rather than scattering content when the anchor echo is lost", async () => {
    // >100 blocks with an anchor: if Notion doesn't echo the created ids we
    // cannot place chunk 2, and silently dropping the anchor would put chunk 1
    // mid-page and the rest at the end — content split across two locations.
    const md = Array.from({ length: 150 }, (_, i) => `- item ${i}`).join("\n");
    fetchSpy.mockResolvedValueOnce(jsonRes({}));

    await expect(
      updatePage(TOKENS, "p1", { appendContent: md, afterBlockId: "anchor" })
    ).rejects.toThrow(/cannot be inserted after "anchor"/);
  });

  it("tolerates a missing echo when appending at the end (no anchor)", async () => {
    const md = Array.from({ length: 150 }, (_, i) => `- item ${i}`).join("\n");
    fetchSpy
      .mockResolvedValueOnce(jsonRes({}))
      .mockResolvedValueOnce(jsonRes({}))
      .mockResolvedValueOnce(FINAL_PAGE);

    await expect(updatePage(TOKENS, "p1", { appendContent: md })).resolves.toMatchObject({
      id: "p1",
    });
  });

  it("omits `after` entirely when no anchor is given", async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonRes({ results: [{ id: "n" }] }))
      .mockResolvedValueOnce(FINAL_PAGE);

    await updatePage(TOKENS, "p1", { appendContent: "text" });

    const append = fetchSpy.mock.calls.find(
      (c) => methodOf(c) === "PATCH" && urlOf(c).includes("/children")
    )!;
    expect(bodyOf(append)).not.toHaveProperty("after");
  });
});

describe("rate-limit backoff (NWRITE-07)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries a 429 and honors Retry-After", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        jsonRes({ message: "rate limited" }, { ok: false, status: 429, retryAfter: "2" })
      )
      .mockResolvedValueOnce(jsonRes({ id: "p1", url: "u" }));

    const promise = updatePage(TOKENS, "p1", { archive: true });
    await vi.advanceTimersByTimeAsync(2000);
    await expect(promise).resolves.toMatchObject({ id: "p1" });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("retries a 529 service overload", async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonRes({ message: "overloaded" }, { ok: false, status: 529 }))
      .mockResolvedValueOnce(jsonRes({ id: "p1", url: "u" }));

    const promise = updatePage(TOKENS, "p1", { archive: true });
    await vi.advanceTimersByTimeAsync(5000);
    await expect(promise).resolves.toMatchObject({ id: "p1" });
  });

  it("does NOT retry a 400 — it throws on the first response", async () => {
    fetchSpy.mockResolvedValueOnce(jsonRes({ message: "bad request" }, { ok: false, status: 400 }));

    await expect(updatePage(TOKENS, "p1", { archive: true })).rejects.toThrow(/400.*bad request/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("gives up after exhausting the retry budget", async () => {
    fetchSpy.mockResolvedValue(
      jsonRes({ message: "rate limited" }, { ok: false, status: 429, retryAfter: "1" })
    );

    const promise = updatePage(TOKENS, "p1", { archive: true });
    const assertion = expect(promise).rejects.toThrow(/429/);
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
  });
});
