import { describe, it, expect } from "vitest";
import { inferJsonSchema } from "@/connectors/api/lib/infer-schema";

describe("inferJsonSchema", () => {
  it("null → {type:'null'}", () => {
    expect(inferJsonSchema(null)).toEqual({ type: "null" });
  });

  it("boolean → {type:'boolean'}", () => {
    expect(inferJsonSchema(true)).toEqual({ type: "boolean" });
    expect(inferJsonSchema(false)).toEqual({ type: "boolean" });
  });

  it("number → {type:'number'}", () => {
    expect(inferJsonSchema(42)).toEqual({ type: "number" });
    expect(inferJsonSchema(3.14)).toEqual({ type: "number" });
  });

  it("string → {type:'string'}", () => {
    expect(inferJsonSchema("hello")).toEqual({ type: "string" });
    expect(inferJsonSchema("")).toEqual({ type: "string" });
  });

  it("empty array → {type:'array', items:{}}", () => {
    expect(inferJsonSchema([])).toEqual({ type: "array", items: {} });
  });

  it("homogeneous array [1,2,3] → {type:'array', items:{type:'number'}}", () => {
    expect(inferJsonSchema([1, 2, 3])).toEqual({
      type: "array",
      items: { type: "number" },
    });
  });

  it("heterogeneous array [1,'a'] → {type:'array', items:{anyOf:[{type:'number'},{type:'string'}]}}", () => {
    expect(inferJsonSchema([1, "a"])).toEqual({
      type: "array",
      items: {
        anyOf: [{ type: "number" }, { type: "string" }],
      },
    });
  });

  it("nested object {a:1, b:{c:'x'}} → correct nested schema with required keys", () => {
    expect(inferJsonSchema({ a: 1, b: { c: "x" } })).toEqual({
      type: "object",
      properties: {
        a: { type: "number" },
        b: {
          type: "object",
          properties: {
            c: { type: "string" },
          },
          required: ["c"],
        },
      },
      required: ["a", "b"],
    });
  });
});
