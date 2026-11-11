import { describe, it, expect } from "vitest";
import { z } from "zod";
import { zodShapeToFields } from "./zod-fields";

describe("zodShapeToFields (Q-02: public z.toJSONSchema)", () => {
  it("maps primitives, optionals, defaults, enums and descriptions", () => {
    const fields = zodShapeToFields({
      q: z.string().describe("Query"),
      limit: z.number().int().optional(),
      page: z.number().default(1),
      flag: z.boolean(),
      mode: z.enum(["a", "b"]),
      lit: z.literal("x"),
      obj: z.record(z.string(), z.unknown()),
    });
    const by = Object.fromEntries(fields.map((f) => [f.name, f]));
    expect(by.q).toMatchObject({ type: "string", required: true, description: "Query" });
    expect(by.limit).toMatchObject({ type: "number", required: false });
    expect(by.page).toMatchObject({ type: "number", required: false, default: 1 });
    expect(by.flag).toMatchObject({ type: "boolean", required: true });
    expect(by.mode).toMatchObject({ type: "enum", enumValues: ["a", "b"] });
    expect(by.lit).toMatchObject({ type: "enum", enumValues: ["x"] });
    expect(by.obj?.type).toBe("unknown");
    expect(fields.map((f) => f.name)).toEqual(["q", "limit", "page", "flag", "mode", "lit", "obj"]);
  });
});
