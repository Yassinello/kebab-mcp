/**
 * createPage / detectParentType — parent can be a PAGE or a DATABASE.
 *
 * Notion's POST /pages needs parent:{page_id} vs {database_id}. createPage
 * auto-detects when parentType is omitted (GET /pages/<id>, then /databases),
 * or honors an explicit override without probing. These tests assert the
 * request shape (parent form + markdown-built children) and the probe order.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPage, detectParentType } from "../notion-api";

const TOKENS = { NOTION_API_KEY: "ntn-test" };

function jsonRes(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
    statusText: ok ? "OK" : "Not Found",
  } as Response;
}

function bodyOf(call: unknown[]): Record<string, unknown> {
  const init = call[1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

function urlOf(call: unknown[]): string {
  return call[0] as string;
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn();
  global.fetch = fetchSpy as unknown as typeof fetch;
});

describe("detectParentType", () => {
  it("returns 'page' when GET /pages/<id> succeeds", async () => {
    fetchSpy.mockResolvedValueOnce(jsonRes({ id: "x", object: "page" }));
    expect(await detectParentType(TOKENS, "x")).toBe("page");
    expect(urlOf(fetchSpy.mock.calls[0]!)).toContain("/pages/x");
  });

  it("falls back to 'database' when the page probe 404s but the db probe succeeds", async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonRes({ message: "not found" }, false, 404))
      .mockResolvedValueOnce(jsonRes({ id: "x", object: "database" }));
    expect(await detectParentType(TOKENS, "x")).toBe("database");
    expect(urlOf(fetchSpy.mock.calls[0]!)).toContain("/pages/x");
    expect(urlOf(fetchSpy.mock.calls[1]!)).toContain("/databases/x");
  });

  it("throws a clear error when both probes 404", async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonRes({ message: "nf" }, false, 404))
      .mockResolvedValueOnce(jsonRes({ message: "nf" }, false, 404));
    await expect(detectParentType(TOKENS, "x")).rejects.toThrow(/neither a page nor a database/);
  });
});

describe("createPage", () => {
  it("auto-detects a PAGE parent → parent:{page_id}, with markdown children", async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonRes({ id: "parent", object: "page" })) // detect: page
      .mockResolvedValueOnce(jsonRes({ id: "new", url: "https://notion.so/new" })); // create

    await createPage(TOKENS, { parentId: "parent", title: "Sub", content: "# Hi\n\n- a" });

    const create = fetchSpy.mock.calls[1]!;
    expect(urlOf(create)).toContain("/pages");
    const body = bodyOf(create);
    expect(body.parent).toEqual({ page_id: "parent" });
    expect(
      (body.properties as { title: { title: { text: { content: string } }[] } }).title.title[0]!
        .text.content
    ).toBe("Sub");
    const children = body.children as { type: string }[];
    expect(children.map((c) => c.type)).toEqual(["heading_1", "bulleted_list_item"]);
  });

  it("honors an explicit parentType='database' WITHOUT probing", async () => {
    fetchSpy.mockResolvedValueOnce(jsonRes({ id: "new", url: "https://notion.so/new" }));

    await createPage(TOKENS, { parentId: "db1", title: "Row", parentType: "database" });

    // Only one call — no detect probe.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = bodyOf(fetchSpy.mock.calls[0]!);
    expect(body.parent).toEqual({ database_id: "db1" });
  });

  it("no content → empty children array", async () => {
    fetchSpy.mockResolvedValueOnce(jsonRes({ id: "new", url: "u" }));
    await createPage(TOKENS, { parentId: "db1", title: "T", parentType: "database" });
    expect(bodyOf(fetchSpy.mock.calls[0]!).children).toEqual([]);
  });
});
