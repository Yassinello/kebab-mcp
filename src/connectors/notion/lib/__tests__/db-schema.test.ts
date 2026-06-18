/**
 * getDatabaseSchema — introspect a Notion database's properties.
 * Extracts name + type for every property, plus option names for
 * select/multi_select/status. Runs against a mocked fetch.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getDatabaseSchema } from "../notion-api";

const TOKENS = { NOTION_API_KEY: "ntn-test" };

function jsonRes(body: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as Response;
}

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn();
  global.fetch = fetchSpy as unknown as typeof fetch;
});

describe("getDatabaseSchema", () => {
  it("returns the title and each property's name + type", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonRes({
        title: [{ plain_text: "Deals" }],
        properties: {
          Name: { type: "title" },
          Notes: { type: "rich_text" },
          Amount: { type: "number" },
          Closed: { type: "checkbox" },
          Due: { type: "date" },
        },
      })
    );

    const schema = await getDatabaseSchema(TOKENS, "db1");
    expect(schema.title).toBe("Deals");
    expect(schema.properties).toEqual([
      { name: "Name", type: "title" },
      { name: "Notes", type: "rich_text" },
      { name: "Amount", type: "number" },
      { name: "Closed", type: "checkbox" },
      { name: "Due", type: "date" },
    ]);
    expect(fetchSpy.mock.calls[0]![0]).toContain("/databases/db1");
  });

  it("extracts option names for select / multi_select / status", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonRes({
        title: [{ plain_text: "Tasks" }],
        properties: {
          Stage: { type: "select", select: { options: [{ name: "Todo" }, { name: "Done" }] } },
          Tags: {
            type: "multi_select",
            multi_select: { options: [{ name: "urgent" }, { name: "later" }] },
          },
          Status: {
            type: "status",
            status: { options: [{ name: "Not started" }, { name: "In progress" }] },
          },
        },
      })
    );

    const schema = await getDatabaseSchema(TOKENS, "db2");
    const byName = Object.fromEntries(schema.properties.map((p) => [p.name, p]));
    expect(byName.Stage!.options).toEqual(["Todo", "Done"]);
    expect(byName.Tags!.options).toEqual(["urgent", "later"]);
    expect(byName.Status!.options).toEqual(["Not started", "In progress"]);
  });

  it("falls back to a placeholder title when none is set", async () => {
    fetchSpy.mockResolvedValueOnce(jsonRes({ properties: {} }));
    const schema = await getDatabaseSchema(TOKENS, "db3");
    expect(schema.title).toBe("(untitled database)");
    expect(schema.properties).toEqual([]);
  });
});
