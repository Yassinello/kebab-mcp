import { z } from "zod";

// ── Zod shape → simple field descriptors ──────────────────────────────

export interface FieldDescriptor {
  name: string;
  type: "string" | "number" | "boolean" | "enum" | "unknown";
  description: string;
  required: boolean;
  enumValues?: string[];
  default?: unknown;
}

/**
 * Q-02 (2026-11 audit): derived from Zod's public `z.toJSONSchema()`
 * instead of walking the private `_zod.def` internals, which change across
 * Zod releases. `io: "input"` makes defaulted fields optional, matching
 * what a caller has to provide.
 */
export function zodShapeToFields(shape: z.ZodRawShape): FieldDescriptor[] {
  const json = z.toJSONSchema(z.object(shape), { io: "input", unrepresentable: "any" }) as {
    properties?: Record<string, Record<string, unknown>>;
    required?: string[];
  };
  const required = new Set(json.required ?? []);
  return Object.keys(shape).map((name) =>
    describeProperty(name, json.properties?.[name] ?? {}, required.has(name))
  );
}

function describeProperty(
  name: string,
  prop: Record<string, unknown>,
  required: boolean
): FieldDescriptor {
  const description = typeof prop.description === "string" ? prop.description : "";
  const base = { name, description, required, default: prop.default };
  const enumValues = Array.isArray(prop.enum)
    ? prop.enum
    : prop.const !== undefined
      ? [prop.const]
      : null;
  if (enumValues && enumValues.every((v): v is string => typeof v === "string")) {
    return { ...base, type: "enum", enumValues };
  }
  switch (prop.type) {
    case "string":
      return { ...base, type: "string" };
    case "number":
    case "integer":
      return { ...base, type: "number" };
    case "boolean":
      return { ...base, type: "boolean" };
    default:
      return { ...base, type: "unknown" };
  }
}
