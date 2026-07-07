import { describe, it, expect } from "vitest";
import { airtableConnector } from "./manifest";

describe("airtableConnector manifest", () => {
  it("registers all 9 tools with correct names", () => {
    const names = airtableConnector.tools.map((t) => t.name);
    expect(names).toContain("airtable_list_bases");
    expect(names).toContain("airtable_list_tables");
    expect(names).toContain("airtable_list_records");
    expect(names).toContain("airtable_get_record");
    expect(names).toContain("airtable_create_record");
    expect(names).toContain("airtable_update_record");
    expect(names).toContain("airtable_search_records");
    expect(names).toContain("airtable_list_comments");
    expect(names).toContain("airtable_create_comment");
    expect(names).toHaveLength(9);
  });

  it("marks exactly 3 write tools as destructive", () => {
    const destructiveTools = airtableConnector.tools
      .filter((t) => t.destructive)
      .map((t) => t.name);
    expect(destructiveTools).toContain("airtable_create_record");
    expect(destructiveTools).toContain("airtable_update_record");
    expect(destructiveTools).toContain("airtable_create_comment");
    expect(destructiveTools).toHaveLength(3);
  });

  it("does not mark read tools as destructive", () => {
    const readToolNames = [
      "airtable_list_bases",
      "airtable_list_tables",
      "airtable_list_records",
      "airtable_get_record",
      "airtable_search_records",
      "airtable_list_comments",
    ];
    for (const name of readToolNames) {
      const tool = airtableConnector.tools.find((t) => t.name === name);
      expect(tool?.destructive).toBeFalsy();
    }
  });

  it("requires AIRTABLE_API_KEY env var", () => {
    expect(airtableConnector.requiredEnvVars).toContain("AIRTABLE_API_KEY");
  });

  it("has id 'airtable'", () => {
    expect(airtableConnector.id).toBe("airtable");
  });
});
