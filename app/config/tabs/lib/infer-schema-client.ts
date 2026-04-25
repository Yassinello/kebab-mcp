/**
 * Client-side JSON Schema inferrer for the custom-tool-builder wizard.
 *
 * Intentional duplication of src/connectors/api/lib/infer-schema.ts —
 * avoids a server/client boundary on a shared lib file and keeps the
 * client bundle free of server-only imports.
 *
 * Design constraints (identical to server version):
 * - No external dependencies — pure TypeScript
 * - No enum inference — single-sample is insufficient evidence
 * - No format:date-time — strings stay as {type:"string"}
 * - Single-sample objects → all keys required (user can edit in UI)
 * - Heterogeneous arrays → anyOf with deduplication
 */

type JsonSchema = Record<string, unknown>;

function deduplicateSchemas(schemas: JsonSchema[]): JsonSchema[] {
  const seen = new Set<string>();
  const out: JsonSchema[] = [];
  for (const s of schemas) {
    const key = JSON.stringify(s);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(s);
    }
  }
  return out;
}

/**
 * Infer a JSON Schema from a single runtime value.
 *
 * @param value - Any JSON-deserializable value (parsed from an API response).
 * @returns A JSON Schema object describing the shape of `value`.
 */
export function inferJsonSchema(value: unknown): JsonSchema {
  if (value === null) {
    return { type: "null" };
  }

  if (typeof value === "boolean") {
    return { type: "boolean" };
  }

  if (typeof value === "number") {
    return { type: "number" };
  }

  if (typeof value === "string") {
    return { type: "string" };
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return { type: "array", items: {} };
    }

    const itemSchemas = value.map((item) => inferJsonSchema(item));
    const deduped = deduplicateSchemas(itemSchemas);

    if (deduped.length === 1) {
      return { type: "array", items: deduped[0] };
    }

    return { type: "array", items: { anyOf: deduped } };
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    const properties: Record<string, JsonSchema> = {};

    for (const key of keys) {
      properties[key] = inferJsonSchema(obj[key]);
    }

    return {
      type: "object",
      properties,
      required: keys,
    };
  }

  // Fallback for undefined or unknown types — treat as opaque
  return {};
}
