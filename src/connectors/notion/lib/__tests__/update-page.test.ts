/**
 * buildPropertyValue + updatePage — typed property updates.
 *
 * buildPropertyValue maps a value to Notion's per-type property shape (the
 * thing that makes select/date/status actually accept the update).
 * updatePage fetches the parent DB schema to type each property, supports
 * the special "title" key, and archives via PATCH { archived: true }.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildPropertyValue, updatePage } from "../notion-api";

const TOKENS = { NOTION_API_KEY: "ntn-test" };

function jsonRes(body: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as Response;
}
function bodyOf(call: unknown[]): Record<string, unknown> {
  return JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>;
}
function urlOf(call: unknown[]): string {
  return call[0] as string;
}

describe("buildPropertyValue", () => {
  it("maps each type to its Notion shape", () => {
    expect(buildPropertyValue("title", "T")).toEqual({
      title: [{ type: "text", text: { content: "T" } }],
    });
    expect(buildPropertyValue("rich_text", "x")).toEqual({
      rich_text: [{ type: "text", text: { content: "x" } }],
    });
    expect(buildPropertyValue("number", 5)).toEqual({ number: 5 });
    expect(buildPropertyValue("number", "7")).toEqual({ number: 7 });
    expect(buildPropertyValue("checkbox", true)).toEqual({ checkbox: true });
    expect(buildPropertyValue("select", "Done")).toEqual({ select: { name: "Done" } });
    expect(buildPropertyValue("status", "In progress")).toEqual({
      status: { name: "In progress" },
    });
    expect(buildPropertyValue("date", "2026-07-01")).toEqual({ date: { start: "2026-07-01" } });
    expect(buildPropertyValue("url", "https://x")).toEqual({ url: "https://x" });
    expect(buildPropertyValue("email", "a@b.c")).toEqual({ email: "a@b.c" });
  });

  it("splits multi_select and people on commas", () => {
    expect(buildPropertyValue("multi_select", "urgent, q3")).toEqual({
      multi_select: [{ name: "urgent" }, { name: "q3" }],
    });
    expect(buildPropertyValue("people", "U1, U2")).toEqual({
      people: [{ id: "U1" }, { id: "U2" }],
    });
  });

  it("falls back to rich_text for unknown types", () => {
    expect(buildPropertyValue("mystery", "v")).toEqual({
      rich_text: [{ type: "text", text: { content: "v" } }],
    });
  });
});

describe("updatePage", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
  });

  it("types properties from the parent database schema", async () => {
    fetchSpy
      // 1) GET /pages/<id> → parent is a database
      .mockResolvedValueOnce(jsonRes({ parent: { type: "database_id", database_id: "db1" } }))
      // 2) GET /databases/db1 → schema
      .mockResolvedValueOnce(
        jsonRes({
          title: [{ plain_text: "Tasks" }],
          properties: {
            Status: { type: "status", status: { options: [{ name: "Done" }] } },
            Due: { type: "date" },
          },
        })
      )
      // 3) PATCH /pages/<id> → properties
      .mockResolvedValueOnce(jsonRes({ id: "p1", url: "u" }))
      // 4) GET /pages/<id> → final return
      .mockResolvedValueOnce(jsonRes({ id: "p1", url: "https://notion.so/p1" }));

    await updatePage(TOKENS, "p1", { Status: "Done", Due: "2026-07-01" });

    const patch = fetchSpy.mock.calls.find(
      (c) => (c[1] as RequestInit).method === "PATCH" && urlOf(c).includes("/pages/")
    )!;
    const props = bodyOf(patch).properties as Record<string, unknown>;
    expect(props.Status).toEqual({ status: { name: "Done" } });
    expect(props.Due).toEqual({ date: { start: "2026-07-01" } });
  });

  it("uses the 'title' key to rename even without a DB schema (page parent)", async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonRes({ parent: { type: "page_id", page_id: "parent" } })) // no DB
      .mockResolvedValueOnce(jsonRes({ id: "p1", url: "u" })) // PATCH props
      .mockResolvedValueOnce(jsonRes({ id: "p1", url: "https://notion.so/p1" })); // final GET

    await updatePage(TOKENS, "p1", { title: "Renamed" });

    const patch = fetchSpy.mock.calls.find((c) => (c[1] as RequestInit).method === "PATCH")!;
    const props = bodyOf(patch).properties as Record<string, unknown>;
    expect(props.title).toEqual({ title: [{ type: "text", text: { content: "Renamed" } }] });
  });

  it("archives the page and returns early (single PATCH { archived: true })", async () => {
    fetchSpy.mockResolvedValueOnce(jsonRes({ id: "p1", url: "https://notion.so/p1" }));

    await updatePage(TOKENS, "p1", undefined, undefined, true);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0]!;
    expect((call[1] as RequestInit).method).toBe("PATCH");
    expect(bodyOf(call)).toEqual({ archived: true });
  });
});
